/**
 * ⛔ THE OPERATION THAT DESTROYED DATA AND THE LEDGER SAID YES.
 *
 * MEASURED ON DEVNET, 2026-09-30, twice on two independent deployments:
 * `freeze-and-seize.transfer` was asked to move a CIP-68 (100) reference token.
 * It built the transaction without complaint, the chain ACCEPTED it, and the
 * output's datum changed from
 *
 *   d8799fbf446e616d654543656c6c31…ff0101ff   the CIP-68 metadata
 *   d87980                                    Constr(0, []) — the void datum
 *
 * (txs df4db48f… and 7ee37fd2…). The metadata was gone from the live UTxO set
 * and the reference NFT sat at an address its issuer no longer controlled.
 *
 * ⚠ WHY NO TEST COULD HAVE CAUGHT IT BEFORE, which is the part worth keeping:
 * nothing failed. Not the build, not the evaluation, not the submission, not
 * the suite. The only instrument that could see it was reading the datum back
 * off the chain afterwards.
 *
 * ⛔ AND THE INDEPENDENT JAVA IMPLEMENTATION HAD THE SAME HOLE. An early report
 * said it refused this operation; checked, it did not — `Cip68.LABEL_REFERENCE`
 * existed and nothing on its transfer or seize path called it. Two
 * implementations lost the same data in two languages. That is the useful fact,
 * because it says the defect was invisible to the way BOTH were tested rather
 * than to one team's diligence.
 *
 * ⛔ WHAT THE FOUR CONTROLS ARE FOR, and why the refusals alone would be a
 * worse test than none. A guard that refuses too much converts a working
 * operation into an error, and "it threw" would read as success in both cases.
 * So every refusal here is paired with the nearest case that MUST STILL BUILD:
 * a void datum, no datum at all, and — for seize — a token that is not the
 * reference token, seized out of the very UTxO that carries the metadata.
 * `seize`'s guard is deliberately NARROWER than `transfer`'s, and control 4 is
 * the only thing that says so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCIP68FTDatum, voidData, labeledAssetName, blacklistNodeDatum } from "../dist/core/evo-utils.js";
import { isVoidDatum } from "../dist/core/evo-utils.js";
import { EvoData } from "../dist/index.js";

import {
  ASSET_NAME,
  DESTINATION,
  HOLDER,
  HarnessStop,
  OWN_NODE,
  RECIPIENT,
  REGISTRY_ADDR,
  REGISTRY_HASH,
  TARGET_INDEX,
  TARGET_TX_HASH,
  TOKEN_POLICY,
  fes,
  h,
  plb,
  run,
  utxo,
} from "./support/fes-rig.mjs";

// ---------------------------------------------------------------------------
// Fixtures: the two asset names, and the datum that was destroyed
// ---------------------------------------------------------------------------

const USER_NAME = labeledAssetName(333, ASSET_NAME);
const REF_NAME = labeledAssetName(100, ASSET_NAME);
const USER_UNIT = TOKEN_POLICY + USER_NAME;
const REF_UNIT = TOKEN_POLICY + REF_NAME;

// Pinned, not derived. `seize`'s guard keys off the (100) prefix, so if
// `labeledAssetName` ever moved, the guard would silently stop matching the
// tokens it exists for and every test below would still pass.
test("the CIP-67 labels these tests depend on are the documented ones", () => {
  assert.equal(REF_NAME.slice(0, 8), "000643b0", "(100) reference-token label");
  assert.equal(USER_NAME.slice(0, 8), "0014df10", "(333) user-token label");
});

/** The shape register actually mints: Constr0[ {metadata}, 1, 1 ]. */
const CIP68_DATUM = buildCIP68FTDatum({ name: "Cell1", description: "matrix cell", ticker: "MTX", decimals: 6 });
const CIP68_HEX = Buffer.from(EvoData.toCBORBytes(CIP68_DATUM)).toString("hex");

const REGISTRY_UTXOS = {
  [REGISTRY_ADDR]: [utxo({ address: REGISTRY_ADDR, datum: OWN_NODE, units: { [REGISTRY_HASH + TOKEN_POLICY]: 1n } })],
};

/** A sender UTxO holding the whole balance, with whatever datum is under test. */
const senderUtxo = (unit, datum) =>
  utxo({ address: plb(HOLDER), units: { [unit]: 100n }, datum, txHash: TARGET_TX_HASH, index: TARGET_INDEX });

const transferParams = (assetName) => ({
  substandardId: "freeze-and-seize",
  senderAddress: HOLDER,
  recipientAddress: RECIPIENT,
  tokenPolicyId: TOKEN_POLICY,
  assetName,
  // The WHOLE balance on purpose: with a remainder, the first payToAddress is
  // the sender's change and the control below would assert against the wrong
  // output.
  quantity: 100n,
});

const seizeParams = (assetName) => ({
  substandardId: "freeze-and-seize",
  feePayerAddress: HOLDER,
  holderAddress: HOLDER,
  destinationAddress: DESTINATION,
  tokenPolicyId: TOKEN_POLICY,
  assetName,
  utxoTxHash: TARGET_TX_HASH,
  utxoOutputIndex: TARGET_INDEX,
});

/**
 * The blacklist-spend address is derived from the FES blueprint's own
 * parameterisation, so hardcoding it would pin a fixture rather than the
 * deployment. Discovered from the plugin: with no nodes anywhere, the LAST
 * address `transfer` reads is the blacklist, and the refusal names it — both
 * asserted here, so a change in read order fails loudly instead of quietly
 * returning the wrong address.
 */
const BLACKLIST_ADDR = await (async () => {
  const result = await run(fes, "transfer", transferParams(USER_NAME), {
    ...REGISTRY_UTXOS,
    [plb(HOLDER)]: [senderUtxo(USER_UNIT, voidData())],
  });
  const last = result.getUtxos.at(-1);
  // ⚠ NOT the empty-blacklist path: the rig hands any unnamed address two plain
  // wallet UTxOs, so an unmapped blacklist address reads as two NODES rather
  // than as an empty list. The refusal that fires is the no-bracketing one, and
  // it names the same address.
  assert.match(result.error.message, /no blacklist node BRACKETS/, "discovery expects the blacklist read to be reached");
  assert.ok(last && result.error.message.includes(last), "the refusal must name the address it read");
  return last;
})();

/** A blacklist spanning the whole range: every sender has a non-membership proof. */
const BLACKLIST_UTXOS = {
  [BLACKLIST_ADDR]: [utxo({ address: BLACKLIST_ADDR, datum: blacklistNodeDatum("", "ff".repeat(30)) })],
};

const workingUtxos = (unit, datum) => ({
  ...REGISTRY_UTXOS,
  ...BLACKLIST_UTXOS,
  [plb(HOLDER)]: [senderUtxo(unit, datum)],
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test("DEFECT — transfer REFUSES an input carrying a CIP-68 metadata datum instead of erasing it", async () => {
  // ⚠ DRIVEN WITH THE (333) NAME ON PURPOSE, so this exercises the DATUM guard
  // and not the label one. With a (100) name the label refusal fires first and
  // this test would pass while saying nothing about datum loss — the two guards
  // have to be separable or neither is really tested.
  const result = await run(fes, "transfer", transferParams(USER_NAME), workingUtxos(USER_UNIT, CIP68_DATUM));

  assert.ok(result.error instanceof Error, "the transfer must be refused");
  assert.ok(!(result.error instanceof HarnessStop), "it built an output instead of refusing — the defect is back");
  assert.equal(result.payTo.length, 0, "nothing may be paid once the datum loss is detected");
  assert.match(result.error.message, /freeze-and-seize\.transfer/, "the refusal names the OPERATION");
  assert.match(result.error.message, /INLINE DATUM/, "the refusal names WHAT would be lost");
  assert.ok(result.error.message.includes(TARGET_TX_HASH), "the refusal names WHICH UTxO");
  assert.ok(result.error.message.includes(CIP68_HEX), "the refusal prints the datum it is protecting");
  assert.match(result.error.message, /\(100\) REFERENCE TOKEN/, "and names the case this was measured on");
  assert.match(result.error.message, /\(333\)/, "and the remedy: move the user token instead");
});

test("DEFECT — transfer's refusal precedes every chain read after selection", async () => {
  const result = await run(fes, "transfer", transferParams(USER_NAME), workingUtxos(USER_UNIT, CIP68_DATUM));
  assert.deepEqual(
    result.getUtxos,
    [plb(HOLDER)],
    "the sender's own UTxOs are all that may be read: the registry, params and blacklist reads are wasted work once the datum is known to be lost",
  );
});

test("DEFECT — seize REFUSES taking a (100) reference token out of the UTxO holding its metadata", async () => {
  // The devnet-measured case, now caught by the LABEL rather than by the datum:
  // seize keeps the input's datum on output 1, so what breaks here is the LINK
  // between the metadata and the asset, and the asset is what the label names.
  const result = await run(fes, "seize", seizeParams(REF_NAME), {
    ...REGISTRY_UTXOS,
    [plb(HOLDER)]: [senderUtxo(REF_UNIT, CIP68_DATUM)],
  });

  assert.ok(result.error instanceof Error, "the seizure must be refused");
  assert.ok(!(result.error instanceof HarnessStop), "it built an output instead of refusing");
  assert.equal(result.payTo.length, 0, "nothing may be paid once the reference token is recognised");
  assert.match(result.error.message, /freeze-and-seize\.seize/, "the refusal names the OPERATION");
  assert.match(result.error.message, /CIP-67 label 100/, "and why it matched");
  assert.match(result.error.message, /output 0/, "and which output would have carried it away");
});

// ---------------------------------------------------------------------------
// The controls — each names what would break if the guard over-refused
// ---------------------------------------------------------------------------

test("CONTROL 1 — transfer of a VOID-datum input still builds, targeting the recipient", async () => {
  const result = await run(fes, "transfer", transferParams(USER_NAME), workingUtxos(USER_UNIT, voidData()));
  assert.ok(result.error instanceof HarnessStop, `the ordinary transfer must still build; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(RECIPIENT)], "the whole balance moves, so the first output is the recipient's");
});

test("CONTROL 2 — transfer of an input with NO datum at all still builds", async () => {
  const result = await run(fes, "transfer", transferParams(USER_NAME), workingUtxos(USER_UNIT, undefined));
  assert.ok(result.error instanceof HarnessStop, `an absent datum is not a datum to lose; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(RECIPIENT)]);
});

// ---------------------------------------------------------------------------
// The case a datum check LETS PAST — keyed on the label instead
// ---------------------------------------------------------------------------

/**
 * ⛔ THIS WAS A CONTROL ASSERTING THE OPPOSITE, AND IT WAS WRONG. It read
 * "seize of a (100) token whose UTxO carries NO datum still builds — there is
 * no metadata left to lose", which is true about the DATUM and misses the
 * asset: moving the canonical reference NFT puts it at an address the issuer
 * does not control, and nothing afterwards restores either the metadata or the
 * custody. The independent Java implementation keys its own refusal on the
 * CIP-67 LABEL for exactly this reason, and keying on the label also removes a
 * chain read and any race against an indexer. Both guards now stand: the label
 * one closes this case, the datum one remains the broader net.
 */
test("the (100) token is refused on its LABEL even when its UTxO carries NO datum", async () => {
  for (const [op, params, utxos] of [
    ["transfer", transferParams(REF_NAME), workingUtxos(REF_UNIT, undefined)],
    ["seize", seizeParams(REF_NAME), { ...REGISTRY_UTXOS, [plb(HOLDER)]: [senderUtxo(REF_UNIT, undefined)] }],
  ]) {
    const result = await run(fes, op, params, utxos);
    assert.ok(result.error instanceof Error, `${op}: the reference token must not move`);
    assert.ok(!(result.error instanceof HarnessStop), `${op}: it built an output for the reference token`);
    assert.equal(result.payTo.length, 0, `${op}: nothing may be paid`);
    assert.match(result.error.message, /CIP-67 label 100/, `${op}: the refusal names WHY it matched`);
    assert.match(result.error.message, /REFERENCE TOKEN/, `${op}: and what the asset is`);
    assert.match(result.error.message, /does not control/, `${op}: and the custody consequence, not just the datum one`);
    assert.match(result.error.message, /\(333\)/, `${op}: and the remedy`);
  }
});

test("CONTROL 3 — the (333) USER token is NOT refused, though it is labelled too", async () => {
  // ⛔ THE WIDENING THIS FORBIDS. A guard keyed on "has a CIP-67 label" rather
  // than "has label 100" would refuse every CIP-68 transfer — a worse defect
  // than the one being fixed, and one that passes every assertion above.
  const result = await run(fes, "transfer", transferParams(USER_NAME), workingUtxos(USER_UNIT, voidData()));
  assert.ok(result.error instanceof HarnessStop, `a labelled USER token must still move; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(RECIPIENT)]);
});

test("CONTROL 4 — seize of a (333) token OUT OF the metadata UTxO is ALLOWED: seize carries the datum to output 1", async () => {
  // ⚠ THE CONTROL THAT DEFINES THE NARROWER GUARD. `seize` writes the seized
  // assets to output 0 with a void datum but carries the input's own datum onto
  // output 1, so the datum does not die here — it stays with the UTxO. Only the
  // (100) token is inseparable from it. Refusing this case would block a
  // legitimate seizure, and "it threw" would have looked like the guard working.
  const result = await run(fes, "seize", seizeParams(USER_NAME), {
    ...REGISTRY_UTXOS,
    [plb(HOLDER)]: [senderUtxo(USER_UNIT, CIP68_DATUM)],
  });
  assert.ok(result.error instanceof HarnessStop, `a non-reference seizure must still build; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(DESTINATION)]);
});

// ---------------------------------------------------------------------------
// The predicate, directly — every neighbour of Constr(0, [])
// ---------------------------------------------------------------------------

test("isVoidDatum: only Constr(0, []) is void, and ABSENT is not", () => {
  assert.equal(isVoidDatum(voidData()), true, "Constr(0, []) is the void datum");
  assert.equal(isVoidDatum(undefined), false, "no datum at all is NOT the void datum — different outputs on chain");
  assert.equal(isVoidDatum(null), false);
  assert.equal(isVoidDatum(EvoData.constr(0n, [EvoData.int(1n)])), false, "Constr(0, [x]) carries a field");
  assert.equal(isVoidDatum(EvoData.constr(1n, [])), false, "Constr(1, []) is a different constructor");
  assert.equal(isVoidDatum(CIP68_DATUM), false, "the CIP-68 metadata datum is emphatically not void");
  assert.equal(isVoidDatum(EvoData.int(0n)), false, "an integer is not a constructor");
});
