/**
 * The fail-first for the contract upgrade (milestone acceptance criterion #4).
 *
 * assertDeploymentScripts derives every parameterizable standard script hash
 * from the blueprint and checks it against DeploymentParams. It exists because
 * upstream changed protocol_params_mint's second parameter from
 * `always_fail_hash` to `coordination_addr_hash` — same arity, same ByteArray
 * type, different meaning. TypeScript cannot see that. Neither can `tsc`.
 *
 * The negative case below is the proof the check has teeth: it feeds a wrong
 * value of the correct type and requires the assertion to go red. Without it,
 * a passing positive case proves only that nothing was checked.
 *
 * TARGET: CIP-113 0.5.0-alpha.2 (upstream 9db7e06).
 *
 * The preprod deployment this repo used to assert against was a 0.3.x protocol
 * instance and is no longer REPRESENTABLE — programmable_logic_global does not
 * exist in 0.5.x, so there is no field to put its hash in. That fixture was not
 * "updated"; it described a different protocol. It is replaced by a derived
 * instance below, plus an explicit test that an old blueprint is DIAGNOSED
 * rather than silently half-resolved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDeploymentScripts,
  DeploymentMismatchError,
} from "../dist/standard/scripts.js";
import * as scriptsModule from "../dist/standard/scripts.js";
import { validateStandardBlueprint } from "../dist/standard/blueprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const blueprint = load("blueprints/standard/v0.5.0-alpha.2/plutus.json");

/** Arbitrary but fixed inputs — nothing here needs to be a real deployment. */
const PP_TX = { txHash: "aa".repeat(32), outputIndex: 0 };
const ISS_TX = { txHash: "cc".repeat(32), outputIndex: 1 };
const NONCE = "9f".repeat(16);
const ALWAYS_FAIL = "dd".repeat(28);
const SIGNER = "11".repeat(28);

/**
 * A self-consistent 0.5.0-alpha.2 deployment, derived from the blueprint.
 *
 * DERIVED, not observed: no protocol instance with these hashes has ever been
 * deployed. It is sufficient for these tests, which are about whether the
 * assertion mechanism works — not about any particular chain state.
 */
function deriveDeployment(bp) {
  const b = scriptsModule.createStandardScripts(bp);

  const coordination = b.coordinationSpend(NONCE).hash;
  const paramsPolicy = b.protocolParamsMint(PP_TX, coordination).hash;
  const plb = b.programmableLogicBase(paramsPolicy).hash;
  const transfer = b.transfer(paramsPolicy).hash;
  const thirdParty = b.thirdParty(paramsPolicy).hash;
  const unfracking = b.unfracking(paramsPolicy).hash;
  const registrySpend = b.registrySpend(paramsPolicy).hash;
  const issuanceCborHex = b.issuanceCborHexMint(ISS_TX, ALWAYS_FAIL).hash;
  const registryMint = b.registryMint(PP_TX, issuanceCborHex, registrySpend).hash;
  const upgradeMultisig = b.upgradeMultisig([SIGNER], 1).hash;

  const ref = (i) => ({ txHash: "ee".repeat(32), outputIndex: i });

  return {
    txHash: "ee".repeat(32),
    coordinationNonce: NONCE,
    coordination: { scriptHash: coordination, utxo: ref(0) },
    protocolParams: {
      txInput: PP_TX,
      policyId: paramsPolicy,
      coordinationScriptHash: coordination,
    },
    programmableLogicBase: { scriptHash: plb },
    transfer: { scriptHash: transfer },
    thirdParty: { scriptHash: thirdParty },
    unfracking: { scriptHash: unfracking },
    upgradeMultisig: { scriptHash: upgradeMultisig },
    issuance: {
      txInput: ISS_TX,
      policyId: issuanceCborHex,
      alwaysFailScriptHash: ALWAYS_FAIL,
    },
    directoryMint: { txInput: PP_TX, issuanceScriptHash: issuanceCborHex, scriptHash: registryMint },
    directorySpend: { policyId: paramsPolicy, scriptHash: registrySpend },
    programmableBaseRefInput: ref(1),
    transferRefInput: ref(2),
    thirdPartyRefInput: ref(3),
    unfrackingRefInput: ref(4),
  };
}

const DEPLOYMENT = deriveDeployment(blueprint);

/** Every check the assertion performs, so a silent shrink is caught. */
const EXPECTED_CHECKS = [
  "coordination_spend",
  "protocol_params_mint",
  "programmable_logic_base",
  "transfer",
  "third_party",
  "unfracking",
  "issuance_cbor_hex_mint",
  "registry_spend",
  "registry_mint",
];

test("POSITIVE: every derivable 0.5.0-alpha.2 script is checked and reproduces", () => {
  const checks = assertDeploymentScripts(blueprint, DEPLOYMENT);
  assert.deepEqual(
    checks.map((c) => c.name).sort(),
    [...EXPECTED_CHECKS].sort(),
    "the set of asserted scripts changed — a check was added or silently dropped"
  );
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
});

test("NEGATIVE (fail-first): a wrong value of the CORRECT type is caught", () => {
  // The exact 0.5.x hazard: protocol_params_mint's 2nd parameter keeps its
  // arity and ByteArray type but now means coordination_spend's hash. Feed it
  // the always_fail hash it USED to take — the mistake a 0.3.x-era deployment
  // record, or a stale doc, would produce.
  const wrong = structuredClone(DEPLOYMENT);
  wrong.protocolParams.coordinationScriptHash = ALWAYS_FAIL;

  assert.throws(
    () => assertDeploymentScripts(blueprint, wrong),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError, "should be a DeploymentMismatchError");
      assert.ok(
        err.mismatches.some((m) => m.name === "protocol_params_mint"),
        `expected protocol_params_mint to mismatch, got: ${err.mismatches.map((m) => m.name).join(", ")}`
      );
      return true;
    },
    "a same-type wrong value MUST be rejected — typecheck and build both accept it"
  );
});

test("NEGATIVE (fail-first): the three delegates are distinguished from each other", () => {
  // transfer, third_party and unfracking take the SAME parameter and differ
  // only in their compiled code. Swapping two would be invisible to arity or
  // type checking, and produces a protocol whose PLB dispatch is wired to the
  // wrong validator.
  const swapped = structuredClone(DEPLOYMENT);
  swapped.transfer.scriptHash = DEPLOYMENT.thirdParty.scriptHash;
  swapped.thirdParty.scriptHash = DEPLOYMENT.transfer.scriptHash;

  assert.throws(
    () => assertDeploymentScripts(blueprint, swapped),
    (err) => {
      const names = err.mismatches.map((m) => m.name).sort();
      assert.deepEqual(names, ["third_party", "transfer"], `got: ${names.join(", ")}`);
      return true;
    },
    "swapping two same-signature delegates MUST be caught"
  );
});

test("NEGATIVE: a mismatched blueprint is rejected wholesale", () => {
  assert.throws(() =>
    assertDeploymentScripts(
      load("blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json"),
      DEPLOYMENT
    )
  );
});

// ---------------------------------------------------------------------------
// The retired protocol version must be DIAGNOSED, not merely rejected
// ---------------------------------------------------------------------------

test("a 0.3.x blueprint is diagnosed by protocol version, not as a corrupt file", () => {
  const old = load("blueprints/standard/v0.3.0/plutus.json");
  assert.throws(
    () => validateStandardBlueprint(old),
    (err) => {
      assert.match(err.message, /earlier CIP-113 protocol version/);
      assert.match(err.message, /programmable_logic_global/, "must name what it found");
      assert.match(err.message, /transfer\.transfer\.withdraw/, "must name the successor");
      assert.match(err.message, /v0\.5\.0-alpha\.2/, "must name where to go");
      return true;
    },
    "loading old contracts must explain the version gap, not report a missing validator"
  );
});

test("the shipped 0.5.0-alpha.2 blueprint validates", () => {
  validateStandardBlueprint(blueprint);
});

// ---------------------------------------------------------------------------
// Where the assertion has value, and where it does not
// ---------------------------------------------------------------------------

test("VACUOUS at bootstrap: a fully self-derived deployment always passes", () => {
  // Not a feature — the LIMIT of the check, locked in so nobody mistakes a
  // green bootstrap self-check for verification.
  //
  // DEPLOYMENT is exactly this shape: every hash derived, then asserted against
  // itself. Both sides of every comparison share one origin, so it passes no
  // matter how wrong the parameterization is.
  const checks = assertDeploymentScripts(blueprint, deriveDeployment(blueprint));
  assert.equal(checks.length, EXPECTED_CHECKS.length);
  for (const c of checks) assert.equal(c.derived, c.deployed);
  // Passing here proves only self-consistency — never that the deployment is
  // correct against the protocol actually on chain.
});

test("VALUABLE on load: a stale deployment against a changed blueprint is caught", () => {
  // The real defect this exists for: a blueprint replaced in place while the
  // deployment stays put. This repo shipped exactly that — same v0.3.0
  // directory name, 4 of 8 validator hashes moved.
  const changed = structuredClone(blueprint);
  const v = changed.validators.find((x) => x.title === "registry_spend.registry_spend.spend");
  const donor = changed.validators.find((x) => x.title === "unfracking.unfracking.withdraw");
  assert.ok(v && donor, "fixture must contain registry_spend and unfracking");

  // Substitute a DIFFERENT validator's program — the real-world defect being
  // modelled (a blueprint replaced in place under an unchanged directory name).
  //
  // ⚠ Do NOT go back to flipping the last byte of compiledCode. That was this
  // test's original mutation and it is UNSOUND: UPLC is flat-encoded and
  // padded to a byte boundary, so the trailing bits are often padding that the
  // decode -> apply-params -> re-encode round trip simply regenerates.
  // MEASURED on this artifact: flipping registry_spend's final byte
  // (…400801 -> …400800) leaves the parameterised hash BIT-IDENTICAL at
  // 95c6f275…1147c7, so the assertion had nothing to catch and the test passed
  // by throwing nothing. It only ever worked because v0.3.0's tail happened to
  // be significant. A mutation that depends on which byte the padding lands on
  // is a coin flip, not a proof.
  assert.notEqual(v.compiledCode, donor.compiledCode);
  v.compiledCode = donor.compiledCode;

  assert.throws(
    () => assertDeploymentScripts(changed, DEPLOYMENT),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError);
      assert.ok(
        err.mismatches.some((m) => m.name === "registry_spend"),
        `expected registry_spend to mismatch, got: ${err.mismatches.map((m) => m.name).join(", ")}`
      );
      return true;
    },
    "a deployment paired with a different blueprint MUST be rejected"
  );
});
