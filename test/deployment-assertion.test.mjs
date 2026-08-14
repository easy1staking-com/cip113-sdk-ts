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
