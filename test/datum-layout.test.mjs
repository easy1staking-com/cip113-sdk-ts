/**
 * Positional datum layouts and redeemer shapes — CIP-113 0.5.0-alpha.4.
 *
 * Everything here is a positional Constr (or, in one case, a Plutus map). Field
 * ORDER is the on-chain contract, and getting it wrong produces a datum that
 * encodes cleanly, decodes cleanly, and means something else. Nothing in
 * TypeScript can see it: every credential field has the same shape as every
 * other credential field.
 *
 * So these tests assert POSITION, not just round-trip. A round-trip test alone
 * is vacuous against a reordering, because the encoder and decoder would move
 * together and agree with each other all the way to the ledger's rejection.
 *
 * The two layouts have bitten differently:
 *
 *   RegistryNode  — this SDK emitted the FIVE-field pre-#52 layout with no
 *                   minting_logic_script at all, while upstream's own SDK impact
 *                   map asserted this repo was "already on the 6-field post-#52
 *                   shape (verified: minting_logic_script at index 2)". It was
 *                   not. Two fields were inserted MID-RECORD (index 2 by #52,
 *                   index 5 by unfracking v2), shifting everything after them.
 *                   ⚑ UNCHANGED in alpha.4: still exactly 7 fields, same order —
 *                   verified against blueprints/standard/v0.5.0-alpha.4's own
 *                   `registry_node/RegistryNode` definition, not against prose.
 *
 *   ProgrammableLogicGlobalParams — SIX fields in 0.5.0-alpha.4, up from FOUR
 *                   in alpha.3. ⛔ THE NEW FIELD WAS INSERTED AT INDEX 1, NOT
 *                   APPENDED: `issuance_logic_cred` now sits at 1 and displaced
 *                   `transfer_cred` to 2. BOTH ARE CREDENTIALS — so a six-field
 *                   datum written in alpha.3's order with two fields appended
 *                   decodes with NO error and names the wrong authority. The
 *                   arity check cannot catch that (both are six fields long);
 *                   there is a test below that DEMONSTRATES the misread and says
 *                   where it is actually caught.
 *
 *                   The other new field, `pending_upgrade_cred` at index 5, is
 *                   an `Option<Credential>` — `Constr(0,[cred])` for Some,
 *                   `Constr(1,[])` for None.
 *
 *                   ⛔ Do not take shapes from upstream prose. Two upstream
 *                   header comments are STALE and contradict the declaration:
 *                   `issuance_mint.ak` says `issuance_logic_cred` is "field 5",
 *                   `issuance_logic.ak` says "`transfer_cred`, field 1;
 *                   `third_party_cred`, field 2". Every field here comes from
 *                   `blueprints/standard/v0.5.0-alpha.4/plutus.json`'s own
 *                   `definitions`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  registryNodeDatum,
  decodeRegistryNode,
  protocolParamsDatum,
  decodeProtocolParams,
  issuanceRedeemer,
  issuanceLogicRedeemer,
  protocolParamsRedeemer,
  multisigScriptDatum,
  decodeMultisigScript,
  MULTISIG_MAX_SIZE,
  mintingProofRefInput,
  mintingProofOutputIndex,
  voidData,
} from "../dist/core/evo-utils.js";

/** Data.bytearray() produces a Uint8Array; compare in hex, not by identity. */
const hex = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);
const at = (d, i) => hex(d.fields[i]);
const credAt = (d, i) => hex(d.fields[i].fields[0]);

const S = (h) => ({ type: "script", hash: h });
const K = (h) => ({ type: "key", hash: h });

/** Encode a Cip113Credential the way the SDK does, for hand-built fixtures. */
const credData = (c) =>
  Data.constr(c.type === "script" ? 1n : 0n, [Data.bytearray(c.hash)]);

const NODE = {
  key: "aa".repeat(28),
  next: "bb".repeat(28),
  mintingLogicScript: S("11".repeat(28)),
  transferLogicScript: S("22".repeat(28)),
  thirdPartyTransferLogicScript: S("33".repeat(28)),
  unfrackingLogicScript: S("44".repeat(28)),
  globalStateCs: "cc".repeat(28),
};

/**
 * 0.5.0-alpha.4: SIX fields, ordered by read frequency.
 *
 * Every credential gets a DISTINCT hash on purpose — a fixture that reuses one
 * cannot tell a correct index from a swapped one.
 */
const PARAMS = {
  plgCred: S("a1".repeat(28)),
  issuanceLogicCred: S("a2".repeat(28)),
  transferCred: S("a3".repeat(28)),
  thirdPartyCred: S("a4".repeat(28)),
  upgradeCred: K("a5".repeat(28)),
  pendingUpgradeCred: K("a6".repeat(28)),
};

/**
 * The 7-field (0.5.0-alpha.2) datum, kept as a NEGATIVE fixture.
 *
 * ⚠ Its index 1 is `prog_logic_cred`, which is neither of the two credentials
 * that have occupied index 1 since. All well-formed, which is exactly why a
 * positional read of the wrong layout returns a plausible value.
 */
const LEGACY_SEVEN_FIELD = Data.constr(0n, [
  Data.bytearray("de".repeat(28)),
  Data.constr(1n, [Data.bytearray("a1".repeat(28))]),
  Data.constr(1n, [Data.bytearray("a2".repeat(28))]),
  Data.constr(1n, [Data.bytearray("a3".repeat(28))]),
  Data.constr(1n, [Data.bytearray("a4".repeat(28))]),
  Data.constr(0n, [Data.bytearray("a5".repeat(28))]),
  Data.int(1024n),
]);

/**
 * The 4-field (0.5.0-alpha.3) datum, the immediately previous layout.
 * `(plg_cred, transfer_cred, third_party_cred, upgrade_cred)` — note
 * `transfer_cred` at index 1, where alpha.4 puts `issuance_logic_cred`.
 */
const LEGACY_FOUR_FIELD = Data.constr(0n, [
  credData(PARAMS.plgCred),
  credData(PARAMS.transferCred),
  credData(PARAMS.thirdPartyCred),
  credData(PARAMS.upgradeCred),
]);

// ---------------------------------------------------------------------------
// RegistryNode — 7 fields (unchanged in alpha.4)
// ---------------------------------------------------------------------------

test("RegistryNode: exactly 7 fields, in the on-chain order", () => {
  const d = registryNodeDatum(NODE);
  assert.ok(d instanceof Data.Constr);
  assert.equal(d.index, 0n);
  assert.equal(d.fields.length, 7, "RegistryNode is 7 fields, alpha.2 through alpha.4");

  // Assert each field BY POSITION against its expected hash. A reordering moves
  // a hash to a different index and fails here, where a round-trip would not.
  assert.equal(at(d, 0), NODE.key, "index 0 = key");
  assert.equal(at(d, 1), NODE.next, "index 1 = next");
  assert.equal(credAt(d, 2), NODE.mintingLogicScript.hash, "index 2 = minting_logic_script (#52)");
  assert.equal(credAt(d, 3), NODE.transferLogicScript.hash, "index 3 = transfer_logic_script");
  assert.equal(credAt(d, 4), NODE.thirdPartyTransferLogicScript.hash, "index 4 = third_party");
  assert.equal(credAt(d, 5), NODE.unfrackingLogicScript.hash, "index 5 = unfracking (v2)");
  assert.equal(at(d, 6), NODE.globalStateCs, "index 6 = global_state_cs");
});

test("RegistryNode: round-trips", () => {
  assert.deepEqual(decodeRegistryNode(registryNodeDatum(NODE)), NODE);
});

test("RegistryNode: script and key credentials are distinguished", () => {
  // Constr index 0 = VerificationKey, 1 = Script. Collapsing them yields a
  // credential that points at the right hash with the wrong kind.
  const keyed = { ...NODE, transferLogicScript: K("22".repeat(28)) };
  assert.equal(registryNodeDatum(NODE).fields[3].index, 1n, "script credential is Constr(1)");
  assert.equal(registryNodeDatum(keyed).fields[3].index, 0n, "key credential is Constr(0)");
  assert.equal(decodeRegistryNode(registryNodeDatum(keyed)).transferLogicScript.type, "key");
});

test("RegistryNode: the retired 5- and 6-field layouts are REFUSED, not partially read", () => {
  const five = Data.constr(0n, [
    Data.bytearray(NODE.key),
    Data.bytearray(NODE.next),
    Data.constr(1n, [Data.bytearray(NODE.transferLogicScript.hash)]),
    Data.constr(1n, [Data.bytearray(NODE.thirdPartyTransferLogicScript.hash)]),
    Data.bytearray(NODE.globalStateCs),
  ]);
  assert.throws(() => decodeRegistryNode(five), /expected exactly 7 fields, got 5/);

  const six = Data.constr(0n, [...five.fields.slice(0, 4), Data.bytearray("ee".repeat(28)), five.fields[4]]);
  assert.throws(() => decodeRegistryNode(six), /expected exactly 7 fields, got 6/);
});

// ---------------------------------------------------------------------------
// ProgrammableLogicGlobalParams — 6 fields, the protocol-params datum
// ---------------------------------------------------------------------------

test("ProtocolParams: exactly 6 fields, in read-frequency order", () => {
  const d = protocolParamsDatum(PARAMS);
  assert.equal(d.fields.length, 6, "six in alpha.4 — up from four, with the new field at index 1");

  assert.equal(credAt(d, 0), PARAMS.plgCred.hash, "index 0 = plg_cred (the dispatcher)");
  assert.equal(credAt(d, 1), PARAMS.issuanceLogicCred.hash, "index 1 = issuance_logic_cred (NEW)");
  assert.equal(credAt(d, 2), PARAMS.transferCred.hash, "index 2 = transfer_cred (was index 1)");
  assert.equal(credAt(d, 3), PARAMS.thirdPartyCred.hash, "index 3 = third_party_cred");
  assert.equal(credAt(d, 4), PARAMS.upgradeCred.hash, "index 4 = upgrade_cred");

  // index 5 is Option<Credential>: Some(cred) = Constr(0, [Credential]).
  const pending = d.fields[5];
  assert.equal(pending.index, 0n, "index 5 = pending_upgrade_cred, Some = Constr(0)");
  assert.equal(pending.fields.length, 1, "Some carries exactly one field");
  assert.equal(
    hex(pending.fields[0].fields[0]),
    PARAMS.pendingUpgradeCred.hash,
    "index 5 holds pending_upgrade_cred"
  );
});

test("ProtocolParams: pending_upgrade_cred is an Option, both ways", () => {
  // None — the resting state, and the only state genesis may create.
  const none = protocolParamsDatum({ ...PARAMS, pendingUpgradeCred: null });
  assert.equal(none.fields[5].index, 1n, "None = Constr(1)");
  assert.equal(none.fields[5].fields.length, 0, "None carries NO fields");
  assert.equal(decodeProtocolParams(none).pendingUpgradeCred, null, "None round-trips to null");

  // Some — a handover in flight.
  const some = protocolParamsDatum(PARAMS);
  assert.equal(some.fields[5].index, 0n, "Some = Constr(0)");
  assert.equal(some.fields[5].fields[0].index, 0n, "the nominee here is a key credential");
  assert.deepEqual(
    decodeProtocolParams(some).pendingUpgradeCred,
    PARAMS.pendingUpgradeCred,
    "Some round-trips to the credential"
  );
});

test("ProtocolParams: the delegate credentials are NOT interchangeable", () => {
  // transfer and third_party sit at 2 and 3 and are structurally identical, so
  // a swap wires the protocol to the wrong validator with no encoding error.
  const swapped = { ...PARAMS, transferCred: PARAMS.thirdPartyCred, thirdPartyCred: PARAMS.transferCred };
  assert.notEqual(
    hex(Data.toCBORBytes(protocolParamsDatum(PARAMS))),
    hex(Data.toCBORBytes(protocolParamsDatum(swapped))),
    "swapping transfer and third_party MUST change the encoded datum"
  );
  assert.equal(decodeProtocolParams(protocolParamsDatum(swapped)).transferCred.hash, PARAMS.thirdPartyCred.hash);

  // And the index-1 pair, which is the one this migration moved.
  const swapped1 = {
    ...PARAMS,
    issuanceLogicCred: PARAMS.transferCred,
    transferCred: PARAMS.issuanceLogicCred,
  };
  assert.notEqual(
    hex(Data.toCBORBytes(protocolParamsDatum(PARAMS))),
    hex(Data.toCBORBytes(protocolParamsDatum(swapped1))),
    "swapping issuance_logic and transfer MUST change the encoded datum"
  );
});

test("ProtocolParams: round-trips, including a standing nomination", () => {
  assert.deepEqual(decodeProtocolParams(protocolParamsDatum(PARAMS)), PARAMS);
});

test("⛔ ProtocolParams: the 4-field alpha.3 datum is REFUSED, not read positionally", () => {
  assert.equal(LEGACY_FOUR_FIELD.fields.length, 4, "fixture precondition");

  assert.throws(
    () => decodeProtocolParams(LEGACY_FOUR_FIELD),
    (err) => {
      assert.match(err.message, /expected exactly 6 fields, got 4/);
      assert.match(err.message, /issuance_logic_cred/, "must name the field that arrived at index 1");
      assert.match(err.message, /transfer_cred/, "must name the field it displaced");
      assert.match(err.message, /0\.5\.0-alpha\.3/, "must say which version a 4-field datum belongs to");
      return true;
    },
    "a 4-field datum belongs to an alpha.3 instance and must be refused outright"
  );
});

test("⛔ ProtocolParams: the 7-field alpha.2 datum is REFUSED, not read positionally", () => {
  assert.equal(LEGACY_SEVEN_FIELD.fields.length, 7, "fixture precondition");

  assert.throws(
    () => decodeProtocolParams(LEGACY_SEVEN_FIELD),
    (err) => {
      assert.match(err.message, /expected exactly 6 fields, got 7/);
      assert.match(err.message, /issuance_logic_cred/, "must name the field that arrived at index 1");
      assert.match(err.message, /transfer_cred/, "must name the field it displaced");
      assert.match(err.message, /0\.5\.0-alpha\.2/, "must say which version a 7-field datum belongs to");
      return true;
    },
    "a 7-field datum belongs to an alpha.2 instance and must be refused outright"
  );
});

/**
 * ⛔ THE DEFECT THIS SLICE EXISTS TO PREVENT, DEMONSTRATED RATHER THAN ASSERTED.
 *
 * A migration that took the shape from upstream's stale prose — which still
 * says `transfer_cred` is field 1 — would keep alpha.3's order and APPEND the
 * two new fields. The result is six fields long, so the arity check passes; it
 * is a well-formed Credential at every credential slot, so no type check fires;
 * and it hands `issuance_mint` the TRANSFER credential where it expects
 * ISSUANCE_LOGIC.
 *
 * NO DECODER CAN CATCH THIS. Both layouts are six positional Credentials and an
 * Option. What prevents PRODUCING it is the keyed encoder: `protocolParamsDatum`
 * takes a named record and there is no positional form to get wrong.
 *
 * ⇒ Where it IS caught: T-F03's devnet bootstrap, which reads the datum back
 * off chain and compares every decoded field against the deployment record.
 * That is a comparison against a source outside the codec, which is the only
 * instrument with jurisdiction here.
 */
test("⛔ ProtocolParams: an alpha.3-ordered six-field datum decodes CLEANLY and lies", () => {
  const ALPHA3_ORDER_SIX = Data.constr(0n, [
    credData(PARAMS.plgCred), //          0  plg_cred          — same in both layouts
    credData(PARAMS.transferCred), //     1  transfer_cred     — alpha.3's index 1
    credData(PARAMS.thirdPartyCred), //   2
    credData(PARAMS.upgradeCred), //      3
    credData(S("a9".repeat(28))), //      4  whatever the mistaken migration appended
    Data.constr(1n, []), //               5  None
  ]);

  // It decodes. No throw, no warning, nothing to notice.
  const decoded = decodeProtocolParams(ALPHA3_ORDER_SIX);

  // And index 1 is read as issuance_logic_cred while holding the TRANSFER hash.
  assert.equal(
    decoded.issuanceLogicCred.hash,
    PARAMS.transferCred.hash,
    "issuance_logic_cred was read out of the slot alpha.3 gave transfer_cred"
  );

  // The datum this SDK builds for the SAME protocol differs at exactly that index.
  const correct = protocolParamsDatum(PARAMS);
  assert.notEqual(
    credAt(correct, 1),
    credAt(ALPHA3_ORDER_SIX, 1),
    "the keyed encoder cannot produce the alpha.3 order — that is what prevents this"
  );
  assert.equal(credAt(correct, 1), PARAMS.issuanceLogicCred.hash);
});

test("ProtocolParams: a malformed Option at index 5 is refused by name", () => {
  const bad = Data.constr(0n, [
    ...protocolParamsDatum(PARAMS).fields.slice(0, 5),
    Data.int(0n), // not an Option at all
  ]);
  assert.throws(() => decodeProtocolParams(bad), /pending_upgrade_cred/);
});

// ---------------------------------------------------------------------------
// IssuanceRedeemer — the PERMANENT policy's redeemer
// ---------------------------------------------------------------------------

test("IssuanceRedeemer: Constr(0, [Int]) carrying params_idx", () => {
  const r = issuanceRedeemer(3);
  assert.ok(r instanceof Data.Constr);
  assert.equal(r.index, 0n, "IssuanceRedeemer is constructor 0");
  assert.equal(r.fields.length, 1, "one field: params_idx");
  assert.equal(r.fields[0], 3n);
});

test("IssuanceRedeemer: a negative or non-integer params_idx is refused BY NAME", () => {
  assert.throws(() => issuanceRedeemer(-1), /params_idx/);
  assert.throws(() => issuanceRedeemer(1.5), /params_idx/);
});

// ---------------------------------------------------------------------------
// IssuanceLogicRedeemer — a Plutus MAP, not a Constr
// ---------------------------------------------------------------------------

test("IssuanceLogicRedeemer: a Plutus map policy -> MintingRegistryProof", () => {
  const p1 = "11".repeat(28);
  const p2 = "22".repeat(28);
  const m = issuanceLogicRedeemer([
    { policyId: p1, proof: mintingProofRefInput(2) },
    { policyId: p2, proof: mintingProofOutputIndex(0) },
  ]);

  assert.ok(m instanceof Map, "IssuanceLogicRedeemer is a Pairs association list");
  const entries = [...m.entries()];
  assert.equal(entries.length, 2);

  // issuance_mint reads only the KEYS; issuance_logic reads only the VALUES.
  assert.deepEqual(entries.map(([k]) => hex(k)), [p1, p2], "keys are the policy ids");
  assert.equal(entries[0][1].index, 0n, "RefInput proof keeps constructor 0");
  assert.equal(entries[0][1].fields[0], 2n);
  assert.equal(entries[1][1].index, 1n, "OutputIndex proof keeps constructor 1");
  assert.equal(entries[1][1].fields[0], 0n);
});

test("⛔ IssuanceLogicRedeemer: an EMPTY map is refused — list.all([]) is vacuously true", () => {
  assert.throws(
    () => issuanceLogicRedeemer([]),
    (err) => {
      assert.match(err.message, /empty/i);
      assert.match(err.message, /vacuous/i, "must say WHY: the on-chain list.all passes on []");
      return true;
    }
  );
});

test("⛔ IssuanceLogicRedeemer: a duplicate policy id is refused (Data.map does NOT dedupe)", () => {
  const p = "33".repeat(28);

  // MEASURED, and this is the reason the check compares HEX STRINGS: Data.map
  // builds a JS Map keyed by Uint8Array IDENTITY, so two distinct arrays with
  // identical bytes BOTH survive. The map is not deduplicated for you.
  const raw = Data.map([
    [Data.bytearray(p), Data.int(1n)],
    [Data.bytearray(p), Data.int(2n)],
  ]);
  assert.equal(raw.size, 2, "two byte-identical keys, two surviving entries");

  assert.throws(
    () => issuanceLogicRedeemer([
      { policyId: p, proof: mintingProofRefInput(0) },
      { policyId: p, proof: mintingProofOutputIndex(1) },
    ]),
    (err) => {
      assert.match(err.message, /duplicate/i);
      assert.match(err.message, new RegExp(p));
      return true;
    }
  );
});

/**
 * ⛔ THE SAME DUPLICATE, ONE SPELLING APART. Hex case is presentation, not
 * identity: `Data.bytearray` decodes both spellings to the same bytes, so two
 * entries differing only in case land in the map as BYTE-IDENTICAL keys.
 * MEASURED before the fix: `issuanceLogicRedeemer` accepted them and `map.size`
 * was 2 with both keys equal.
 *
 * How a caller gets there without doing anything odd: one policy id derived
 * in-process by `computeScriptHash` (lowercase), one pasted from a block
 * explorer or a config file (uppercase). On chain `issuance_logic`'s `list.all`
 * then runs the rule set twice, and `issuance_mint`'s `has_key` matches
 * whichever entry the ledger reaches first — so which of the two proofs governs
 * is decided by ledger internals rather than by the builder.
 *
 * Same hazard the block comment at `src/core/ledger-order.ts:60` measures for
 * reference-input ordering, one file over.
 */
test("⛔ IssuanceLogicRedeemer: a duplicate policy id differing only in hex CASE is refused", () => {
  const lower = "ab".repeat(28);
  const upper = "AB".repeat(28);

  // The premise: these two spellings ARE one key on chain.
  assert.equal(
    hex(Data.bytearray(lower)),
    hex(Data.bytearray(upper)),
    "the two spellings encode to identical bytes — that is why this is a duplicate"
  );

  assert.throws(
    () => issuanceLogicRedeemer([
      { policyId: lower, proof: mintingProofRefInput(0) },
      { policyId: upper, proof: mintingProofOutputIndex(1) },
    ]),
    /duplicate/i,
    "one policy, two spellings, and the map cannot hold both"
  );
});

test("⛔ IssuanceLogicRedeemer: a value that is not a MintingRegistryProof is refused", () => {
  assert.throws(
    () => issuanceLogicRedeemer([{ policyId: "44".repeat(28), proof: Data.int(7n) }]),
    (err) => {
      assert.match(err.message, /mintingProofRefInput/, "must name the builder");
      assert.match(err.message, /mintingProofOutputIndex/, "must name the other builder");
      return true;
    }
  );

  // A Constr of the right shape but the wrong constructor is refused too.
  assert.throws(
    () => issuanceLogicRedeemer([
      { policyId: "44".repeat(28), proof: Data.constr(2n, [Data.int(0n)]) },
    ]),
    /mintingProofRefInput/
  );
});

// ---------------------------------------------------------------------------
// ProtocolParamsRedeemer — three payload-less arms
// ---------------------------------------------------------------------------

test("ProtocolParamsRedeemer: three payload-less arms at their declared indices", () => {
  for (const [arm, idx] of [
    ["PROTOCOL_UPGRADE", 0n],
    ["NOMINATE_AUTHORITY", 1n],
    ["PROMOTE_AUTHORITY", 2n],
  ]) {
    const r = protocolParamsRedeemer(arm);
    assert.equal(r.index, idx, `${arm} is constructor ${idx}`);
    assert.equal(r.fields.length, 0, `${arm} carries no payload`);
  }
});

test("ProtocolParamsRedeemer: an unknown arm is refused, listing the valid names", () => {
  assert.throws(
    () => protocolParamsRedeemer("UPGRADE"),
    (err) => {
      assert.match(err.message, /PROTOCOL_UPGRADE/);
      assert.match(err.message, /NOMINATE_AUTHORITY/);
      assert.match(err.message, /PROMOTE_AUTHORITY/);
      return true;
    }
  );
});

test("ProtocolParamsRedeemer: a PROTOTYPE-inherited key is refused the same way", () => {
  // `ProtocolParamsAct["valueOf"]` is inherited from Object.prototype, so a
  // plain lookup returns a FUNCTION rather than undefined and the arm sails past
  // an `=== undefined` guard into the encoder, where it dies as a Data.Constr
  // index type error naming nothing the caller can act on.
  for (const inherited of ["valueOf", "constructor", "toString"]) {
    assert.throws(
      () => protocolParamsRedeemer(inherited),
      (err) => {
        assert.match(err.message, /Expected one of/, `${inherited} must reach the actionable error`);
        assert.match(err.message, /PROTOCOL_UPGRADE/);
        return true;
      }
    );
  }
});

/**
 * ⛔ HAZARD 3b, DEMONSTRATED. `voidData()` is `Constr(0, [])`, and so is
 * `ProtocolUpgrade`. Every existing caller that passes `voidData()` as the
 * params spend redeemer keeps working BY ACCIDENT — no decoder anywhere, on or
 * off chain, can tell a migrated caller from a stale one, because the bytes are
 * the same bytes. Same shape as the `SpendViaTransfer` / `BaseSpendRedeemer`
 * collision recorded in WORKLOG S-6.
 *
 * ⇒ The silence is asymmetric, which is the whole risk profile: the other two
 * arms carry constructors 1 and 2, which `voidData()` cannot represent, so they
 * fail loudly. Only the upgrade path is quiet.
 *
 * ⇒ T-F03 owns the devnet mutation that proves the redeemer was ever really
 * implemented: submit `NominateAuthority` (`Constr(1,[])`) where the validator
 * expects it and require the mutated form to go RED on chain. Nothing offline
 * can discharge that — the ledger is the only instrument with jurisdiction.
 */
test("⛔ ProtocolParamsRedeemer: PROTOCOL_UPGRADE is BYTE-IDENTICAL to voidData()", () => {
  const asHex = (d) => Buffer.from(Data.toCBORBytes(d)).toString("hex");

  assert.equal(
    asHex(protocolParamsRedeemer("PROTOCOL_UPGRADE")),
    asHex(voidData()),
    "a stale caller passing voidData() produces a valid ProtocolUpgrade — silently"
  );
  assert.notEqual(
    asHex(protocolParamsRedeemer("NOMINATE_AUTHORITY")),
    asHex(voidData()),
    "NominateAuthority cannot be reached by accident"
  );
  assert.notEqual(
    asHex(protocolParamsRedeemer("PROMOTE_AUTHORITY")),
    asHex(voidData()),
    "PromoteAuthority cannot be reached by accident"
  );
});

// ---------------------------------------------------------------------------
// MultisigScript — the upgrade authority's tree
// ---------------------------------------------------------------------------

const k = (b) => b.repeat(28);
const SIG = (h) => ({ type: "signature", keyHash: h });

test("MultisigScript: every variant carries its declared constructor index", () => {
  const cases = [
    [{ type: "signature", keyHash: k("a1") }, 0n],
    [{ type: "all-of", scripts: [SIG(k("a1"))] }, 1n],
    [{ type: "any-of", scripts: [SIG(k("a1"))] }, 2n],
    [{ type: "at-least", required: 1, scripts: [SIG(k("a1"))] }, 3n],
    [{ type: "before", time: 10n }, 4n],
    [{ type: "after", time: 10n }, 5n],
    [{ type: "script", scriptHash: k("a1") }, 6n],
  ];
  for (const [tree, idx] of cases) {
    assert.equal(multisigScriptDatum(tree).index, idx, `${tree.type} is constructor ${idx}`);
  }
});

test("MultisigScript: a nested tree round-trips, both ways", () => {
  const tree = {
    type: "at-least",
    required: 2,
    scripts: [
      SIG(k("a1")),
      { type: "script", scriptHash: k("a2") },
      { type: "after", time: 1_900_000_000_000n },
    ],
  };
  const d = multisigScriptDatum(tree);
  assert.equal(d.index, 3n);
  assert.equal(d.fields[0], 2n, "AtLeast.required is field 0");
  assert.equal(d.fields[1].length, 3, "AtLeast.scripts is field 1");
  assert.equal(d.fields[1][2].index, 5n, "the After leaf kept constructor 5");
  assert.deepEqual(decodeMultisigScript(d), tree);
});

test("MultisigScript: the encoder refuses a hash that is not 28 bytes", () => {
  assert.throws(() => multisigScriptDatum(SIG("a1a1")), /28 bytes/);
  assert.throws(() => multisigScriptDatum({ type: "script", scriptHash: "a1a1" }), /28 bytes/);
});

test("MultisigScript: the encoder refuses AllOf [] — vacuously true, a permissionless authority", () => {
  assert.throws(
    () => multisigScriptDatum({ type: "all-of", scripts: [] }),
    (err) => {
      assert.match(err.message, /empty/i);
      assert.match(err.message, /vacuous/i, "AllOf [] authorises everyone — say so");
      return true;
    }
  );
});

test("MultisigScript: the encoder refuses duplicate children", () => {
  assert.throws(
    () => multisigScriptDatum({
      type: "at-least",
      required: 2,
      scripts: [SIG(k("a1")), SIG(k("a1")), SIG(k("a2"))],
    }),
    /duplicate/i
  );
});

test("MultisigScript: the encoder refuses AtLeast with required out of range", () => {
  const scripts = [SIG(k("a1")), SIG(k("a2"))];
  assert.throws(() => multisigScriptDatum({ type: "at-least", required: 0, scripts }), /required/);
  assert.throws(() => multisigScriptDatum({ type: "at-least", required: 3, scripts }), /required/);
  // Positive control: the boundaries themselves are accepted.
  assert.ok(multisigScriptDatum({ type: "at-least", required: 1, scripts }));
  assert.ok(multisigScriptDatum({ type: "at-least", required: 2, scripts }));
});

test("MultisigScript: the encoder refuses a tree above MULTISIG_MAX_SIZE nodes", () => {
  assert.equal(MULTISIG_MAX_SIZE, 20, "upstream lib/multisig.ak's max_size, measured not guessed");

  const leaves = (n) =>
    Array.from({ length: n }, (_, i) => SIG("00".repeat(27) + i.toString(16).padStart(2, "0")));

  // MULTISIG_MAX_SIZE - 1 leaves under one node = exactly MULTISIG_MAX_SIZE nodes.
  assert.ok(multisigScriptDatum({ type: "all-of", scripts: leaves(MULTISIG_MAX_SIZE - 1) }));
  assert.throws(
    () => multisigScriptDatum({ type: "all-of", scripts: leaves(MULTISIG_MAX_SIZE) }),
    new RegExp(String(MULTISIG_MAX_SIZE))
  );
});

/**
 * ⛔ THE ASYMMETRY, ASSERTED. The encoder holds the well-formedness rail; the
 * DECODER holds none of it. A decoder that refuses an ill-formed tree cannot be
 * used to inspect one — and inspecting a live authority that somebody managed to
 * write is exactly when you need to read it.
 */
test("⛔ MultisigScript: the decoder ACCEPTS what the encoder refuses", () => {
  // Each of these three trees has its own encoder-refusal test above. The
  // decoder reads all three without complaint — deliberately. Note this test
  // calls the ENCODER on none of them: the contrast lives in the sibling tests,
  // so removing any one encoder rail reddens exactly the test that names it.
  assert.deepEqual(
    decodeMultisigScript(Data.constr(1n, [Data.list([])])),
    { type: "all-of", scripts: [] },
    "AllOf [] — vacuously true on chain, and still readable"
  );
  assert.deepEqual(
    decodeMultisigScript(Data.constr(0n, [Data.bytearray("a1a1")])),
    { type: "signature", keyHash: "a1a1" },
    "a 2-byte key hash — unsatisfiable, and still readable"
  );
  assert.deepEqual(
    decodeMultisigScript(
      Data.constr(3n, [Data.int(0n), Data.list([Data.constr(0n, [Data.bytearray(k("a1"))])])])
    ),
    { type: "at-least", required: 0, scripts: [SIG(k("a1"))] },
    "AtLeast with required 0 — permissionless, and still readable"
  );
});
