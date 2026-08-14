/**
 * Protocol bootstrap on a live devnet.
 *
 * THIS FILE IS CURRENTLY BLOCKED, AND SAYS SO BY FAILING WHEN IT UNBLOCKS.
 *
 * The bootstrap must register programmable_logic_global's stake credential —
 * PLG is a withdraw-0 validator and the protocol cannot operate until its
 * credential exists on chain. Evolution's `registerStake` emits a Conway
 * RegCert, executing the script under the **publish** purpose.
 *
 * The blueprint this repo bundles (blueprints/standard/v0.3.0, preamble
 * "iohk/programmable-tokens" v0.3.0) has NO publish handler — only `withdraw`
 * and `else`. Verified on a live devnet: the transaction builds, submits to
 * evaluation, and dies with
 *
 *   validator { index: 0, purpose: "publish" }
 *   "The machine terminated because of an error", traces: []
 *
 * i.e. it falls through to `else` with no indication of what is missing.
 * Upstream 8143853 and 0.5.0-alpha.1 both carry the handler.
 *
 * So the fixture cannot bootstrap until a publish-capable blueprint is bundled,
 * which is W-D's business. Rather than skip (invisible) or leave a red test
 * (noise that trains people to ignore failures), this asserts the blocker
 * itself. **When a publish-capable blueprint lands, THIS TEST FAILS** — and the
 * fix is to delete it and restore the real assertions below it, which are kept
 * in `bootstrapDeploymentAssertions` so they are not rewritten from scratch.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { assertDeploymentScripts, DeploymentMismatchError } from "../../dist/index.js";
import { requireDevnet } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";

const PLG_PUBLISH = "programmable_logic_global.programmable_logic_global.publish";

before(async () => {
  await requireDevnet();
});

test("BLOCKED: the bundled blueprint cannot bootstrap — no PLG publish handler", async () => {
  const blueprint = loadStandardBlueprint();
  const titles = blueprint.validators.map((v: { title: string }) => v.title);

  assert.ok(
    !titles.includes(PLG_PUBLISH),
    `The bundled blueprint now HAS ${PLG_PUBLISH}, so this repo is no longer blocked. ` +
    `Delete this test and enable the real bootstrap assertions — see the file header.`
  );

  await assert.rejects(
    () => bootstrapProtocol(),
    /cannot bootstrap a protocol/,
    "the bootstrap must refuse a publish-less blueprint up front, not die at script evaluation"
  );
});

/**
 * The real acceptance for a bootstrapped protocol, kept ready for the moment a
 * publish-capable blueprint lands. Deliberately not wired to a `test()` yet —
 * it cannot pass, and a test that cannot pass is either a skip or a red.
 *
 * The assertion that matters is NOT that bootstrap returned something. It is
 * that the DeploymentParams survive a round-trip through JSON and still
 * reproduce the blueprint's hashes — the check applied where it has value (on
 * load, against an independent artifact) rather than where it is vacuous
 * (inside the bootstrap, against values it just derived).
 */
export async function bootstrapDeploymentAssertions() {
  const deployment = await bootstrapProtocol();

  assert.match(deployment.txHash, /^[0-9a-f]{64}$/, "tx hash should be 32 bytes of hex");
  for (const [name, hash] of [
    ["protocolParams.policyId", deployment.protocolParams.policyId],
    ["programmableLogicGlobal.scriptHash", deployment.programmableLogicGlobal.scriptHash],
    ["programmableLogicBase.scriptHash", deployment.programmableLogicBase.scriptHash],
    ["issuance.policyId", deployment.issuance.policyId],
    ["directoryMint.scriptHash", deployment.directoryMint.scriptHash],
    ["directorySpend.scriptHash", deployment.directorySpend.scriptHash],
  ] as const) {
    assert.match(hash, /^[0-9a-f]{56}$/, `${name} should be a 28-byte script hash`);
  }

  // Distinct one-shot seeds, or the parameterised policies collide and the
  // protocol could be re-bootstrapped over itself.
  assert.notEqual(
    `${deployment.protocolParams.txInput.txHash}#${deployment.protocolParams.txInput.outputIndex}`,
    `${deployment.issuance.txInput.txHash}#${deployment.issuance.txInput.outputIndex}`,
    "protocolParams and issuance must consume different seed UTxOs"
  );

  // Persist and reload so blueprint and deployment are independent artifacts —
  // the only situation in which this assertion can actually fail.
  const reloaded = JSON.parse(JSON.stringify(deployment));
  const blueprint = loadStandardBlueprint();
  const checks = assertDeploymentScripts(blueprint, reloaded);
  assert.equal(checks.length, 6);
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} must reproduce`);

  // And prove that is not vacuous: perturb the blueprint, same deployment fails.
  const changed = structuredClone(blueprint);
  const v = changed.validators.find(
    (x: { title: string }) => x.title === "registry_spend.registry_spend.spend"
  );
  v.compiledCode = v.compiledCode.slice(0, -2) + (v.compiledCode.endsWith("00") ? "01" : "00");
  assert.throws(
    () => assertDeploymentScripts(changed, deployment),
    (err: unknown) => err instanceof DeploymentMismatchError
  );

  return deployment;
}
