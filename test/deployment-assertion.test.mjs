/**
 * The fail-first for the contract upgrade (milestone acceptance criterion #4).
 *
 * assertDeploymentScripts derives every parameterizable standard script hash
 * from the blueprint and checks it against DeploymentParams. It exists because
 * upstream 0.5.0-alpha.1 changes protocol_params_mint's second parameter from
 * `always_fail_hash` to `coordination_addr_hash` — same arity, same ByteArray
 * type, different meaning. TypeScript cannot see that. Neither can `tsc`.
 *
 * The negative case below is the proof the check has teeth: it feeds a wrong
 * value of the correct type and requires the assertion to go red. Without it,
 * a passing positive case proves only that nothing was checked.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blueprint = JSON.parse(
  readFileSync(resolve(ROOT, "blueprints/standard/v0.3.0/plutus.json"), "utf-8")
);

/** The preprod deployment this repo ships (examples/shared/deployment-preprod.ts). */
const PREPROD = {
  txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517",
  protocolParams: {
    txInput: { txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa", outputIndex: 0 },
    policyId: "d4230b10ba4c8a4350212f9e9af80084aa3b886ac33b683a722b6ea9",
    alwaysFailScriptHash: "7df9369eb2ded40f5eac15bcb1ee0562d3dc53def0dab4ad26bae4e9",
  },
  programmableLogicGlobal: {
    policyId: "d0a12c8a72ecfa08457987ba294fada31eaac764a1772e9ee07ddcf7",
    scriptHash: "d0a12c8a72ecfa08457987ba294fada31eaac764a1772e9ee07ddcf7",
  },
  programmableLogicBase: { scriptHash: "c8b055ef3e2c0ba8b5c016e86fc59381f4397e375d250da9ea4758b9" },
  issuance: {
    txInput: { txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa", outputIndex: 1 },
    policyId: "203ac50ec29d7f7739781e42f02e0ec103f439677ec3be03cb9e7809",
    alwaysFailScriptHash: "5ff3439ab5b059889fbaf360195275d8471de9ad939e1bb6c3a7b74c",
  },
  directoryMint: {
    txInput: { txHash: "72286cb222fb335c8c3854f1d1de42fbe831e01048b759c3508e3825fdf8a4fa", outputIndex: 0 },
    issuanceScriptHash: "203ac50ec29d7f7739781e42f02e0ec103f439677ec3be03cb9e7809",
    scriptHash: "b9b19dc682ed108590277bb5301132b8b2c357cfbdb9138c01af5d1d",
  },
  directorySpend: {
    policyId: "d4230b10ba4c8a4350212f9e9af80084aa3b886ac33b683a722b6ea9",
    scriptHash: "116a5de7080ea7428a04aac13fa7e1c4d55544c019386b1dd91bfdef",
  },
  programmableBaseRefInput: { txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517", outputIndex: 3 },
  programmableGlobalRefInput: { txHash: "d01ae47ef64aa13282296aabf9283da869ba70697438052cad8a630abf140517", outputIndex: 4 },
};

test("POSITIVE: shipped blueprint reproduces the shipped preprod deployment", () => {
  const checks = assertDeploymentScripts(blueprint, PREPROD);
  assert.equal(checks.length, 6, "expected 6 derivable script hashes");
  for (const c of checks) {
    assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
  }
});

test("NEGATIVE (fail-first): a wrong value of the CORRECT type is caught", () => {
  // Mimics the 0.5.0-alpha.1 hazard exactly: protocol_params_mint's second
  // parameter keeps its arity and ByteArray type but takes a different hash.
  const wrong = {
    ...PREPROD,
    protocolParams: {
      ...PREPROD.protocolParams,
      alwaysFailScriptHash: PREPROD.issuance.alwaysFailScriptHash,
    },
  };

  assert.throws(
    () => assertDeploymentScripts(blueprint, wrong),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError, "should be a DeploymentMismatchError");
      assert.equal(err.mismatches.length, 1, "exactly one script should mismatch");
      assert.equal(err.mismatches[0].name, "protocol_params_mint");
      return true;
    },
    "a same-type wrong value MUST be rejected — typecheck and build both accept it"
  );
});

test("NEGATIVE: a mismatched blueprint is rejected wholesale", () => {
  // Swap in the freeze-and-seize blueprint, which has none of the standard
  // validators — the failure must be loud, not a silent partial resolution.
  const wrongBlueprint = JSON.parse(
    readFileSync(resolve(ROOT, "blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json"), "utf-8")
  );
  assert.throws(() => assertDeploymentScripts(wrongBlueprint, PREPROD));
});

// ---------------------------------------------------------------------------
// Where the assertion has value, and where it does not
// ---------------------------------------------------------------------------

test("VACUOUS at bootstrap: a fully self-derived deployment always passes", () => {
  // Not a feature — the LIMIT of the check, locked in so nobody mistakes a
  // green bootstrap self-check for verification.
  //
  // A bootstrap derives every hash, populates DeploymentParams from those same
  // values, then asserts. Both sides of every comparison share one origin, so
  // the assertion passes no matter how wrong the parameterization is. Below is
  // exactly that shape, with deliberately arbitrary inputs.
  const b = scriptsModule.createStandardScripts(blueprint);

  const ppTx = { txHash: "aa".repeat(32), outputIndex: 0 };
  const issTx = { txHash: "cc".repeat(32), outputIndex: 1 };
  const afA = "bb".repeat(28);
  const afB = "dd".repeat(28);

  const ppMint = b.protocolParamsMint(ppTx, afA).hash;
  const plg = b.programmableLogicGlobal(ppMint).hash;
  const plb = b.programmableLogicBase(plg).hash;
  const issCbor = b.issuanceCborHexMint(issTx, afB).hash;
  const regMint = b.registryMint(ppTx, issCbor).hash;
  const regSpend = b.registrySpend(ppMint).hash;

  const selfDerived = {
    txHash: "ee".repeat(32),
    protocolParams: { txInput: ppTx, policyId: ppMint, alwaysFailScriptHash: afA },
    programmableLogicGlobal: { policyId: plg, scriptHash: plg },
    programmableLogicBase: { scriptHash: plb },
    issuance: { txInput: issTx, policyId: issCbor, alwaysFailScriptHash: afB },
    directoryMint: { txInput: ppTx, issuanceScriptHash: issCbor, scriptHash: regMint },
    directorySpend: { policyId: ppMint, scriptHash: regSpend },
    programmableBaseRefInput: { txHash: "ee".repeat(32), outputIndex: 3 },
    programmableGlobalRefInput: { txHash: "ee".repeat(32), outputIndex: 4 },
  };

  const checks = assertDeploymentScripts(blueprint, selfDerived);
  assert.equal(checks.length, 6);
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
  assert.ok(v, "fixture must contain registry_spend");
  // Perturb the compiled code the way a genuine upstream rebuild would.
  v.compiledCode = v.compiledCode.slice(0, -2) + (v.compiledCode.endsWith("00") ? "01" : "00");

  assert.throws(
    () => assertDeploymentScripts(changed, PREPROD),
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
