/**
 * Offline guards for the exported protocol bootstrap (T-D51-1).
 *
 * The devnet cannot run in CI, so these are what stand between a CI green and a
 * bootstrap that builds the wrong thing.
 *
 * ⛔ WHAT THESE PROVE, AND WHAT THEY DO NOT. Say it here rather than let a
 * reader infer coverage that is not present:
 *
 *  * PROVEN OFFLINE, against an INDEPENDENT source: the parameterisation chain
 *    reproduces a LIVE preview deployment — every script hash, every one-shot
 *    outref, every reference-input index — field for field. Those hashes came
 *    off a real chain, not off this test.
 *  * PROVEN OFFLINE: every required input is refused BY NAME when absent,
 *    empty, or of the wrong kind; the plan is deterministic; and each build
 *    step assembles the inputs, mints, outputs, certificates and script
 *    witnesses it claims to.
 *  * NOT PROVEN HERE: that the CBOR those steps produce is accepted by a
 *    ledger. The steps are driven through a RECORDING STUB client, so what is
 *    asserted is the operation sequence handed to Evolution's builder — not
 *    Evolution's output. Chain-level proof is `npm run test:devnet`, which runs
 *    this same export through the harness against a live chain. A stub is an
 *    instrument pointed at our call sites; do not read it as pointed at a node.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Assets as EvoAssets,
  Address as EvoAddress,
  Bytes,
  Data,
  InlineDatum,
  UPLC,
  Transaction as EvoTransaction,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";

import {
  planBootstrap,
  buildSeedTx,
  selectBootstrapSeeds,
  buildMultisigGenesisTx,
  assertMultisigConfigUtxo,
  buildProtocolGenesisTx,
  buildReferenceScriptsTx,
  buildStakeRegistrationTx,
  assembleDeploymentParams,
  assertDeploymentScripts,
  buildEvoScript,
  multisigScriptDatum,
  createStandardScripts,
  ISSUANCE_SPLICE_MARKER,
  MAX_NEXT,
  outputAssets,
  scriptAddress,
  UNFRACKING_DISABLED,
  BOOTSTRAP_SEED_COUNT,
  BOOTSTRAP_STEPS,
  REFERENCE_SCRIPT_ORDER,
  STAKE_REGISTRATION_ORDER,
} from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const BLUEPRINT = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
const PIN = load("blueprints/standard/v0.5.0-alpha.4/UPSTREAM_PIN.json");

/**
 * The LIVE preview alpha.4 record — an INDEPENDENT source, not a fixture this
 * file derived a moment ago.
 *
 * ⚑ `deployment-assertion.test.mjs` already documents the failure this avoids:
 * a fixture whose every hash the test itself derived asserts against itself and
 * passes no matter how wrong the parameterisation is. These hashes are on a
 * chain.
 */
const REAL = load("deployments/preview/alpha4-7e8a631.json");

/** The PLG hash the live preview instance actually deployed. ⛔ If this moves, STOP. */
const REAL_PLG = "d599d56f944d33a90b16f561ee61f183a4ba3c9185f2d779e0d356f4";

/**
 * The nonce the preview deployment was bootstrapped with.
 *
 * ⚠ It lives in the devnet harness, which `deploy-preview.ts` drives — so it is
 * an INPUT to the reproduction below, not an output of it. Without it the chain
 * cannot be reproduced at all: `always_fail`'s hash feeds `issuance_cbor_hex_
 * mint`, which feeds `registry`, which feeds all three delegates, which feed the
 * dispatcher.
 */
const PREVIEW_NONCE = "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

/** The config that reproduces the live preview instance. */
const previewConfig = (overrides = {}) => ({
  blueprint: BLUEPRINT,
  networkId: 0,
  seeds: {
    protocolParams: REAL.protocolParams.txInput,
    issuance: REAL.issuance.txInput,
    upgradeMultisig: REAL.upgradeMultisig.txInput,
  },
  alwaysFailNonce: PREVIEW_NONCE,
  maxInlineDatumBytes: BigInt(REAL.maxInlineDatumBytes),
  unfracking: "enabled",
  ...overrides,
});

// ---------------------------------------------------------------------------
// THE GENESIS DATUMS, BUILT FROM SOURCES THAT ARE NOT `planBootstrap` (F-2)
// ---------------------------------------------------------------------------
//
// ⛔ WHY THIS SECTION EXISTS, AND IT IS THIS REPO'S OLDEST TRAP WEARING A NEW
// FACE. Round 1 asserted the genesis datums against `plan.datums.*` — the
// output of the very function under test. That is a self-comparison, and the
// audit measured what it cost: TWO mutations inside `planBootstrap` survived
// the whole offline suite GREEN.
//
//   * swapping `issuanceLogicCred` with `transferCred` in the params datum —
//     the exact defect the module's own comment warns about. Both are
//     `Credential`, both 28 bytes; the datum has the right arity, passes
//     `params_wellformed`, decodes into a well-formed record, and hands
//     `issuance_mint` the TRANSFER credential as its issuance authority.
//     Nothing at deploy time catches it.
//   * moving the registry sentinel `next` by ONE BYTE, from ff×30 to
//     ff×29 + fe. The origin node then claims a successor that does not exist.
//
// Both are caught on devnet. CI never runs devnet.
//
// ⇒ Every expectation below is built from the LIVE preview record's own named
// fields, or from the blueprint, or from a literal written here — and none of
// them from `planBootstrap`. The constructors are raw `Data.constr` rather than
// this package's `protocolParamsDatum` / `registryNodeDatum` encoders, so a
// swap inside an ENCODER cannot move both sides together either.

/** Aiken `Credential`: VerificationKey is constructor 0, Script is constructor 1. */
const scriptCred = (hash) => Data.constr(1n, [Data.bytearray(hash)]);
const keyCred = (hash) => Data.constr(0n, [Data.bytearray(hash)]);

/**
 * The params datum, FIELD BY FIELD FROM THE LIVE RECORD, in upstream's order.
 *
 * ⛔ THE INDEX COMMENTS ARE THE ASSERTION. alpha.4 INSERTED `issuance_logic_cred`
 * at index 1 and displaced `transfer_cred` to index 2. Reading the record's
 * fields BY NAME and placing them BY INDEX here is what makes a swap inside
 * `planBootstrap` visible: `issuanceLogic.scriptHash` and `transfer.scriptHash`
 * are different 28-byte values on a real chain.
 */
const EXPECTED_PARAMS_DATUM = Data.constr(0n, [
  scriptCred(REAL.programmableLogicGlobal.scriptHash), // 0 plg_cred
  scriptCred(REAL.issuanceLogic.scriptHash), //            1 issuance_logic_cred  (INSERTED in alpha.4)
  scriptCred(REAL.transfer.scriptHash), //                 2 transfer_cred        (displaced from 1)
  scriptCred(REAL.thirdParty.scriptHash), //               3 third_party_cred
  scriptCred(REAL.upgradeMultisig.scriptHash), //          4 upgrade_cred
  Data.constr(1n, []), //                                  5 pending_upgrade_cred = None at genesis
]);

/**
 * The registry origin node — a literal fixture, because no deployment record
 * carries it. Stated rather than pinned against itself: the sentinel head is
 * key "", next 0xff×30, every delegate slot empty, no global state.
 *
 * ⚑ The sentinel is cross-checked against the SDK's exported `MAX_NEXT` below,
 * so this literal is not the only place that value lives.
 */
const EXPECTED_ORIGIN_DATUM = Data.constr(0n, [
  Data.bytearray(""), //               0 key — the sentinel head has none
  Data.bytearray("ff".repeat(30)), //  1 next — the maximum, so nothing sorts after it
  keyCred(""), //                      2 minting_logic_script   (INSERTED, #52)
  keyCred(""), //                      3 transfer_logic_script
  keyCred(""), //                      4 third_party_transfer_logic_script
  keyCred(""), //                      5 unfracking_logic_script (INSERTED, unfracking v2)
  Data.bytearray(""), //               6 global_state_cs
]);

/**
 * The issuance-CBOR datum, SPLICED INDEPENDENTLY FROM THE BLUEPRINT.
 *
 * ⚑ MEASURED, and it is what makes this pin possible: the `pre`/`post` halves
 * do NOT depend on the marker's VALUE. Applying two different markers to
 * `issuance_mint` yields byte-identical halves (688 B and 37 B), because the
 * argument occupies the same bit positions either way. So this file can choose
 * its OWN marker, re-derive the split straight from the blueprint via
 * `createStandardScripts`, and never touch `planBootstrap`'s copy.
 */
const TEST_MARKER = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c";

function scriptBodyHex(compiledCode) {
  if (UPLC.getCborEncodingLevel(compiledCode) !== "double") return compiledCode;
  const raw = Bytes.fromHex(compiledCode);
  const additionalInfo = raw[0] & 0x1f;
  const headerLen =
    additionalInfo < 24 ? 1 : additionalInfo === 24 ? 2 : additionalInfo === 25 ? 3 : 5;
  return Bytes.toHex(raw.slice(headerLen));
}

const INDEPENDENT_SPLICE = scriptBodyHex(
  createStandardScripts(BLUEPRINT)
    .issuanceMint(TEST_MARKER, REAL.protocolParams.policyId)
    .compiledCode
).split(TEST_MARKER);

const EXPECTED_ISSUANCE_DATUM = Data.constr(0n, [
  Data.bytearray(INDEPENDENT_SPLICE[0]),
  Data.bytearray(INDEPENDENT_SPLICE[1]),
]);

test("PIN: the three genesis datums, against sources that are NOT planBootstrap", () => {
  const plan = planBootstrap(previewConfig());

  // ⛔ THE ONE WITH A PATH TO A PUBLISHED DEFECT. Field 1 is issuance_logic and
  // field 2 is transfer; swapping them deploys, verifies and bricks issuance.
  assert.deepEqual(
    plan.datums.protocolParams,
    EXPECTED_PARAMS_DATUM,
    "the params datum no longer matches the credentials the LIVE preview deployment recorded, " +
      "in upstream's field order"
  );

  assert.deepEqual(
    plan.datums.registryOrigin,
    EXPECTED_ORIGIN_DATUM,
    "the registry origin node's sentinel head moved"
  );
  // The sentinel has a second home in the SDK; a literal that only this file
  // knows is a literal nobody can check.
  assert.equal(MAX_NEXT, "ff".repeat(30));

  assert.deepEqual(
    plan.datums.issuanceCborHex,
    EXPECTED_ISSUANCE_DATUM,
    "the issuance CBOR splice no longer reproduces from the blueprint"
  );
  // ⚠ MEASURED per artefact, never assumed — flat UPLC is BIT-packed and the
  // parameter is only findable as whole bytes when it lands on a byte boundary.
  assert.equal(INDEPENDENT_SPLICE.length, 2, "the marker must occur exactly once");
  assert.equal(INDEPENDENT_SPLICE[0].length / 2, 688, "prefix bytes");
  assert.equal(INDEPENDENT_SPLICE[1].length / 2, 37, "postfix bytes");

  // ⛔ THE MARKER MUST NOT SURVIVE INTO WHAT SHIPS. It is a cutting guide, and
  // the datum written on chain is the two halves with it gone from between
  // them — so if it appears in either half, a placeholder really would be
  // deployed and the whole justification for a fixed hex marker collapses.
  assert.ok(!plan.issuanceCbor.pre.includes(ISSUANCE_SPLICE_MARKER), "marker leaked into pre");
  assert.ok(!plan.issuanceCbor.post.includes(ISSUANCE_SPLICE_MARKER), "marker leaked into post");
  assert.equal(ISSUANCE_SPLICE_MARKER.length, 56, "28 bytes, the shape of a script hash");
});

test("PIN: the splice halves do not depend on the marker's VALUE — which is what licenses the pin above", () => {
  const other = "aa".repeat(28);
  assert.notEqual(other, TEST_MARKER);
  const halves = scriptBodyHex(
    createStandardScripts(BLUEPRINT).issuanceMint(other, REAL.protocolParams.policyId).compiledCode
  ).split(other);
  assert.equal(halves.length, 2);
  assert.deepEqual(halves, INDEPENDENT_SPLICE, "two markers, byte-identical halves");
});

// ---------------------------------------------------------------------------
// THE PIN — the chain is the second operand
// ---------------------------------------------------------------------------

test("PIN: the plan reproduces the live preview dispatcher hash", () => {
  const plan = planBootstrap(previewConfig());
  assert.equal(
    plan.scripts.programmableLogicGlobal.hash,
    REAL_PLG,
    "the dispatcher hash moved — the parameterisation chain, an argument order, or an " +
      "encoding changed. This pin is a hash that is on chain, not one this file derived."
  );
  assert.equal(plan.unfrackingParameter, REAL.programmableLogicGlobal.unfrackingParameter);
});

test("PIN: every script the plan derives matches the live preview deployment", () => {
  const plan = planBootstrap(previewConfig());
  const s = plan.scripts;
  assert.equal(s.alwaysFail.hash, REAL.issuance.alwaysFailScriptHash);
  assert.equal(s.protocolParams.hash, REAL.protocolParams.policyId);
  assert.equal(s.programmableLogicBase.hash, REAL.programmableLogicBase.scriptHash);
  assert.equal(s.issuanceCborHexMint.hash, REAL.issuance.policyId);
  assert.equal(s.registry.hash, REAL.registry.scriptHash);
  assert.equal(s.transfer.hash, REAL.transfer.scriptHash);
  assert.equal(s.thirdParty.hash, REAL.thirdParty.scriptHash);
  assert.equal(s.unfracking.hash, REAL.unfracking.scriptHash);
  assert.equal(s.programmableLogicGlobal.hash, REAL.programmableLogicGlobal.scriptHash);
  assert.equal(s.issuanceLogic.hash, REAL.issuanceLogic.scriptHash);
  assert.equal(s.upgradeMultisig.hash, REAL.upgradeMultisig.scriptHash);
});

test("PIN: assembleDeploymentParams reproduces the live preview record field for field", () => {
  const plan = planBootstrap(previewConfig());
  const assembled = assembleDeploymentParams(plan, {
    protocolGenesisTxHash: REAL.txHash,
    referenceScriptsTxHash: REAL.programmableBaseRefInput.txHash,
    multisigConfigUtxo: REAL.upgradeMultisig.utxo,
  });
  // ⚑ THE WHOLE RECORD, not a selection. Every reference-input index, every
  // one-shot outref, the unfracking parameter and the upgrade authority — all
  // of it has to come out the same as a record written by a real bootstrap.
  assert.deepEqual(JSON.parse(JSON.stringify(assembled)), REAL);

  // And it verifies against the blueprint by the SDK's own derivation check.
  const checks = assertDeploymentScripts(BLUEPRINT, assembled);
  assert.equal(checks.length, 10, "the check list must not shrink");
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
});

// ---------------------------------------------------------------------------
// Determinism, and sensitivity to each input
// ---------------------------------------------------------------------------

test("the plan is deterministic: the same config twice gives identical hashes", () => {
  const a = planBootstrap(previewConfig());
  const b = planBootstrap(previewConfig());
  assert.deepEqual(
    Object.fromEntries(Object.entries(a.scripts).map(([k, v]) => [k, v.hash])),
    Object.fromEntries(Object.entries(b.scripts).map(([k, v]) => [k, v.hash]))
  );
  assert.deepEqual(a.addresses, b.addresses);
  assert.deepEqual(a.assetUnits, b.assetUnits);
  // Resumption rests on exactly this: persist the config, rebuild the plan.
  assert.equal(a.issuanceCbor.pre, b.issuanceCbor.pre);
  assert.equal(a.issuanceCbor.post, b.issuanceCbor.post);
});

test("SENSITIVITY: the always_fail nonce reaches the dispatcher", () => {
  // ⚑ If this did NOT move, the nonce would not be reaching the script and the
  // PIN above would be proving something about a constant rather than a chain.
  const moved = planBootstrap(previewConfig({ alwaysFailNonce: "00".repeat(32) }));
  assert.notEqual(moved.scripts.alwaysFail.hash, REAL.issuance.alwaysFailScriptHash);
  assert.notEqual(moved.scripts.programmableLogicGlobal.hash, REAL_PLG);
});

test("SENSITIVITY: maxInlineDatumBytes is baked into the delegates and the dispatcher", () => {
  const moved = planBootstrap(previewConfig({ maxInlineDatumBytes: 512n }));
  assert.notEqual(moved.scripts.transfer.hash, REAL.transfer.scriptHash);
  assert.notEqual(moved.scripts.thirdParty.hash, REAL.thirdParty.scriptHash);
  assert.notEqual(moved.scripts.unfracking.hash, REAL.unfracking.scriptHash);
  assert.notEqual(moved.scripts.issuanceLogic.hash, REAL.issuanceLogic.scriptHash);
  assert.notEqual(
    moved.scripts.programmableLogicGlobal.hash,
    REAL_PLG,
    "two deployments differing only in this security parameter are DIFFERENT protocols"
  );
});

test("SENSITIVITY: each seed reaches only the one-shot policy it belongs to", () => {
  const other = { txHash: "11".repeat(32), outputIndex: 7 };
  const base = planBootstrap(previewConfig());

  const movedParams = planBootstrap(
    previewConfig({ seeds: { ...previewConfig().seeds, protocolParams: other } })
  );
  assert.notEqual(movedParams.scripts.protocolParams.hash, base.scripts.protocolParams.hash);
  assert.notEqual(movedParams.scripts.registry.hash, base.scripts.registry.hash);
  assert.equal(movedParams.scripts.upgradeMultisig.hash, base.scripts.upgradeMultisig.hash);

  const movedMultisig = planBootstrap(
    previewConfig({ seeds: { ...previewConfig().seeds, upgradeMultisig: other } })
  );
  // ⛔ THE VACUITY TRAP, INVERTED INTO AN ASSERTION. protocolParams.txInput and
  // upgradeMultisig.txInput are the same type and are NOT interchangeable; if
  // moving one moved the other's script, the derivation check could not tell
  // which field the code read.
  assert.notEqual(
    movedMultisig.scripts.upgradeMultisig.hash,
    base.scripts.upgradeMultisig.hash
  );
  assert.equal(movedMultisig.scripts.protocolParams.hash, base.scripts.protocolParams.hash);
});

test("SENSITIVITY: the unfracking choice is a different protocol, and only the dispatcher moves", () => {
  const disabled = planBootstrap(previewConfig({ unfracking: "disabled" }));
  assert.equal(disabled.unfrackingParameter, UNFRACKING_DISABLED);
  assert.notEqual(disabled.scripts.programmableLogicGlobal.hash, REAL_PLG);
  // Unfracking stays DEPLOYED — deployed and unreachable are different facts,
  // and a record legitimately carries both.
  assert.equal(disabled.scripts.unfracking.hash, REAL.unfracking.scriptHash);
  assert.equal(disabled.scripts.transfer.hash, REAL.transfer.scriptHash);
});

test("SENSITIVITY: networkId changes every derived address and no script hash", () => {
  const base = planBootstrap(previewConfig());
  const mainnet = planBootstrap(previewConfig({ networkId: 1 }));
  assert.notEqual(mainnet.addresses.protocolParams, base.addresses.protocolParams);
  assert.notEqual(mainnet.addresses.registry, base.addresses.registry);
  assert.equal(mainnet.scripts.protocolParams.hash, base.scripts.protocolParams.hash);
});

// ---------------------------------------------------------------------------
// The orders, which are one fact each
// ---------------------------------------------------------------------------

test("the reference-script order and the stake-registration order are what the record derives from", () => {
  assert.deepEqual([...REFERENCE_SCRIPT_ORDER], [
    "programmableLogicBase",
    "programmableLogicGlobal",
    "transfer",
    "thirdParty",
    "unfracking",
    "issuanceLogic",
    "upgradeMultisig",
  ]);
  // ⛔ APPENDED, NEVER INSERTED: indices 0..4 are where the alpha.3 deployments
  // put them, and a live record's reference inputs are read by those numbers.
  assert.equal(REFERENCE_SCRIPT_ORDER.indexOf("programmableLogicBase"), 0);
  assert.equal(REFERENCE_SCRIPT_ORDER.indexOf("upgradeMultisig"), 6);
  assert.deepEqual([...STAKE_REGISTRATION_ORDER], [
    "programmableLogicGlobal",
    "transfer",
    "thirdParty",
    "unfracking",
    "issuanceLogic",
    "upgradeMultisig",
  ]);
  assert.equal(STAKE_REGISTRATION_ORDER.length, 6, "six withdraw-0 credentials, not four");
  assert.equal(BOOTSTRAP_SEED_COUNT, 3);
  assert.deepEqual([...BOOTSTRAP_STEPS], [
    "seed",
    "multisig-genesis",
    "protocol-genesis",
    "reference-scripts",
    "stake-registrations",
  ]);
});

// ---------------------------------------------------------------------------
// Required inputs — refused BY NAME
// ---------------------------------------------------------------------------

/** Assert `fn` throws and the message NAMES the field, not merely that it threw. */
function refusesNaming(fn, needle, what) {
  let err;
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => assert.fail(`${what}: expected a refusal, got a value`),
      (e) => assert.match(String(e.message), needle, `${what}: refused, but not by name`)
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${what}: expected a refusal, got a value`);
  assert.match(String(err.message), needle, `${what}: refused, but not by name`);
  return undefined;
}

test("REFUSAL: alwaysFailNonce absent or malformed, by name", () => {
  refusesNaming(
    () => planBootstrap(previewConfig({ alwaysFailNonce: undefined })),
    /alwaysFailNonce/,
    "absent"
  );
  refusesNaming(
    () => planBootstrap(previewConfig({ alwaysFailNonce: "" })),
    /alwaysFailNonce/,
    "empty"
  );
  refusesNaming(
    () => planBootstrap(previewConfig({ alwaysFailNonce: "zz" })),
    /alwaysFailNonce/,
    "not hex"
  );
  refusesNaming(
    () => planBootstrap(previewConfig({ alwaysFailNonce: "abc" })),
    /alwaysFailNonce/,
    "odd length"
  );
});

test("REFUSAL: maxInlineDatumBytes absent, zero, or not a bigint, by name", () => {
  for (const [value, what] of [
    [undefined, "absent"],
    [0n, "zero"],
    [-1n, "negative"],
    [1024, "a number, not a bigint"],
  ]) {
    refusesNaming(
      () => planBootstrap(previewConfig({ maxInlineDatumBytes: value })),
      /maxInlineDatumBytes/,
      what
    );
  }
});

test("REFUSAL: the unfracking choice absent or misspelled, by name", () => {
  for (const [value, what] of [
    [undefined, "absent"],
    [true, "a boolean"],
    ["ENABLED", "wrong case"],
    ["on", "misspelled"],
  ]) {
    refusesNaming(
      () => planBootstrap(previewConfig({ unfracking: value })),
      /unfracking/,
      what
    );
  }
});

test("REFUSAL: networkId absent or non-integer, by name", () => {
  // ⛔ THE NEEDLE IS OUR OWN WORDING, NOT THE BARE FIELD NAME, AND THE MUTATION
  // RUN IS WHY. With `/networkId/` this test passed WITH THE GUARD DELETED:
  // Evolution's own `EnterpriseAddress` constructor error happens to contain the
  // word "networkId", so the assertion matched a downstream failure and the arm
  // that removed the guard reddened nothing. A refusal test whose needle any
  // other error can satisfy is not testing the refusal.
  const ours = /networkId is required and must be an integer/;
  refusesNaming(() => planBootstrap(previewConfig({ networkId: undefined })), ours, "absent");
  refusesNaming(() => planBootstrap(previewConfig({ networkId: "0" })), ours, "a string");
  refusesNaming(() => planBootstrap(previewConfig({ networkId: 0.5 })), ours, "fractional");
});

test("REFUSAL: seeds absent, malformed, or NOT DISTINCT, by name", () => {
  refusesNaming(() => planBootstrap(previewConfig({ seeds: undefined })), /seeds/, "absent");
  refusesNaming(
    () => planBootstrap(previewConfig({ seeds: { ...previewConfig().seeds, issuance: undefined } })),
    /seeds\.issuance/,
    "one missing"
  );
  refusesNaming(
    () =>
      planBootstrap(
        previewConfig({
          seeds: { ...previewConfig().seeds, issuance: { txHash: "ab", outputIndex: 0 } },
        })
      ),
    /seeds\.issuance\.txHash/,
    "short tx hash"
  );
  refusesNaming(
    () =>
      planBootstrap(
        previewConfig({
          seeds: { ...previewConfig().seeds, issuance: { txHash: "aa".repeat(32), outputIndex: -1 } },
        })
      ),
    /seeds\.issuance\.outputIndex/,
    "negative index"
  );
  // ⛔ THE ONE THAT MATTERS. Two roles on one outref deploys perfectly well and
  // makes the off-chain derivation check for the shared pair VACUOUS.
  refusesNaming(
    () =>
      planBootstrap(
        previewConfig({
          seeds: {
            ...previewConfig().seeds,
            upgradeMultisig: previewConfig().seeds.protocolParams,
          },
        })
      ),
    /seeds\.protocolParams and seeds\.upgradeMultisig are the SAME output reference/,
    "conflated seeds"
  );
});

test("REFUSAL: a blueprint with no publish handlers cannot bootstrap, and says which are missing", () => {
  const crippled = structuredClone(BLUEPRINT);
  crippled.validators = crippled.validators.filter((v) => v.title !== "transfer.transfer.publish");
  refusesNaming(
    () => planBootstrap(previewConfig({ blueprint: crippled })),
    /transfer\.transfer\.publish/,
    "missing publish handler"
  );
});

// ---------------------------------------------------------------------------
// A recording stub — see the header for exactly what this can and cannot show
// ---------------------------------------------------------------------------

/** A minimal, valid transaction. The stub returns this so `finish` can serialise. */
const PLACEHOLDER_TX = EvoTransaction.fromCBORHex("84a3008001800200a0f5f6");

function recorder({ coinsPerUtxoByte = 4310n, maxTxSize = 16384, txHash = "cc".repeat(32) } = {}) {
  const ops = [];
  const record = (name) => (params) => {
    ops.push({ op: name, params });
    return builder;
  };
  const builder = {
    payToAddress: record("payToAddress"),
    collectFrom: record("collectFrom"),
    mintAssets: record("mintAssets"),
    attachScript: record("attachScript"),
    attachMetadata: record("attachMetadata"),
    registerStake: record("registerStake"),
    async build(options) {
      ops.push({ op: "build", params: options });
      return {
        async toTransaction() {
          return PLACEHOLDER_TX;
        },
        chainResult() {
          return { txHash, consumed: [], available: [] };
        },
      };
    },
  };
  const client = {
    chain: { id: 0 },
    newTx: () => builder,
    async getProtocolParameters() {
      return { coinsPerUtxoByte, maxTxSize };
    },
  };
  return { ops, client, only: (name) => ops.filter((o) => o.op === name) };
}

/** Asset units other than lovelace — `getUnits` lists a zero lovelace entry. */
const units = (assets) => EvoAssets.getUnits(assets).filter((u) => u !== "lovelace");

/** Evolution hands back raw bytes for a credential hash. */
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A real, well-formed testnet address — DERIVED, never typed. A hand-written
 * bech32 fails its checksum and the refusal reads as a builder defect. */
const WALLET = scriptAddress(0, "ab".repeat(28));
const TREE = { type: "signature", keyHash: "ab".repeat(28) };

/** A UTxO fixture the export's seed check and datum reader both accept. */
function fakeUtxo({ txHash, outputIndex, assets = outputAssets(5_000_000n), datum }) {
  return {
    transactionId: EvoTransactionHash.fromHex(txHash),
    index: outputIndex,
    address: EvoAddress.fromBech32(WALLET),
    assets,
    ...(datum ? { datumOption: new InlineDatum.InlineDatum({ data: datum }) } : {}),
  };
}

const seedUtxos = (plan) => ({
  protocolParams: fakeUtxo({ ...plan.config.seeds.protocolParams }),
  issuance: fakeUtxo({ ...plan.config.seeds.issuance }),
  upgradeMultisig: fakeUtxo({ ...plan.config.seeds.upgradeMultisig }),
});

const ctx = (client, available) => ({
  client,
  changeAddress: WALLET,
  availableUtxos: available ?? [fakeUtxo({ txHash: "ee".repeat(32), outputIndex: 0 })],
});

// ---------------------------------------------------------------------------
// Each step builds the transaction it claims to
// ---------------------------------------------------------------------------

test("STEP 1 seed: three outputs of exactly seedLovelace, to the owner", async () => {
  const { ops, client, only } = recorder();
  const result = await buildSeedTx({
    ...ctx(client),
    ownerAddress: WALLET,
    seedLovelace: 5_000_000n,
  });
  const pays = only("payToAddress");
  assert.equal(pays.length, BOOTSTRAP_SEED_COUNT, "three seeds, not two — a later step needs all three");
  for (const p of pays) {
    assert.equal(EvoAddress.toBech32(p.params.address), WALLET);
    assert.equal(EvoAssets.lovelaceOf(p.params.assets), 5_000_000n);
  }
  assert.equal(only("collectFrom").length, 0, "the seed step collects nothing explicitly");
  assert.equal(result.metadata.step, "seed");
  assert.equal(ops.at(-1).op, "build");
  // The caller's UTxO reservation reaches Evolution verbatim.
  assert.equal(ops.at(-1).params.availableUtxos.length, 1);
});

test("STEP 2 multisig-genesis: consumes its seed, mints ONE NFT, locks it with the tree", async () => {
  const plan = planBootstrap(previewConfig());
  const { client, only } = recorder();
  const seeds = seedUtxos(plan);
  await buildMultisigGenesisTx({
    ...ctx(client),
    plan,
    seedUtxo: seeds.upgradeMultisig,
    upgradeMultisigTree: TREE,
  });

  const collected = only("collectFrom");
  assert.equal(collected.length, 1);
  assert.equal(
    EvoTransactionHash.toHex(collected[0].params.inputs[0].transactionId),
    plan.config.seeds.upgradeMultisig.txHash,
    "the one-shot outref the policy is parameterised by, and no other"
  );

  const mints = only("mintAssets");
  assert.equal(mints.length, 1);
  assert.deepEqual(units(mints[0].params.assets), [plan.assetUnits.upgradeMultisigNft]);

  const pays = only("payToAddress");
  assert.equal(pays.length, 1, "⛔ THE NFT AND NOTHING ELSE — no decoy, no extra output");
  assert.equal(EvoAddress.toBech32(pays[0].params.address), plan.addresses.upgradeMultisig);
  assert.deepEqual(
    units(pays[0].params.assets),
    [plan.assetUnits.upgradeMultisigNft]
  );
  // Solved, not flat, and pinned: computed from this datum's own serialised size.
  assert.equal(EvoAssets.lovelaceOf(pays[0].params.assets), 2_000_000n);
  assert.deepEqual(pays[0].params.datum.data, multisigScriptDatum(TREE));
  assert.equal(pays[0].params.script, undefined, "rail 4 requires reference_script == None");

  const scripts = only("attachScript");
  assert.equal(scripts.length, 1);
  assert.deepEqual(
    scripts[0].params.script,
    buildEvoScript(plan.scripts.upgradeMultisig.compiledCode)
  );
});

test("STEP 2 REFUSAL: a seed that is not the one the plan was parameterised by, by name", async () => {
  const plan = planBootstrap(previewConfig());
  const { client } = recorder();
  await refusesNaming(
    () =>
      buildMultisigGenesisTx({
        ...ctx(client),
        plan,
        seedUtxo: fakeUtxo({ txHash: "99".repeat(32), outputIndex: 4 }),
        upgradeMultisigTree: TREE,
      }),
    /upgradeMultisig seed UTxO is 9999.*but this plan was parameterised by/s,
    "wrong seed"
  );
});

test("STEP 2 REFUSAL: no signer tree, by name", async () => {
  const plan = planBootstrap(previewConfig());
  const { client } = recorder();
  await refusesNaming(
    () =>
      buildMultisigGenesisTx({
        ...ctx(client),
        plan,
        seedUtxo: seedUtxos(plan).upgradeMultisig,
        upgradeMultisigTree: undefined,
      }),
    /upgradeMultisigTree is required/,
    "absent tree"
  );
});

test("STEP 3 protocol-genesis: two seeds in, three mints, three state outputs, three witnesses", async () => {
  const plan = planBootstrap(previewConfig());
  const { client, only } = recorder();
  const seeds = seedUtxos(plan);
  const result = await buildProtocolGenesisTx({
    ...ctx(client),
    plan,
    protocolParamsSeedUtxo: seeds.protocolParams,
    issuanceSeedUtxo: seeds.issuance,
  });

  const collected = only("collectFrom");
  assert.equal(collected.length, 1);
  assert.deepEqual(
    collected[0].params.inputs.map((u) => EvoTransactionHash.toHex(u.transactionId) + "#" + u.index),
    [
      `${plan.config.seeds.protocolParams.txHash}#${plan.config.seeds.protocolParams.outputIndex}`,
      `${plan.config.seeds.issuance.txHash}#${plan.config.seeds.issuance.outputIndex}`,
    ]
  );

  const mints = only("mintAssets");
  assert.equal(mints.length, 3);
  assert.deepEqual(
    mints.map((m) => units(m.params.assets)[0]),
    [plan.assetUnits.registryNode, plan.assetUnits.protocolParamsNft, plan.assetUnits.issuanceCborHexNft]
  );

  // ⛔ THE OUTPUT INDICES ARE POSITIONAL and assembleDeploymentParams reads
  // output 0 as the params UTxO. A reorder here moves a reference nothing checks.
  const pays = only("payToAddress");
  assert.equal(pays.length, 3);
  assert.deepEqual(pays.map((p) => EvoAddress.toBech32(p.params.address)), [
    plan.addresses.protocolParams,
    plan.addresses.registry,
    plan.addresses.issuanceCborHex,
  ]);
  // ⛔ AGAINST THE INDEPENDENT EXPECTATIONS, NOT AGAINST `plan.datums.*`. The
  // round-1 version compared the transaction's datum to the plan that produced
  // it, so a swap inside planBootstrap moved both sides together and this
  // assertion could not fail. See the F-2 section at the top of this file.
  assert.deepEqual(pays[0].params.datum.data, EXPECTED_PARAMS_DATUM);
  assert.deepEqual(pays[1].params.datum.data, EXPECTED_ORIGIN_DATUM);
  assert.deepEqual(pays[2].params.datum.data, EXPECTED_ISSUANCE_DATUM);
  // ⛔ PINNED EXACTLY, AND A MUTATION RUN IS WHY. An earlier version asserted
  // only that the issuance output carried MORE than the params output — which
  // stayed true under an arm that solved the wrong output entirely, so the arm
  // reddened nothing and the assertion was decorative. These three figures are
  // a deterministic function of the stub's coinsPerUtxoByte (4310) and each
  // output's own datum, so they move exactly when the arithmetic or a datum
  // layout moves — which is the only time anyone wants to be told.
  //
  // ⚠ SOLVED, NEVER FLAT. The issuance output carries the whole spliced
  // issuance_mint body, so its floor is an order of magnitude above the others'.
  // The harness used to write a flat 15 ADA here: a guess, ~10.6 ADA too high,
  // and one that would have been silently too LOW had the datum grown instead.
  //
  // ⛔ AND ROUNDED UP TO A WHOLE ADA (F-7). The solve returns the EXACT minimum
  // — 4,361,720 for the issuance output — and exact is the wrong side of the
  // line for an IRREVERSIBLE step whose figure depends on an encoder this
  // package does not own. A one-byte widening in Evolution's `TxOut` encoding
  // under-funds the output by `coinsPerUtxoByte` and the ledger answers
  // "insufficient Ada", pointing at the wallet rather than at the encoder.
  assert.equal(EvoAssets.lovelaceOf(pays[0].params.assets), 2_000_000n, "params output");
  assert.equal(EvoAssets.lovelaceOf(pays[1].params.assets), 3_000_000n, "registry origin");
  assert.equal(
    EvoAssets.lovelaceOf(pays[2].params.assets),
    5_000_000n,
    "issuance CBOR output: 4,361,720 solved, ceiled to a whole ADA"
  );

  assert.deepEqual(
    only("attachScript").map((s) => s.params.script),
    [
      buildEvoScript(plan.scripts.registry.compiledCode),
      buildEvoScript(plan.scripts.protocolParams.compiledCode),
      buildEvoScript(plan.scripts.issuanceCborHexMint.compiledCode),
    ]
  );
  assert.equal(only("attachMetadata").length, 0, "no pin passed, so no CIP-171 metadata");
  assert.deepEqual(result.metadata.outputIndices, {
    protocolParams: 0,
    registryOrigin: 1,
    issuanceCborHex: 2,
  });
});

test("STEP 3: a provenance pin attaches a CIP-171 record under label 1984", async () => {
  const plan = planBootstrap(previewConfig());
  const { client, only } = recorder();
  const seeds = seedUtxos(plan);
  const result = await buildProtocolGenesisTx({
    ...ctx(client),
    plan,
    protocolParamsSeedUtxo: seeds.protocolParams,
    issuanceSeedUtxo: seeds.issuance,
    provenancePin: PIN,
  });
  const meta = only("attachMetadata");
  assert.equal(meta.length, 1);
  assert.equal(BigInt(meta[0].params.label), 1984n);
  assert.equal(result.metadata.cip171, true);
  // ⚠ `issuance_mint` is EXCLUDED and the exclusion is semantic: it is
  // parameterised per minting-logic hash, so the instance built here belongs to
  // a substandard's registration, not to the core deployment.
  assert.equal(plan.parameterizations.length, 11);
});

test("STEP 4 reference-scripts: seven outputs, in REFERENCE_SCRIPT_ORDER", async () => {
  const plan = planBootstrap(previewConfig());
  const { client, only } = recorder();
  const result = await buildReferenceScriptsTx({
    ...ctx(client),
    plan,
    referenceScriptAddress: WALLET,
    referenceScriptLovelace: 20_000_000n,
  });
  const pays = only("payToAddress");
  assert.equal(pays.length, REFERENCE_SCRIPT_ORDER.length);
  assert.deepEqual(
    pays.map((p) => p.params.script),
    REFERENCE_SCRIPT_ORDER.map((n) => buildEvoScript(plan.scripts[n].compiledCode))
  );
  for (const p of pays) {
    assert.equal(EvoAddress.toBech32(p.params.address), WALLET);
    assert.equal(EvoAssets.lovelaceOf(p.params.assets), 20_000_000n);
  }
  assert.deepEqual(result.metadata.outputIndices, {
    programmableLogicBase: 0,
    programmableLogicGlobal: 1,
    transfer: 2,
    thirdParty: 3,
    unfracking: 4,
    issuanceLogic: 5,
    upgradeMultisig: 6,
  });
});

test("STEP 5 stake-registrations: six RegCerts, each with its own script witness", async () => {
  const plan = planBootstrap(previewConfig());
  const { client, only } = recorder();
  await buildStakeRegistrationTx({ ...ctx(client), plan });

  const certs = only("registerStake");
  assert.equal(certs.length, 6, "six, not four — issuance_logic and upgrade_multisig joined");
  assert.deepEqual(
    certs.map((c) => hex(c.params.stakeCredential.hash)),
    STAKE_REGISTRATION_ORDER.map((n) => plan.scripts[n].hash)
  );
  for (const c of certs) {
    assert.ok(c.params.redeemer, "a script RegCert runs under the PUBLISH purpose and needs one");
  }
  // ⛔ registerStake + attachScript, NEVER registerAndDelegateTo for a SCRIPT
  // credential: a combined certificate is a different Certificate constructor
  // and the publish handlers admit RegisterCredential only.
  assert.deepEqual(
    only("attachScript").map((s) => s.params.script),
    STAKE_REGISTRATION_ORDER.map((n) => buildEvoScript(plan.scripts[n].compiledCode))
  );
});

// ---------------------------------------------------------------------------
// Build-context refusals — the reservation is required, not merely advised
// ---------------------------------------------------------------------------

test("REFUSAL: availableUtxos absent or empty, by name, on every step", async () => {
  const plan = planBootstrap(previewConfig());
  const seeds = seedUtxos(plan);
  const calls = [
    ["seed", (c) => buildSeedTx({ ...c, ownerAddress: WALLET, seedLovelace: 1n })],
    [
      "multisig-genesis",
      (c) =>
        buildMultisigGenesisTx({
          ...c,
          plan,
          seedUtxo: seeds.upgradeMultisig,
          upgradeMultisigTree: TREE,
        }),
    ],
    [
      "protocol-genesis",
      (c) =>
        buildProtocolGenesisTx({
          ...c,
          plan,
          protocolParamsSeedUtxo: seeds.protocolParams,
          issuanceSeedUtxo: seeds.issuance,
        }),
    ],
    [
      "reference-scripts",
      (c) =>
        buildReferenceScriptsTx({
          ...c,
          plan,
          referenceScriptAddress: WALLET,
          referenceScriptLovelace: 1n,
        }),
    ],
    ["stake-registrations", (c) => buildStakeRegistrationTx({ ...c, plan })],
  ];
  for (const [step, call] of calls) {
    const { client } = recorder();
    await refusesNaming(
      () => call({ client, changeAddress: WALLET, availableUtxos: undefined }),
      /availableUtxos is required/,
      `${step}: absent`
    );
    await refusesNaming(
      () => call({ client, changeAddress: WALLET, availableUtxos: [] }),
      /availableUtxos is empty/,
      `${step}: empty`
    );
    await refusesNaming(
      () => call({ client, changeAddress: undefined, availableUtxos: [fakeUtxo({ txHash: "ee".repeat(32), outputIndex: 0 })] }),
      /changeAddress is required/,
      `${step}: no change address`
    );
    await refusesNaming(
      () => call({ client: undefined, changeAddress: WALLET, availableUtxos: [1] }),
      /client is required/,
      `${step}: no client`
    );
  }
});

test("REFUSAL: seedLovelace and the reference-script inputs, by name", async () => {
  const plan = planBootstrap(previewConfig());
  const { client } = recorder();
  await refusesNaming(
    () => buildSeedTx({ ...ctx(client), ownerAddress: WALLET, seedLovelace: undefined }),
    /seedLovelace is required/,
    "no seedLovelace"
  );
  await refusesNaming(
    () => buildSeedTx({ ...ctx(client), ownerAddress: undefined, seedLovelace: 1n }),
    /ownerAddress is required/,
    "no ownerAddress"
  );
  await refusesNaming(
    () =>
      buildReferenceScriptsTx({
        ...ctx(client),
        plan,
        referenceScriptAddress: undefined,
        referenceScriptLovelace: 1n,
      }),
    /referenceScriptAddress is required/,
    "no reference-script address"
  );
  await refusesNaming(
    () =>
      buildReferenceScriptsTx({
        ...ctx(client),
        plan,
        referenceScriptAddress: WALLET,
        referenceScriptLovelace: undefined,
      }),
    /referenceScriptLovelace is required/,
    "no reference-script lovelace"
  );
});

// ---------------------------------------------------------------------------
// selectBootstrapSeeds and assembleDeploymentParams
// ---------------------------------------------------------------------------

test("selectBootstrapSeeds takes three by output index, and REFUSES fewer", () => {
  const h = "dd".repeat(32);
  const pool = [
    fakeUtxo({ txHash: h, outputIndex: 2 }),
    fakeUtxo({ txHash: "77".repeat(32), outputIndex: 0 }),
    fakeUtxo({ txHash: h, outputIndex: 0 }),
    fakeUtxo({ txHash: h, outputIndex: 1 }),
  ];
  const { seeds, utxos } = selectBootstrapSeeds(pool, h);
  assert.deepEqual(seeds, {
    protocolParams: { txHash: h, outputIndex: 0 },
    issuance: { txHash: h, outputIndex: 1 },
    upgradeMultisig: { txHash: h, outputIndex: 2 },
  });
  assert.equal(Number(utxos.upgradeMultisig.index), 2);

  // ⛔ THREE, NOT TWO. Tolerating two hands `undefined` to the third consumer.
  refusesNaming(
    () => selectBootstrapSeeds(pool.slice(0, 3), h),
    /shows 2 output\(s\).*need ≥3/s,
    "only two"
  );
});

test("REFUSAL: assembleDeploymentParams without the observed hashes, by name", () => {
  const plan = planBootstrap(previewConfig());
  refusesNaming(
    () =>
      assembleDeploymentParams(plan, {
        protocolGenesisTxHash: undefined,
        referenceScriptsTxHash: REAL.programmableBaseRefInput.txHash,
        multisigConfigUtxo: REAL.upgradeMultisig.utxo,
      }),
    /observed\.protocolGenesisTxHash/,
    "no genesis hash"
  );
  refusesNaming(
    () =>
      assembleDeploymentParams(plan, {
        protocolGenesisTxHash: REAL.txHash,
        referenceScriptsTxHash: "abcd",
        multisigConfigUtxo: REAL.upgradeMultisig.utxo,
      }),
    /observed\.referenceScriptsTxHash/,
    "short ref hash"
  );
  refusesNaming(
    () =>
      assembleDeploymentParams(plan, {
        protocolGenesisTxHash: REAL.txHash,
        referenceScriptsTxHash: REAL.programmableBaseRefInput.txHash,
        multisigConfigUtxo: undefined,
      }),
    /observed\.multisigConfigUtxo/,
    "no config UTxO"
  );
});

// ---------------------------------------------------------------------------
// The operability gate
// ---------------------------------------------------------------------------

test("GATE: the config UTxO is found by POLICY, past a decoy that carries none", () => {
  const plan = planBootstrap(previewConfig());
  const policy = plan.scripts.upgradeMultisig.hash;
  const config = fakeUtxo({
    txHash: "55".repeat(32),
    outputIndex: 3,
    assets: outputAssets(2_000_000n, new Map([[plan.assetUnits.upgradeMultisigNft, 1n]])),
    datum: multisigScriptDatum(TREE),
  });
  const decoy = fakeUtxo({ txHash: "56".repeat(32), outputIndex: 0 });

  const found = assertMultisigConfigUtxo({
    plan,
    utxosAtAddress: [decoy, config],
    expectedTree: TREE,
  });
  assert.deepEqual(found.ref, { txHash: "55".repeat(32), outputIndex: 3 });
  assert.ok(policy.length === 56);
});

test("GATE REFUSAL: zero, two, datum-less, or a different tree — each named", () => {
  const plan = planBootstrap(previewConfig());
  const unit = plan.assetUnits.upgradeMultisigNft;
  const withNft = (i, datum) =>
    fakeUtxo({
      txHash: "55".repeat(32),
      outputIndex: i,
      assets: outputAssets(2_000_000n, new Map([[unit, 1n]])),
      datum,
    });

  refusesNaming(
    () => assertMultisigConfigUtxo({ plan, utxosAtAddress: [], expectedTree: TREE }),
    /expected exactly 1 UTxO .* found 0/s,
    "zero"
  );
  refusesNaming(
    () =>
      assertMultisigConfigUtxo({
        plan,
        utxosAtAddress: [withNft(0, multisigScriptDatum(TREE)), withNft(1, multisigScriptDatum(TREE))],
        expectedTree: TREE,
      }),
    /expected exactly 1 UTxO .* found 2/s,
    "two"
  );
  refusesNaming(
    () => assertMultisigConfigUtxo({ plan, utxosAtAddress: [withNft(0, undefined)], expectedTree: TREE }),
    /carries no inline datum/,
    "no datum"
  );
  // ⛔ The tree IS the authority. A different one is a different protocol owner,
  // and naming it in a genesis datum is a brick with no repair path.
  refusesNaming(
    () =>
      assertMultisigConfigUtxo({
        plan,
        utxosAtAddress: [withNft(0, multisigScriptDatum({ type: "signature", keyHash: "cd".repeat(28) }))],
        expectedTree: TREE,
      }),
    /different authority tree/,
    "wrong tree"
  );
});

test("GATE: a NESTED tree is compared structurally, not by its constructor alone", () => {
  const plan = planBootstrap(previewConfig());
  const unit = plan.assetUnits.upgradeMultisigNft;
  const tree = {
    type: "at-least",
    required: 2,
    scripts: [
      { type: "signature", keyHash: "11".repeat(28) },
      { type: "signature", keyHash: "22".repeat(28) },
      { type: "signature", keyHash: "33".repeat(28) },
    ],
  };
  const utxo = fakeUtxo({
    txHash: "55".repeat(32),
    outputIndex: 0,
    assets: outputAssets(2_000_000n, new Map([[unit, 1n]])),
    datum: multisigScriptDatum(tree),
  });
  assert.ok(assertMultisigConfigUtxo({ plan, utxosAtAddress: [utxo], expectedTree: tree }));

  // Same shape, same arity, one leaf different — and one threshold different.
  const swapped = structuredClone(tree);
  swapped.scripts[2] = { type: "signature", keyHash: "44".repeat(28) };
  refusesNaming(
    () => assertMultisigConfigUtxo({ plan, utxosAtAddress: [utxo], expectedTree: swapped }),
    /different authority tree/,
    "one leaf changed"
  );
  const rethreshold = { ...structuredClone(tree), required: 3 };
  refusesNaming(
    () => assertMultisigConfigUtxo({ plan, utxosAtAddress: [utxo], expectedTree: rethreshold }),
    /different authority tree/,
    "threshold changed"
  );
});

// ---------------------------------------------------------------------------
// F-5 — the splice-marker occurrence check, which had never been mutated
// ---------------------------------------------------------------------------

test("REFUSAL: the issuance_mint splice marker occurring TWICE, by name", () => {
  // ⛔ THIS CHECK IS THE ENTIRE REASON SHIPPING A PLACEHOLDER HEX IS TOLERABLE,
  // and round 1 never mutated it: neutering `splitParts.length !== 2` to
  // `if (false)` left the suite 31/31 green. A guard nothing exercises is a
  // claim, not a check.
  //
  // ⚑ THE FIXTURE IS REAL, NOT FABRICATED. Substituting any other validator's
  // body was MEASURED to still yield exactly one occurrence — Evolution's
  // `applyParamsToScript` byte-aligns the argument regardless of the script. So
  // the reachable arm is the OTHER one the code's comment names: a body that
  // ALREADY CONTAINS the marker byte run. Feeding back an issuance_mint that
  // has been parameterised once produces exactly that, and it is the shape a
  // real collision would take — the splice would silently rewrite an unrelated
  // run of bytes.
  // ⚠ Pre-applied with the marker `planBootstrap` ITSELF uses — imported, never
  // re-typed. A copy here would keep passing while the module's marker moved,
  // and the test would be exercising a collision that can no longer happen.
  const alreadyApplied = createStandardScripts(BLUEPRINT)
    .issuanceMint(ISSUANCE_SPLICE_MARKER, REAL.protocolParams.policyId)
    .compiledCode;
  const doubled = structuredClone(BLUEPRINT);
  for (const v of doubled.validators) {
    if (v.title === "issuance_mint.issuance_mint.mint") v.compiledCode = alreadyApplied;
  }
  // The fixture must genuinely contain the marker twice, or this test is
  // asserting a refusal that fires for some unrelated reason.
  const occurrences =
    scriptBodyHex(
      createStandardScripts(doubled).issuanceMint(
        ISSUANCE_SPLICE_MARKER,
        REAL.protocolParams.policyId
      ).compiledCode
    ).split(ISSUANCE_SPLICE_MARKER).length - 1;
  assert.equal(occurrences, 2, "the fixture must reach the guard with two occurrences");

  refusesNaming(
    () => planBootstrap(previewConfig({ blueprint: doubled })),
    /splice marker appeared 2 times in the compiled body — expected exactly once/,
    "marker twice"
  );
});

// ---------------------------------------------------------------------------
// F-11 — required is not the same as valid
// ---------------------------------------------------------------------------

test("REFUSAL: seedLovelace below the min-UTxO floor, by name and by figure", async () => {
  const { client } = recorder();
  // ⚠ `1n` is a positive bigint, so the round-1 type check admitted it. It
  // builds happily and is refused at SUBMISSION as "insufficient Ada" — the
  // exact failure min-UTxO solving exists to prevent, arriving from the one
  // figure the builder does not solve because the caller chose it.
  await refusesNaming(
    () => buildSeedTx({ ...ctx(client), ownerAddress: WALLET, seedLovelace: 1n }),
    /seedLovelace is 1 lovelace, below the min-UTxO floor of \d+/,
    "one lovelace"
  );
  // And it says what it does NOT check, rather than reading as sufficiency.
  let msg = "";
  try {
    await buildSeedTx({ ...ctx(client), ownerAddress: WALLET, seedLovelace: 1n });
  } catch (e) {
    msg = String(e.message);
  }
  assert.match(msg, /NECESSARY, NOT SUFFICIENT/, "the floor must not read as a sufficiency check");

  // The floor is real arithmetic, not a constant: a figure above it is admitted.
  const ok = await buildSeedTx({ ...ctx(client), ownerAddress: WALLET, seedLovelace: 5_000_000n });
  assert.equal(ok.metadata.step, "seed");
});

test("REFUSAL: referenceScriptLovelace below what a SCRIPT-BEARING output needs, by name", async () => {
  const plan = planBootstrap(previewConfig());
  const { client } = recorder();
  // ⚠ 2 ADA clears min-UTxO for a PLAIN output and is nowhere near enough for
  // one carrying a 2.8 kB script — the script's own bytes count toward
  // min-UTxO. A plain-output figure is the mistake this refusal is shaped for.
  await refusesNaming(
    () =>
      buildReferenceScriptsTx({
        ...ctx(client),
        plan,
        referenceScriptAddress: WALLET,
        referenceScriptLovelace: 2_000_000n,
      }),
    /below the \d+ a script-bearing output needs at coinsPerUtxoByte 4310 — the largest script here is \w+ at \d+ bytes/,
    "a plain-output figure"
  );
  // 20 ADA, what the fixture uses, is admitted.
  const ok = await buildReferenceScriptsTx({
    ...ctx(client),
    plan,
    referenceScriptAddress: WALLET,
    referenceScriptLovelace: 20_000_000n,
  });
  assert.equal(ok.metadata.order.length, 7);
});

// ---------------------------------------------------------------------------
// F-9 — the size cap this transaction is already at 76% of
// ---------------------------------------------------------------------------

test("REFUSAL: a reference-script transaction at or over the chain's maxTxSize, by name", async () => {
  const plan = planBootstrap(previewConfig());
  // ⚠ The stub returns a placeholder transaction, so its measured size is not
  // the real 12,496 bytes; what this exercises is that the GUARD reads the
  // chain's own maxTxSize and refuses against it, rather than that any
  // particular byte count is or is not over. A cap of 1 makes every
  // transaction over it.
  const { client } = recorder({ maxTxSize: 1 });
  await refusesNaming(
    () =>
      buildReferenceScriptsTx({
        ...ctx(client),
        plan,
        referenceScriptAddress: WALLET,
        referenceScriptLovelace: 20_000_000n,
      }),
    /publishing 7 reference scripts is \d+ bytes, at or over this chain's 1-byte maximum/,
    "over the cap"
  );

  // Under a real cap it passes, and reports what it measured — so a reader can
  // see how close to the cap a deployment is without instrumenting anything.
  const roomy = recorder({ maxTxSize: 16384 });
  const ok = await buildReferenceScriptsTx({
    ...ctx(roomy.client),
    plan,
    referenceScriptAddress: WALLET,
    referenceScriptLovelace: 20_000_000n,
  });
  assert.equal(ok.metadata.maxTxSize, 16384);
  assert.equal(typeof ok.metadata.unsignedBytes, "number");
});
