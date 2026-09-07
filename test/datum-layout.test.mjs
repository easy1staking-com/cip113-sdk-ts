/**
 * Positional datum layouts — CIP-113 0.5.0-alpha.2.
 *
 * Both datums here are positional Constrs. Their field ORDER is the on-chain
 * contract, and getting it wrong produces a datum that encodes cleanly, decodes
 * cleanly, and means something else. Nothing in TypeScript can see it: every
 * credential field has the same shape as every other credential field.
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
 *
 *   ProgrammableLogicGlobalParams — FOUR fields in 0.5.0-alpha.3, down from
 *                   SEVEN in alpha.2, and this is a REWRITE rather than a
 *                   truncation: three fields left, one arrived, every survivor
 *                   moved. ⛔ Old index 1 was `prog_logic_cred`; new index 1 is
 *                   `transfer_cred`. BOTH ARE CREDENTIALS — so an arity-blind
 *                   positional read returns a well-formed value with the wrong
 *                   meaning, and the transaction fails much later against the
 *                   wrong delegate. The strict length check is the only thing
 *                   between those two outcomes, and there is a test below that
 *                   demonstrates the misread rather than merely asserting it.
 *
 *                   (Upstream's CONTRACT_SURFACE_CHANGES.md documented a SIX-
 *                   field intermediate on the same branch that was superseded
 *                   before merge. Do not build to it. Fields here come from the
 *                   blueprint's own definitions at f14b359.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  registryNodeDatum,
  decodeRegistryNode,
  protocolParamsDatum,
  decodeProtocolParams,
} from "../dist/core/evo-utils.js";

/** Data.bytearray() produces a Uint8Array; compare in hex, not by identity. */
const hex = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);
const at = (d, i) => hex(d.fields[i]);
const credAt = (d, i) => hex(d.fields[i].fields[0]);

const S = (h) => ({ type: "script", hash: h });
const K = (h) => ({ type: "key", hash: h });

const NODE = {
  key: "aa".repeat(28),
  next: "bb".repeat(28),
  mintingLogicScript: S("11".repeat(28)),
  transferLogicScript: S("22".repeat(28)),
  thirdPartyTransferLogicScript: S("33".repeat(28)),
  unfrackingLogicScript: S("44".repeat(28)),
  globalStateCs: "cc".repeat(28),
};

/** 0.5.0-alpha.3: FOUR fields, ordered by read frequency. */
const PARAMS = {
  plgCred: S("a1".repeat(28)),
  transferCred: S("a2".repeat(28)),
  thirdPartyCred: S("a3".repeat(28)),
  upgradeCred: K("a5".repeat(28)),
};

/**
 * The 7-field (0.5.0-alpha.2) datum, kept as a NEGATIVE fixture.
 *
 * ⚠ Note index 1 in each: `prog_logic_cred` there, `transfer_cred` here. Both
 * Credentials, both well-formed — which is exactly why a positional read of the
 * wrong layout returns a plausible value instead of failing.
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

// ---------------------------------------------------------------------------
// RegistryNode — 7 fields
// ---------------------------------------------------------------------------

test("RegistryNode: exactly 7 fields, in the on-chain order", () => {
  const d = registryNodeDatum(NODE);
  assert.ok(d instanceof Data.Constr);
  assert.equal(d.index, 0n);
  assert.equal(d.fields.length, 7, "RegistryNode is 7 fields in 0.5.0-alpha.2");

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
// ProgrammableLogicGlobalParams — 4 fields, the protocol-params datum
// ---------------------------------------------------------------------------

test("ProtocolParams: exactly 4 fields, in read-frequency order", () => {
  const d = protocolParamsDatum(PARAMS);
  assert.equal(d.fields.length, 4, "four in alpha.3 — down from seven");

  assert.equal(credAt(d, 0), PARAMS.plgCred.hash, "index 0 = plg_cred (the dispatcher)");
  assert.equal(credAt(d, 1), PARAMS.transferCred.hash, "index 1 = transfer_cred");
  assert.equal(credAt(d, 2), PARAMS.thirdPartyCred.hash, "index 2 = third_party_cred");
  assert.equal(credAt(d, 3), PARAMS.upgradeCred.hash, "index 3 = upgrade_cred");
});

test("ProtocolParams: the delegate credentials are NOT interchangeable", () => {
  // transfer and third_party sit at 1 and 2 and are structurally identical, so
  // a swap wires the protocol to the wrong validator with no encoding error.
  const swapped = { ...PARAMS, transferCred: PARAMS.thirdPartyCred, thirdPartyCred: PARAMS.transferCred };
  assert.notEqual(
    hex(Data.toCBORBytes(protocolParamsDatum(PARAMS))),
    hex(Data.toCBORBytes(protocolParamsDatum(swapped))),
    "swapping transfer and third_party MUST change the encoded datum"
  );
  assert.equal(decodeProtocolParams(protocolParamsDatum(swapped)).transferCred.hash, PARAMS.thirdPartyCred.hash);
});

test("ProtocolParams: round-trips", () => {
  assert.deepEqual(decodeProtocolParams(protocolParamsDatum(PARAMS)), PARAMS);
});

test("⛔ ProtocolParams: the 7-field alpha.2 datum is REFUSED, not read positionally", () => {
  // THE POINT OF THE STRICT ARITY CHECK. Without it, field 1 decodes cleanly as
  // a Credential — it just means prog_logic_cred instead of transfer_cred. The
  // caller would receive a well-formed record naming the wrong authority and
  // discover it at withdrawal time, against the wrong delegate.
  assert.equal(LEGACY_SEVEN_FIELD.fields.length, 7, "fixture precondition");

  assert.throws(
    () => decodeProtocolParams(LEGACY_SEVEN_FIELD),
    (err) => {
      assert.match(err.message, /expected exactly 4 fields, got 7/);
      assert.match(err.message, /NOT forward-compatible/, "must say why it cannot be read");
      assert.match(err.message, /prog_logic_cred/, "must name the field that shifted");
      return true;
    },
    "a 7-field datum belongs to an alpha.2 instance and must be refused outright"
  );
});

test("⛔ ProtocolParams: proof the silent misread is real, not theoretical", () => {
  // Read the legacy datum's index 1 the way an arity-blind parser would. It is
  // a VALID Credential — so nothing downstream could tell it was wrong.
  const shifted = LEGACY_SEVEN_FIELD.fields[1];
  assert.ok(shifted instanceof Data.Constr, "index 1 of the old layout is a well-formed Credential");
  assert.equal(
    hex(shifted.fields[0]),
    "a1".repeat(28),
    "it holds prog_logic_cred — which the new layout expects to be transfer_cred",
  );
  // And it is NOT the value the new layout would put there, so a shifted read
  // returns a different authority while looking entirely healthy.
  assert.notEqual(hex(shifted.fields[0]), PARAMS.transferCred.hash);
});

test("ProtocolParams: a short datum is refused too", () => {
  const three = Data.constr(0n, protocolParamsDatum(PARAMS).fields.slice(0, 3));
  assert.throws(() => decodeProtocolParams(three), /expected exactly 4 fields, got 3/);
});
