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
} from "../dist/core/ledger-order.js";
import { sortTxInputs } from "../dist/core/registry.js";

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
