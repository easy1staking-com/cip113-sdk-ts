/**
 * Ledger ordering and the redeemer indices that depend on it (T-D04).
 *
 * These indices are the highest-risk values this SDK computes. An index is a
 * plain integer: a wrong one typechecks, encodes, builds, balances, and fails
 * ONLY when the ledger runs the script. There is no type, no hash assertion and
 * no build step anywhere in this repository that can see it.
 *
 * The withdrawal ordering is the trap. The bytes suggest one answer and the
 * script sees the other:
 *
 *   - A reward account serialises as a header byte plus the credential hash,
 *     with key-stake = 0xE0|network and script-stake = 0xF0|network. Sorting
 *     the ENCODED addresses therefore puts KEY credentials first.
 *   - But the map the script receives is ordered by cardano-ledger's derived
 *     `Ord` on `Credential`, whose constructors are declared
 *     `ScriptHashObj | KeyHashObj`. A derived Ord compares constructor position
 *     first, so SCRIPT credentials come first.
 *
 * The two disagree exactly when both kinds are present — which is the common
 * case as soon as a wallet adds a reward withdrawal during balancing. The test
 * below pins the direction so a "fix" toward the wire format goes red.
 *
 * ⛔ alpha.3 ADDS A SECOND, WORSE TRAP IN THE SAME FILE. BaseSpendRedeemer went
 * from a three-constructor ENUM to a single-constructor RECORD, and
 * `SpendViaTransfer(a, b)` encodes IDENTICALLY to `BaseSpendRedeemer{a, b}` —
 * so a stale builder's bytes decode cleanly and fail only later, on a
 * credential-equality check, because `wdrl_idx` now indexes the DISPATCHER's
 * withdrawal rather than the delegate's. The other two variants (constructors 1
 * and 2) fail loudly, so the silence is asymmetric and lands on the transfer
 * path — the common one.
 *
 * That is demonstrated below rather than asserted: one test encodes both shapes
 * and shows the bytes are equal. The guards that follow exist because no
 * decoder can distinguish them, so the only place a stale call can be caught is
 * the API surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  compareTxInputs,
  referenceInputIndexOf,
  compareWithdrawalKeys,
  sortWithdrawalKeys,
  withdrawalIndexOf,
  baseSpendRedeemer,
  transferRedeemer,
  thirdPartyRedeemer,
  unfrackingRedeemer,
  programmableLogicGlobalRedeemer,
  plbWithdrawalPlan,
  issuancePlan,
} from "../dist/core/ledger-order.js";
import { sortTxInputs } from "../dist/core/registry.js";
import {
  issuanceRedeemer,
  issuanceLogicRedeemer,
  mintingProofRefInput,
  mintingProofOutputIndex,
} from "../dist/core/evo-utils.js";

const S = (h) => ({ hash: h, isScript: true });
const K = (h) => ({ hash: h, isScript: false });
const hex = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);

// ---------------------------------------------------------------------------
// Reference inputs
// ---------------------------------------------------------------------------

test("reference inputs sort by tx id, then output index", () => {
  const a = { txHash: "aa".repeat(32), outputIndex: 3 };
  const b = { txHash: "aa".repeat(32), outputIndex: 0 };
  const c = { txHash: "0f".repeat(32), outputIndex: 9 };

  const sorted = sortTxInputs([a, b, c]);
  assert.deepEqual(sorted, [c, b, a], "id first (bytewise), then index numerically");
});

test("output index sorts NUMERICALLY, not as a string", () => {
  // The bug this pins: "10" < "9" as strings, but 10 > 9 as numbers. A
  // transaction with more than ten outputs from one parent would be misordered.
  const inputs = [
    { txHash: "ab".repeat(32), outputIndex: 10 },
    { txHash: "ab".repeat(32), outputIndex: 9 },
    { txHash: "ab".repeat(32), outputIndex: 2 },
  ];
  assert.deepEqual(
    sortTxInputs(inputs).map((i) => i.outputIndex),
    [2, 9, 10]
  );
});

test("tx ids compare as bytes", () => {
  const lo = { txHash: "0a".repeat(32), outputIndex: 0 };
  const hi = { txHash: "f0".repeat(32), outputIndex: 0 };
  assert.ok(compareTxInputs(lo, hi) < 0);
  assert.ok(compareTxInputs(hi, lo) > 0);
  assert.equal(compareTxInputs(lo, { ...lo }), 0);
});

test("hex case is PRESENTATION — the same bytes must compare equal", () => {
  // The live defect in the previous implementation. A transaction id is bytes;
  // hex case carries no information, and providers differ on which they return.
  // The old code compared raw strings with localeCompare, so an uppercase hash
  // and its lowercase twin were neither equal nor consistently ordered:
  // localeCompare puts "0a" BEFORE "0A", while the bytes put it after. Two
  // spellings of one reference input then land in different positions, and
  // findRefInputIndex's === could miss the match entirely.
  const lower = { txHash: "ab".repeat(32), outputIndex: 0 };
  const upper = { txHash: "AB".repeat(32), outputIndex: 0 };
  assert.equal(compareTxInputs(lower, upper), 0, "same bytes, different spelling");

  // And ordering must follow the bytes regardless of spelling.
  const bigUpper = { txHash: "FF".repeat(32), outputIndex: 0 };
  assert.ok(compareTxInputs(lower, bigUpper) < 0, "ab < ff regardless of case");

  // Same rule for withdrawal credentials.
  assert.equal(compareWithdrawalKeys(S("ab".repeat(28)), S("AB".repeat(28))), 0);
  assert.equal(withdrawalIndexOf([S("AB".repeat(28))], S("ab".repeat(28))), 0);
});

test("referenceInputIndexOf sorts internally — an unsorted list is not a footgun", () => {
  const params = { txHash: "77".repeat(32), outputIndex: 1 };
  const others = [
    { txHash: "ff".repeat(32), outputIndex: 0 },
    { txHash: "11".repeat(32), outputIndex: 5 },
  ];
  // Deliberately passed out of order.
  assert.equal(referenceInputIndexOf([others[0], params, others[1]], params), 1);
});

test("a reference input that is not in the set THROWS rather than returning -1", () => {
  assert.throws(
    () =>
      referenceInputIndexOf(
        [{ txHash: "11".repeat(32), outputIndex: 0 }],
        { txHash: "22".repeat(32), outputIndex: 0 }
      ),
    /is not in the reference-input set/,
    "-1 encodes as a perfectly valid integer and fails obscurely on chain"
  );
});

// ---------------------------------------------------------------------------
// Withdrawals — the trap
// ---------------------------------------------------------------------------

test("EVERY script credential sorts before EVERY key credential", () => {
  // Note the hashes: the key credential's hash is bytewise SMALLER than the
  // script's. If the implementation ever sorts by hash first, or by the
  // serialised reward address, this goes red — which is the whole point.
  const keyLow = K("00".repeat(28));
  const scriptHigh = S("ff".repeat(28));

  assert.ok(
    compareWithdrawalKeys(scriptHigh, keyLow) < 0,
    "script before key, even when the script's hash is bytewise larger"
  );
  assert.deepEqual(sortWithdrawalKeys([keyLow, scriptHigh]), [scriptHigh, keyLow]);
});

test("within a kind, credentials sort bytewise by hash", () => {
  const s1 = S("01".repeat(28));
  const s2 = S("02".repeat(28));
  const k1 = K("01".repeat(28));
  const k2 = K("02".repeat(28));
  assert.deepEqual(sortWithdrawalKeys([k2, s2, k1, s1]), [s1, s2, k1, k2]);
});

test("wdrl_idx over a MIXED set — the case a wallet creates during balancing", () => {
  // Two substandard scripts, the core transfer validator, and a key-hash reward
  // withdrawal the wallet added. The core validator's slot is what PLB checks.
  const coreTransfer = S("cc".repeat(28));
  const all = [
    K("00".repeat(28)),        // wallet reward withdrawal — sorts LAST despite 0x00
    S("aa".repeat(28)),        // a substandard's transfer logic
    coreTransfer,
    S("bb".repeat(28)),        // another substandard
  ];
  // Sorted: aa, bb, cc (scripts, bytewise) then the key. So core is at 2.
  assert.equal(withdrawalIndexOf(all, coreTransfer), 2);

  // Remove the wallet's withdrawal: the scripts keep their positions, because
  // the key sorted after them. Position is stable here — but see the next test.
  assert.equal(withdrawalIndexOf(all.filter((w) => w.isScript), coreTransfer), 2);
});

test("an added SCRIPT withdrawal shifts every position after it", () => {
  const core = S("cc".repeat(28));
  assert.equal(withdrawalIndexOf([S("aa".repeat(28)), core], core), 1);
  // A second substandard whose hash sorts before the core validator pushes it along.
  assert.equal(
    withdrawalIndexOf([S("aa".repeat(28)), S("bb".repeat(28)), core], core),
    2,
    "compute wdrl_idx over the FINAL withdrawal set, after the builder has added everything"
  );
});

test("a withdrawal that is not in the set THROWS", () => {
  assert.throws(
    () => withdrawalIndexOf([S("aa".repeat(28))], S("bb".repeat(28))),
    /is not in the withdrawal set/
  );
});

test("script and key credentials with the SAME hash are different entries", () => {
  const h = "ab".repeat(28);
  assert.notEqual(compareWithdrawalKeys(S(h), K(h)), 0);
  assert.equal(withdrawalIndexOf([S(h), K(h)], K(h)), 1);
});

// ---------------------------------------------------------------------------
// Redeemers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⛔ THE SILENT REDEEMER CHANGE — the most dangerous edge in the alpha.3 migration
// ---------------------------------------------------------------------------

test("⛔ DEMONSTRATION: a stale SpendViaTransfer is byte-identical to the new record", () => {
  // This is why the change is dangerous, stated as a measurement rather than a
  // warning. alpha.2's BaseSpendRedeemer was an ENUM; alpha.3's is a RECORD.
  //
  //   SpendViaTransfer(7, 3)      = Constr(0, [Int 7, Int 3])
  //   BaseSpendRedeemer{7, 3}     = Constr(0, [Int 7, Int 3])
  //
  // A stale builder's bytes DECODE CLEANLY as the new type. Nothing rejects
  // them. The transaction fails later, on a credential-equality check, because
  // alpha.2's wdrl_idx pointed at the DELEGATE's withdrawal and alpha.3's must
  // point at the DISPATCHER's.
  const staleSpendViaTransfer = Data.constr(0n, [Data.int(7n), Data.int(3n)]);
  const fresh = baseSpendRedeemer(7, 3);

  assert.equal(
    hex(Data.toCBORBytes(fresh)),
    hex(Data.toCBORBytes(staleSpendViaTransfer)),
    "identical bytes — this is the trap, not a bug in the test",
  );

  // ⚑ And the asymmetry is the reason it is worth a demonstration: the OTHER
  // two stale variants carry constructors 1 and 2, which the new single-
  // constructor type cannot represent. They fail loudly. Only the transfer
  // path — the common one — is silent.
  const staleThirdParty = Data.constr(1n, [Data.int(7n), Data.int(3n)]);
  assert.notEqual(staleThirdParty.index, fresh.index, "ctor 1 cannot be mistaken for the record");
});

test("baseSpendRedeemer is a single-constructor record with (params_idx, wdrl_idx)", () => {
  const r = baseSpendRedeemer(7, 3);
  assert.equal(r.index, 0n, "one constructor now, not three");
  assert.deepEqual(r.fields, [7n, 3n], "params_idx at 0, wdrl_idx at 1");
});

test("baseSpendRedeemer REJECTS a stale variant argument, and says why", () => {
  // The failing-first case. A caller still on the alpha.2 signature passes the
  // variant FIRST. Verify it fails for the RIGHT REASON — a stale redeemer
  // rejected — not merely that it fails: "params_idx must be an integer" would
  // be true and would send the reader to audit their index arithmetic.
  assert.throws(
    () => baseSpendRedeemer("TRANSFER", 0, 1),
    (err) => {
      assert.match(err.message, /no longer takes a dispatch variant/);
      assert.match(err.message, /programmableLogicGlobalRedeemer\("TRANSFER"\)/,
        "must point at where the variant went");
      assert.match(err.message, /wdrl_idx ALSO changed meaning/,
        "must warn that fixing the call is not enough — the index target moved");
      return true;
    },
  );
});

test("baseSpendRedeemer rejects negative and non-integer indices", () => {
  for (const bad of [-1, 1.5, NaN]) {
    assert.throws(() => baseSpendRedeemer(bad, 0), /params_idx/);
    assert.throws(() => baseSpendRedeemer(0, bad), /wdrl_idx/);
  }
});

test("the dispatch variants moved to the dispatcher, field-less", () => {
  for (const [name, idx] of [["TRANSFER", 0n], ["THIRD_PARTY", 1n], ["UNFRACKING", 2n]]) {
    const r = programmableLogicGlobalRedeemer(name);
    assert.equal(r.index, idx, `${name} keeps its alpha.2 constructor index`);
    assert.deepEqual(r.fields, [], "field-less — the index is the whole payload");
  }
  assert.throws(() => programmableLogicGlobalRedeemer("NOPE"), /unknown act/);
});

test("TransferRedeemer is proofs ONLY — params_idx is gone", () => {
  const r = transferRedeemer([{ type: "exists", nodeIdx: 2 }]);
  assert.equal(r.index, 0n);
  assert.equal(r.fields.length, 1, "one field: the proof list");
  assert.equal(r.fields[0].length, 1);
  assert.equal(r.fields[0][0].index, 0n, "exists = constructor 0");
  assert.equal(r.fields[0][0].fields[0], 2n);

  // A stale two-argument call puts an Int where the list belongs.
  assert.throws(() => transferRedeemer(4, [{ type: "exists", nodeIdx: 2 }]),
    /takes only the proof list now/);
});

test("proof constructors distinguish exists from not-exists", () => {
  const r = transferRedeemer([
    { type: "exists", nodeIdx: 1 },
    { type: "not-exists", nodeIdx: 5 },
  ]);
  assert.deepEqual(r.fields[0].map((p) => p.index), [0n, 1n]);
});

test("⛔ ThirdParty/Unfracking redeemers REFUSE a stale 3-argument call", () => {
  // The silent one. alpha.3 dropped the FIRST of three ints, so a stale call
  // shifts both surviving values one slot left and encodes CLEANLY:
  //   (params_idx, registry_node_idx, outputs_start_idx)
  //     -> { registry_node_idx: params_idx, outputs_start_idx: registry_node_idx }
  // Well-formed, two wrong values, no complaint anywhere. Only arity catches it.
  for (const fn of [thirdPartyRedeemer, unfrackingRedeemer]) {
    assert.deepEqual(fn(2, 3).fields, [2n, 3n], "registry_node_idx, outputs_start_idx");
    assert.throws(() => fn(1, 2, 3), /TWO arguments/, `${fn.name} must refuse the stale arity`);
  }
});

test("encoded redeemers differ when indices are transposed", () => {
  assert.notEqual(
    hex(Data.toCBORBytes(baseSpendRedeemer(7, 3))),
    hex(Data.toCBORBytes(baseSpendRedeemer(3, 7)))
  );
});

// ---------------------------------------------------------------------------
// The withdrawal plan — the dispatcher must be structurally unforgettable
// ---------------------------------------------------------------------------

test("plbWithdrawalPlan includes the dispatcher and indexes over the complete set", () => {
  const PLG = "aa".repeat(28);
  const DELEGATE = "bb".repeat(28);
  const OTHER = "00".repeat(28);

  const plan = plbWithdrawalPlan({
    plgHash: PLG,
    others: [
      { hash: DELEGATE, isScript: true },
      { hash: OTHER, isScript: true },
    ],
  });

  assert.equal(plan.all.length, 3, "the dispatcher is part of the set, not beside it");

  // Ledger order is bytewise among script credentials: 00 < aa < bb.
  assert.equal(plan.indexOf({ hash: OTHER, isScript: true }), 0);
  assert.equal(plan.plgIdx, 1, "the dispatcher's own slot");
  assert.equal(plan.indexOf({ hash: DELEGATE, isScript: true }), 2);

  // ⚑ THE POINT: computing the index WITHOUT the dispatcher gives a different
  // answer, and that answer is silently wrong on chain.
  assert.notEqual(
    withdrawalIndexOf(
      [{ hash: DELEGATE, isScript: true }, { hash: OTHER, isScript: true }],
      { hash: DELEGATE, isScript: true },
    ),
    plan.indexOf({ hash: DELEGATE, isScript: true }),
    "omitting the dispatcher shifts every later index — the failure this API prevents",
  );
});

test("plbWithdrawalPlan refuses a duplicated credential", () => {
  const H = "cc".repeat(28);
  assert.throws(
    () => plbWithdrawalPlan({ plgHash: H, others: [{ hash: H, isScript: true }] }),
    /duplicate withdrawal credential/,
  );
});

// ---------------------------------------------------------------------------
// The issuance plan — one object owns the withdrawals, the reference inputs
// and the outputs of a transaction that mints or burns (T-F04)
// ---------------------------------------------------------------------------
//
// alpha.4 split issuance (upstream #129). `issuance_mint`'s redeemer became
// `IssuanceRedeemer { params_idx }`, and the registry proof travels as a VALUE
// inside `issuance_logic`'s withdraw-0 map, keyed by policy id. That turns one
// index into three interdependent sets, and every one of them is a plain
// integer that typechecks, encodes, balances and fails only on chain.
//
// ⚠ EXPECTED INDICES BELOW ARE HAND-DERIVED LITERALS, with the derivation in a
// comment beside each. Comparing `plan.withdrawalIndexOf(x)` against
// `withdrawalIndexOf(plan.withdrawals, x)` would be a tautology: both descend
// from the same sort, so the comparison can never fail (harness §9a-ii, sixth
// form — the COMMON ANCESTOR).

// Withdrawal credentials. All four are SCRIPT credentials, so script-before-key
// never bites and the ordering below is purely bytewise.
const ISSUANCE_LOGIC = "11".repeat(28);
const PLG_HASH = "aa".repeat(28);
const ISSUER_ADMIN = "bb".repeat(28);
const THIRD_PARTY_H = "cc".repeat(28);

const TX = (b, i) => ({ txHash: b.repeat(32), outputIndex: i });

// The "calm" reference-input fixture. Deliberately built so that dropping the
// LAST CONSTRUCTED entry moves no index: P_TAIL sorts last as well as being
// constructed last. That isolates mutation N2 to the tests that are about
// reference-input completeness (3 and 4) instead of every test in the file.
const P_PARAMS = TX("11", 0); // sorts 0
const P_NODE = TX("22", 0); // sorts 1
const P_TAIL = TX("ff", 0); // sorts 2, constructed last
const CALM_REFS = [P_PARAMS, P_NODE, P_TAIL];

const POLICY_A = "d1".repeat(28);
const POLICY_B = "d2".repeat(28);
const POLICY_C = "d3".repeat(28);

/**
 * Pull one policy's proof back out of the `Pairs<PolicyId, MintingRegistryProof>`
 * map. `Data.map` is a JS Map keyed by Uint8Array IDENTITY, so `.get()` cannot
 * find anything — the key must be matched on its BYTES.
 */
const proofFor = (map, policyId) => {
  for (const [k, v] of map) {
    if (hex(k) === policyId.toLowerCase()) return v;
  }
  throw new Error(`no map entry for policy ${policyId}`);
};

const cbor = (d) => hex(Data.toCBORBytes(d));

test("⛔ omitting the issuance_logic withdrawal shifts plgIdx — the synthetic four-withdrawal set", () => {
  const plan = issuancePlan({
    issuanceLogicHash: ISSUANCE_LOGIC,
    plgHash: PLG_HASH,
    otherWithdrawals: [S(ISSUER_ADMIN), S(THIRD_PARTY_H)],
    referenceInputs: CALM_REFS,
    paramsRefInput: P_PARAMS,
    issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: P_NODE } }],
  });

  assert.equal(
    plan.withdrawals.length,
    4,
    "issuance_logic, the dispatcher and both delegates — a count alone would also accept three plus a duplicate"
  );

  // DERIVATION (harness §7d — assert the IDENTITY at each slot, not just the
  // count). Every credential here is a script credential, so the script-before-key
  // rule is inert and the order is bytewise on the hash:
  //     11… < aa… < bb… < cc…
  assert.equal(plan.withdrawalIndexOf(S(ISSUANCE_LOGIC)), 0, "11… sorts first");
  assert.equal(plan.withdrawalIndexOf(S(PLG_HASH)), 1, "aa… second");
  assert.equal(plan.withdrawalIndexOf(S(ISSUER_ADMIN)), 2, "bb… third");
  assert.equal(plan.withdrawalIndexOf(S(THIRD_PARTY_H)), 3, "cc… fourth");

  assert.deepEqual(plan.issuanceLogicKey, S(ISSUANCE_LOGIC));
  assert.equal(plan.plgIdx(), 1, "the dispatcher's slot, over the COMPLETE four-member set");

  // ⚑ THE POINT. A builder that computes the dispatcher's index over the THREE
  // withdrawals it knows about — omitting issuance_logic, which alpha.4 added —
  // gets 0. On chain that resolves to the wrong credential and fails an equality
  // check naming nothing: `covered_by` does not report a missing withdrawal, it
  // simply returns False.
  assert.notEqual(
    withdrawalIndexOf([S(PLG_HASH), S(ISSUER_ADMIN), S(THIRD_PARTY_H)], S(PLG_HASH)),
    plan.plgIdx(),
    "0 vs 1 — the exact wrongness this object exists to prevent"
  );
});

test("a pure mint has no dispatcher, and asking for plgIdx says so", () => {
  const plan = issuancePlan({
    issuanceLogicHash: ISSUANCE_LOGIC,
    otherWithdrawals: [S(ISSUER_ADMIN), S(THIRD_PARTY_H)],
    referenceInputs: CALM_REFS,
    paramsRefInput: P_PARAMS,
    issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: P_NODE } }],
  });

  // Asserted FIRST on purpose: mutation N1 removes issuance_logic from the set,
  // which must NOT reach this refusal. With the throws first, a red anywhere
  // below is positive evidence that the refusal itself survived.
  assert.throws(
    () => plan.plgIdx(),
    /plgHash/,
    "register and mint spend no programmable_logic_base input, so there is no dispatcher withdrawal to index — and a plan that silently returned 0 would be the same defect wearing the opposite sign"
  );

  assert.equal(plan.withdrawals.length, 3);
  // 11… < bb… < cc…, all script credentials.
  assert.equal(plan.withdrawalIndexOf(S(ISSUANCE_LOGIC)), 0);
  assert.equal(plan.withdrawalIndexOf(S(ISSUER_ADMIN)), 1);
  assert.equal(plan.withdrawalIndexOf(S(THIRD_PARTY_H)), 2);
});

// Reference inputs whose LEDGER order is not their CONSTRUCTION order, so the
// sort demonstrably moves them: constructed cc#0, 33#2, 33#0.
const R_LATE = TX("cc", 0); // sorts 2
const R_PARAMS = TX("33", 2); // sorts 1
const R_EARLY = TX("33", 0); // sorts 0
const SHUFFLED_REFS = [R_LATE, R_PARAMS, R_EARLY];

test("the reference-input set is complete, or params_idx is a hard fail", () => {
  const plan = issuancePlan({
    issuanceLogicHash: ISSUANCE_LOGIC,
    otherWithdrawals: [],
    referenceInputs: SHUFFLED_REFS,
    paramsRefInput: R_PARAMS,
    issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: R_LATE } }],
  });

  // DERIVATION: ordered by (tx id bytewise, then output index numerically) —
  //     33…#0  →  0     (R_EARLY, constructed LAST)
  //     33…#2  →  1     (R_PARAMS)
  //     cc…#0  →  2     (R_LATE, constructed FIRST)
  assert.equal(plan.paramsIdx, 1, "same tx id as R_EARLY, higher output index");
  assert.equal(plan.referenceInputIndexOf(R_LATE), 2, "cc… sorts after both 33… entries");
  assert.equal(
    cbor(proofFor(plan.issuanceLogicRedeemer, POLICY_A)),
    cbor(mintingProofRefInput(2)),
    "the proof carries the index into the COMPLETE sorted set, not the construction order"
  );

  // `issuance_mint` calls params.with_protocol_params_fields, which opens with
  // `list.expect_at(reference_inputs, params_idx)`. That is a HARD FAIL, not a
  // scan: there is no fallback and no search, so a params UTxO the builder
  // forgot to add as a reference input cannot be recovered on chain.
  assert.throws(
    () =>
      issuancePlan({
        issuanceLogicHash: ISSUANCE_LOGIC,
        otherWithdrawals: [],
        referenceInputs: [R_LATE, R_EARLY],
        paramsRefInput: R_PARAMS,
        issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: R_LATE } }],
      }),
    (err) => {
      assert.ok(
        err.message.includes(`${R_PARAMS.txHash}#${R_PARAMS.outputIndex}`),
        `must name the coordinate, got: ${err.message}`
      );
      assert.match(err.message, /expect_at/, "must say why there is no fallback");
      return true;
    }
  );
});

test("adding a reference input shifts every index computed from it", () => {
  const mk = (refs) =>
    issuancePlan({
      issuanceLogicHash: ISSUANCE_LOGIC,
      otherWithdrawals: [],
      referenceInputs: refs,
      paramsRefInput: R_PARAMS,
      issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: R_LATE } }],
    });

  const three = mk(SHUFFLED_REFS);
  // The extra entry sorts BEFORE the params UTxO — 00…#0 is bytewise first —
  // and is constructed LAST, so nothing about the caller's ordering hints at it.
  const four = mk([...SHUFFLED_REFS, TX("00", 0)]);

  // DERIVATION, three: 33#0=0, 33#2=1, cc#0=2        → params_idx 1
  // DERIVATION, four:  00#0=0, 33#0=1, 33#2=2, cc#0=3 → params_idx 2
  assert.equal(three.paramsIdx, 1);
  assert.equal(four.paramsIdx, 2);
  assert.notEqual(
    three.paramsIdx,
    four.paramsIdx,
    "this is why the plan owns the reference-input set: the issuance_logic script arrives as a reference input on EVERY issuing transaction in alpha.4, and it moves params_idx and the registry-node index underneath a builder that computed them earlier"
  );
});

test("an output proof is indexed by TAG, and the CIP-68 output shifts it", () => {
  const T5_PARAMS = TX("11", 0); // sorts 0
  const T5_N1 = TX("22", 0); // sorts 1
  const T5_N2 = TX("33", 0); // sorts 2
  const T5_TAIL = TX("ff", 0); // sorts 3, constructed last
  const refs = [T5_PARAMS, T5_N1, T5_N2, T5_TAIL];

  const issued = [
    { policyId: POLICY_A, proof: { kind: "reference-input", input: T5_N1 } },
    { policyId: POLICY_B, proof: { kind: "reference-input", input: T5_N2 } },
    { policyId: POLICY_C, proof: { kind: "output", tag: "new-node" } },
  ];

  const mk = (outputs) =>
    issuancePlan({
      issuanceLogicHash: ISSUANCE_LOGIC,
      otherWithdrawals: [],
      referenceInputs: refs,
      paramsRefInput: T5_PARAMS,
      outputs,
      issued,
    });

  const withoutCip68 = mk(["user-token", "covering-node", "new-node"]);
  const withCip68 = mk(["user-token", "cip68-reference", "covering-node", "new-node"]);

  // The literal this retires is `registryOutputIndex = hasCIP68 ? 3 : 2` at
  // src/substandards/freeze-and-seize/index.ts:514 — a ternary over a count
  // rather than a lookup by name. Its CIP-68 branch has NEVER EXECUTED ON CHAIN.
  assert.equal(
    cbor(proofFor(withoutCip68.issuanceLogicRedeemer, POLICY_C)),
    cbor(mintingProofOutputIndex(2)),
    "three outputs: new-node is at 2"
  );
  assert.equal(
    cbor(proofFor(withCip68.issuanceLogicRedeemer, POLICY_C)),
    cbor(mintingProofOutputIndex(3)),
    "the CIP-68 reference output pushes new-node to 3 — the tag is the same, the index is not"
  );

  assert.deepEqual(withCip68.declaredOutputs, [
    "user-token",
    "cip68-reference",
    "covering-node",
    "new-node",
  ]);

  // The whole map, so the reference-input arms are pinned in the same breath.
  assert.equal(
    cbor(withoutCip68.issuanceLogicRedeemer),
    cbor(
      issuanceLogicRedeemer([
        { policyId: POLICY_A, proof: mintingProofRefInput(1) },
        { policyId: POLICY_B, proof: mintingProofRefInput(2) },
        { policyId: POLICY_C, proof: mintingProofOutputIndex(2) },
      ])
    )
  );
});

test("the plan's IssuanceRedeemer carries params_idx over the complete reference-input set", () => {
  const plan = issuancePlan({
    issuanceLogicHash: ISSUANCE_LOGIC,
    otherWithdrawals: [],
    referenceInputs: SHUFFLED_REFS,
    paramsRefInput: R_PARAMS,
    issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: R_LATE } }],
  });

  assert.equal(cbor(plan.issuanceRedeemer), cbor(issuanceRedeemer(1)));
  assert.deepEqual(
    plan.referenceInputs,
    SHUFFLED_REFS,
    "handed back COMPLETE and UNSORTED — these are exactly the reference inputs the builder must emit"
  );
});

// ---------------------------------------------------------------------------
// programmableLogicGlobalRedeemer — the Object.prototype hole
// ---------------------------------------------------------------------------

test("⛔ programmableLogicGlobalRedeemer refuses an inherited Object.prototype key", () => {
  // HARM ANALYSIS. Before the fix, `PlgAct["valueOf"]` inherits a FUNCTION from
  // Object.prototype, so `idx === undefined` is false and the function is handed
  // to Data.constr, which dies inside Evolution's schema with
  //     Constr (Constructor) └─ ["index"] └─ Data.Constr.Index
  //     └─ From side refinement failure └─ Expected big
  // That message names NEITHER the unknown act NOR the three valid ones: it
  // points the reader at Evolution's schema instead of at their own typo.
  // TypeScript callers cannot reach it — `PlgActVariant` is `keyof typeof
  // PlgAct` — but `.mjs` tests and JavaScript consumers can, and this package
  // ships to JavaScript consumers. Twin of the protocolParamsRedeemer finding
  // (T-F02-1 audit F-2) in src/core/evo-utils.ts.
  for (const inherited of ["valueOf", "toString", "constructor"]) {
    assert.throws(
      () => programmableLogicGlobalRedeemer(inherited),
      (err) => {
        assert.match(err.message, /unknown act/, `${inherited}: must say what went wrong`);
        assert.match(err.message, /TRANSFER/, `${inherited}: must name the valid acts`);
        assert.match(err.message, /THIRD_PARTY/, `${inherited}: must name the valid acts`);
        assert.match(err.message, /UNFRACKING/, `${inherited}: must name the valid acts`);
        return true;
      },
      `${inherited} is inherited from Object.prototype, not a dispatch variant`
    );
  }

  // §7f — a guard that refuses everything is not a fixed guard. The three real
  // acts must still encode to exactly the bytes they encoded to before.
  assert.equal(cbor(programmableLogicGlobalRedeemer("TRANSFER")), cbor(Data.constr(0n, [])));
  assert.equal(cbor(programmableLogicGlobalRedeemer("THIRD_PARTY")), cbor(Data.constr(1n, [])));
  assert.equal(cbor(programmableLogicGlobalRedeemer("UNFRACKING")), cbor(Data.constr(2n, [])));
});

// ---------------------------------------------------------------------------
// The ten refusals
// ---------------------------------------------------------------------------

const validPlan = (over = {}) => ({
  issuanceLogicHash: ISSUANCE_LOGIC,
  otherWithdrawals: [S(ISSUER_ADMIN)],
  referenceInputs: CALM_REFS,
  paramsRefInput: P_PARAMS,
  issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: P_NODE } }],
  ...over,
});

/**
 * ⚑ Each entry asserts on the MESSAGE, never merely that something threw: a
 * suite of bare `throws` cannot tell a working implementation from a gutted one
 * (harness §9c-i) — every clause aborts, so every test passes.
 *
 * The lowercase spelling is listed FIRST in the duplicate-policy case on
 * purpose, so that mutation N5 (which reddens only the reverse ordering) stays
 * confined to datum-layout.test.mjs where it is measured.
 */
const REFUSALS = [
  {
    name: "an empty issued list",
    build: () => validPlan({ issued: [] }),
    match: /EMPTY/,
  },
  {
    name: "a duplicate policy id differing only in hex case",
    build: () =>
      validPlan({
        issued: [
          { policyId: POLICY_A, proof: { kind: "reference-input", input: P_NODE } },
          { policyId: POLICY_A.toUpperCase(), proof: { kind: "reference-input", input: P_TAIL } },
        ],
      }),
    match: /duplicate policy id/,
  },
  {
    name: "a proof that is not a source — a pre-built MintingRegistryProof",
    build: () => validPlan({ issued: [{ policyId: POLICY_A, proof: mintingProofRefInput(0) }] }),
    match: /MintingRegistryProof/,
  },
  {
    name: "paramsRefInput absent from referenceInputs",
    build: () => validPlan({ paramsRefInput: TX("99", 7) }),
    match: /99{63}#7/,
  },
  {
    name: "a reference-input proof whose input is absent from referenceInputs",
    build: () =>
      validPlan({
        issued: [{ policyId: POLICY_A, proof: { kind: "reference-input", input: TX("88", 5) } }],
      }),
    match: /88{63}#5/,
  },
  {
    name: "an output proof whose tag is absent from outputs",
    build: () =>
      validPlan({
        outputs: ["user-token", "covering-node"],
        issued: [{ policyId: POLICY_A, proof: { kind: "output", tag: "no-such-tag" } }],
      }),
    match: /no-such-tag/,
  },
  {
    // ⛔ WAS `/outputs/`, WHICH THE NEIGHBOURING GUARD ALSO SATISFIED. With this
    // guard removed, `declaredOutputs` falls through as [] and the unknown-tag
    // guard fires instead with "Declared outputs, in emission order: []" — which
    // contains the word "outputs", so the old regex stayed green and the guard
    // was undefended (audit r1, M1: guard removed, 161/161 still passing).
    // Pinned now on text unique to THIS guard, plus the ABSENCE of the
    // neighbour's, so the test can only pass by the right guard firing.
    name: "an output proof when outputs was not supplied at all",
    build: () =>
      validPlan({ issued: [{ policyId: POLICY_A, proof: { kind: "output", tag: "new-node" } }] }),
    match: /`outputs` was not supplied/,
    absent: /unknown output tag/,
  },
  {
    name: "a duplicate output tag",
    build: () =>
      validPlan({
        outputs: ["covering-node", "covering-node"],
        issued: [{ policyId: POLICY_A, proof: { kind: "output", tag: "covering-node" } }],
      }),
    // Also tightened in the r3 sweep: `/covering-node/` was satisfied by the
    // unknown-tag guard's message, which lists the declared outputs — and
    // "covering-node" is one of them.
    match: /duplicate output tag/,
  },
  {
    name: "a duplicate reference input",
    build: () => validPlan({ referenceInputs: [P_PARAMS, P_NODE, P_NODE] }),
    match: /22{63}#0/,
  },
  {
    name: "a duplicate withdrawal credential",
    build: () => validPlan({ otherWithdrawals: [S(ISSUER_ADMIN), S(ISSUER_ADMIN)] }),
    match: /duplicate withdrawal credential/,
  },
];

for (const { name, build, match, absent } of REFUSALS) {
  test(`⚑ issuancePlan refuses: ${name}`, () => {
    assert.throws(() => issuancePlan(build()), (err) => {
      assert.match(err.message, match, `${name}: must be pinned by ITS OWN message`);
      if (absent) {
        assert.doesNotMatch(
          err.message,
          absent,
          `${name}: a NEIGHBOURING guard fired instead — the test would be green for the wrong reason`
        );
      }
      return true;
    });
  });
}

test("⛔ each refusal is pinned by a message no OTHER refusal produces", () => {
  // §2d, one level up from the count. A refusal test can be green because the
  // guard under test fired, or because a NEIGHBOURING guard fired with a message
  // that happens to satisfy the same regex — and the second is invisible until
  // someone removes the guard. That is exactly what audit r1's M1 found: the
  // guard deleted, the suite 161/161 green.
  //
  // So the uniqueness is asserted as a standing property rather than swept once
  // by hand: build the message every case actually produces, then require each
  // case's regex to match its OWN message and NO other. Two regexes failed this
  // when it was first run (#7 `/outputs/`, #8 `/covering-node/`); both are
  // tightened above.
  const messages = REFUSALS.map(({ name, build }) => {
    try {
      issuancePlan(build());
      throw new Error(`refusal "${name}" did not throw at all`);
    } catch (err) {
      return err.message;
    }
  });

  for (const [i, { name, match, absent }] of REFUSALS.entries()) {
    assert.match(messages[i], match, `${name}: its own message must satisfy its own regex`);
    if (absent) assert.doesNotMatch(messages[i], absent, `${name}: absence assertion must hold on its own message`);
    for (const [j, other] of messages.entries()) {
      if (i === j) continue;
      assert.doesNotMatch(
        other,
        match,
        `${name}'s regex is ALSO satisfied by "${REFUSALS[j].name}" — that guard could be deleted and this test would stay green`
      );
    }
  }
});

test("⛔ a falsy plgHash cannot switch the duplicate-credential refusal off", () => {
  // AUDIT r1, F-2. `plgHash` was classified by TRUTHINESS where the set is built
  // and by `=== undefined` everywhere else, and the two disagree on "". With
  // `plgHash: ""` the build took the pure-mint branch (so plbWithdrawalPlan's
  // inherited duplicate scan never ran) while the explicit scan took the
  // plgHash-was-supplied branch (so it never ran either): BOTH halves of the
  // duplicate refusal were skipped and a plan carrying bbbb… twice was returned.
  //
  // Fixed two ways, and this asserts the outer one: "" is refused AT ENTRY by
  // name, because a zero-length credential hash is neither a dispatcher nor the
  // absence of one. The inner fix — `!== undefined` where the set is built — is
  // what the mutation below the entry guard exercises.
  assert.throws(
    () =>
      issuancePlan(
        validPlan({ plgHash: "", otherWithdrawals: [S(ISSUER_ADMIN), S(ISSUER_ADMIN)] })
      ),
    (err) => {
      assert.match(err.message, /plgHash/, "must name the parameter the caller got wrong");
      assert.match(err.message, /EMPTY STRING/, "and say what was wrong with it");
      return true;
    }
  );

  // A real dispatcher hash on the same fixture still reaches the duplicate
  // refusal — §7f, a guard that refuses everything is not a fixed guard.
  assert.throws(
    () =>
      issuancePlan(
        validPlan({ plgHash: PLG_HASH, otherWithdrawals: [S(ISSUER_ADMIN), S(ISSUER_ADMIN)] })
      ),
    /duplicate withdrawal credential/
  );
});

test("a proof source missing its own payload reaches the NAMED refusal", () => {
  // AUDIT r1, F-5. `{ kind: "reference-input" }` with no `input` used to raise a
  // raw TypeError from inside the catch block's own template literal, so the
  // plan's named refusal never emerged. TypeScript blocks this; the JavaScript
  // consumers this package ships to do not.
  for (const proof of [{ kind: "reference-input" }, { kind: "output" }]) {
    assert.throws(
      () => issuancePlan(validPlan({ issued: [{ policyId: POLICY_A, proof }] })),
      (err) => {
        assert.match(err.message, /is not an IssuanceProofSource/, `${proof.kind}: the named refusal`);
        assert.notEqual(err.constructor.name, "TypeError", `${proof.kind}: not a raw TypeError`);
        return true;
      }
    );
  }
});

test("issuancePlan's refusal set has exactly ten members", () => {
  // §2d — a membership list only ever detects REMOVALS, and the member it stops
  // noticing is the newest one, which is the one least likely to be covered
  // anywhere else. Pinning the count is what makes an added-and-untested
  // refusal, or a quietly deleted one, visible.
  // SCOPE: REFUSALS enumerates the ten refusals the contract names, over the
  // issued / reference-input / output / withdrawal SETS. The entry-validation
  // refusal on a malformed `plgHash` (added in r3) is a different category and
  // is tested on its own above; it deliberately does not join this list, so this
  // count keeps meaning what it meant.
  assert.equal(REFUSALS.length, 10);
  assert.equal(new Set(REFUSALS.map((r) => r.name)).size, 10, "ten DISTINCT cases, not one listed twice");
});
