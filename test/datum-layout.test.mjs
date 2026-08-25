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
 *   ProgrammableLogicGlobalParams — SEVEN fields. Upstream's
 *                   CONTRACT_SURFACE_CHANGES.md says six in three places and in
 *                   a fourth phrases it as an instruction to build six. Six is
 *                   malformed for every programmable_logic_base spend.
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

const PARAMS = {
  registryNodeCs: "de".repeat(28),
  progLogicCred: S("a1".repeat(28)),
  transferCred: S("a2".repeat(28)),
  thirdPartyCred: S("a3".repeat(28)),
  unfrackingCred: S("a4".repeat(28)),
  upgradeCred: K("a5".repeat(28)),
  maxInlineDatumBytes: 1024n,
};

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
// ProgrammableLogicGlobalParams — 7 fields, the coordination datum
// ---------------------------------------------------------------------------

test("ProtocolParams: exactly 7 fields, in read-frequency order", () => {
  const d = protocolParamsDatum(PARAMS);
  assert.equal(d.fields.length, 7, "seven — max_inline_datum_bytes is field 6 (#115)");

  assert.equal(at(d, 0), PARAMS.registryNodeCs, "index 0 = registry_node_cs (frozen)");
  assert.equal(credAt(d, 1), PARAMS.progLogicCred.hash, "index 1 = prog_logic_cred (frozen)");
  assert.equal(credAt(d, 2), PARAMS.transferCred.hash, "index 2 = transfer_cred");
  assert.equal(credAt(d, 3), PARAMS.thirdPartyCred.hash, "index 3 = third_party_cred");
  assert.equal(credAt(d, 4), PARAMS.unfrackingCred.hash, "index 4 = unfracking_cred");
  assert.equal(credAt(d, 5), PARAMS.upgradeCred.hash, "index 5 = upgrade_cred");
  assert.equal(d.fields[6], PARAMS.maxInlineDatumBytes, "index 6 = max_inline_datum_bytes");
});

test("ProtocolParams: the three delegate credentials are NOT interchangeable", () => {
  // transfer/third_party/unfracking sit at 2/3/4 and are structurally identical.
  // programmable_logic_base dispatches on them by position, so a swap wires the
  // protocol to the wrong validator with no encoding error anywhere.
  const swapped = { ...PARAMS, transferCred: PARAMS.thirdPartyCred, thirdPartyCred: PARAMS.transferCred };
  const a = protocolParamsDatum(PARAMS);
  const b = protocolParamsDatum(swapped);
  assert.notEqual(
    hex(Data.toCBORBytes(a)),
    hex(Data.toCBORBytes(b)),
    "swapping transfer and third_party MUST change the encoded datum"
  );
  assert.equal(decodeProtocolParams(b).transferCred.hash, PARAMS.thirdPartyCred.hash);
});

test("ProtocolParams: round-trips, max_inline_datum_bytes included", () => {
  assert.deepEqual(decodeProtocolParams(protocolParamsDatum(PARAMS)), PARAMS);
});

test("ProtocolParams: a 6-field datum is REFUSED with a message naming the cause", () => {
  // The exact shape upstream's CONTRACT_SURFACE_CHANGES.md instructs a builder
  // to produce. It must not decode as a valid-but-short record.
  const six = Data.constr(0n, protocolParamsDatum(PARAMS).fields.slice(0, 6));
  assert.throws(
    () => decodeProtocolParams(six),
    (err) => {
      assert.match(err.message, /expected exactly 7 fields, got 6/);
      assert.match(err.message, /max_inline_datum_bytes/, "must name the missing field");
      return true;
    }
  );
});

test("ProtocolParams: max_inline_datum_bytes must be an integer, not a bytestring", () => {
  const bad = Data.constr(0n, [
    ...protocolParamsDatum(PARAMS).fields.slice(0, 6),
    Data.bytearray("0400"),
  ]);
  assert.throws(() => decodeProtocolParams(bad), /expected an integer/);
});
