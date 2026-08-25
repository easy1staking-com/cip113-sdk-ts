/**
 * Protocol bootstrap on a live devnet — CIP-113 0.5.0-alpha.2.
 *
 * This file previously asserted a BLOCKER: the bundled 0.3.0 blueprint had no
 * `publish` handler on programmable_logic_global, so registering its stake
 * credential died at evaluation with an empty trace list. That test was written
 * to FAIL the moment a publish-capable blueprint landed, and it has now been
 * deleted as designed.
 *
 * Worth recording WHY it is gone, because it is not why anyone expected: PLG was
 * not given a publish handler. PLG was DISSOLVED (upstream #110). Its three
 * successors — transfer, third_party, unfracking — each carry one, and the
 * bootstrap registers all three.
 *
 * This is the first point in workstream W-D where anything becomes OBSERVED
 * rather than DERIVED. Everything up to here is a builder producing bytes; only
 * a transaction the devnet accepted proves the bytes were right.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  assertDeploymentScripts,
  DeploymentMismatchError,
  decodeProtocolParams,
  decodeRegistryNode,
  scriptAddress,
  stringToHex,
  getInlineDatum,
} from "../../dist/index.js";
import { Address as EvoAddress } from "@evolution-sdk/evolution";
import { requireDevnet, makeClient } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";

before(async () => {
  await requireDevnet();
});

test("bootstraps a protocol instance on a live devnet", async () => {
  const deployment = await bootstrapProtocol();

  assert.match(deployment.txHash, /^[0-9a-f]{64}$/, "tx hash should be 32 bytes of hex");

  for (const [name, hash] of [
    ["protocolParams.policyId", deployment.protocolParams.policyId],
    ["protocolParams.coordinationScriptHash", deployment.protocolParams.coordinationScriptHash],
    ["coordination.scriptHash", deployment.coordination.scriptHash],
    ["programmableLogicBase.scriptHash", deployment.programmableLogicBase.scriptHash],
    ["transfer.scriptHash", deployment.transfer.scriptHash],
    ["thirdParty.scriptHash", deployment.thirdParty.scriptHash],
    ["unfracking.scriptHash", deployment.unfracking.scriptHash],
    ["upgradeMultisig.scriptHash", deployment.upgradeMultisig.scriptHash],
    ["issuance.policyId", deployment.issuance.policyId],
    ["directoryMint.scriptHash", deployment.directoryMint.scriptHash],
    ["directorySpend.scriptHash", deployment.directorySpend.scriptHash],
  ] as const) {
    assert.match(hash, /^[0-9a-f]{56}$/, `${name} should be a 28-byte script hash`);
  }

  // The three delegates MUST be distinct. programmable_logic_base dispatches to
  // them by credential and the arm is meaningful only while they are pairwise
  // different — upstream does NOT enforce that on chain, calling it a
  // deployment responsibility. This is that responsibility.
  const delegates = [
    deployment.transfer.scriptHash,
    deployment.thirdParty.scriptHash,
    deployment.unfracking.scriptHash,
  ];
  assert.equal(new Set(delegates).size, 3, "transfer / third_party / unfracking must be distinct");

  // The params NFT must NOT be locked at always_fail any more.
  assert.notEqual(
    deployment.protocolParams.coordinationScriptHash,
    deployment.issuance.alwaysFailScriptHash,
    "the lock target moved to coordination_spend; always_fail now guards only issuance"
  );

  // Distinct one-shot seeds, or the parameterised policies collide and the
  // protocol could be re-bootstrapped over itself.
  assert.notEqual(
    `${deployment.protocolParams.txInput.txHash}#${deployment.protocolParams.txInput.outputIndex}`,
    `${deployment.issuance.txInput.txHash}#${deployment.issuance.txInput.outputIndex}`,
    "protocolParams and issuance must consume different seed UTxOs"
  );

  // Persist and reload so blueprint and deployment are independent artifacts —
  // the only situation in which this assertion can actually fail. Asserting
  // inside the bootstrap, against values it just derived, is a tautology.
  const reloaded = JSON.parse(JSON.stringify(deployment));
  const blueprint = loadStandardBlueprint();
  const checks = assertDeploymentScripts(blueprint, reloaded);
  assert.equal(checks.length, 9, "all nine derivable scripts must be checked");
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} must reproduce`);

  // And prove that is not vacuous: substitute a DIFFERENT validator's program
  // and the same deployment must be rejected.
  //
  // NOT a trailing-byte flip. UPLC is flat-encoded and padded to a byte
  // boundary, so the last byte is frequently padding that decode -> apply ->
  // re-encode regenerates; measured on this artifact, flipping it leaves the
  // parameterised hash bit-identical and this assertion passes by throwing
  // nothing. That is what the earlier version of this file did.
  const changed = structuredClone(blueprint);
  const victim = changed.validators.find(
    (x: { title: string }) => x.title === "registry_spend.registry_spend.spend"
  );
  const donor = changed.validators.find(
    (x: { title: string }) => x.title === "unfracking.unfracking.withdraw"
  );
  assert.ok(victim && donor && victim.compiledCode !== donor.compiledCode);
  victim.compiledCode = donor.compiledCode;
  assert.throws(
    () => assertDeploymentScripts(changed, deployment),
    (err: unknown) => err instanceof DeploymentMismatchError,
    "a deployment paired with a different blueprint must be rejected"
  );
});

test("the deployed protocol state is what the bootstrap intended — read back from chain", async () => {
  // A transaction the node accepted is a RECEIPT. It proves the bytes were
  // well-formed, not that the protocol is wired correctly. This reads the state
  // back out of the chain through an independent query and checks the wiring.
  const deployment = await bootstrapProtocol();
  const client = await makeClient();
  const networkId = client.chain.id;

  // --- the params NFT must be at coordination_spend, NOT always_fail --------
  const paramsUnit = deployment.protocolParams.policyId + stringToHex("ProtocolParams");
  const coordAddr = scriptAddress(networkId, deployment.coordination.scriptHash);
  const coordUtxos = await client.getUtxosWithUnit(EvoAddress.fromBech32(coordAddr), paramsUnit);

  assert.equal(
    coordUtxos.length,
    1,
    "exactly one coordination UTxO must hold the params NFT — the NFT is one-shot, " +
      "and finding zero means it was locked somewhere else (the always_fail address is " +
      "where the 0.3.x fixture put it, and that mistake is invisible to every offline check)"
  );

  // --- its datum must be the SEVEN-field layout, wired to the real delegates -
  const datum = getInlineDatum(coordUtxos[0]);
  assert.ok(datum, "the coordination UTxO must carry an inline datum");
  const params = decodeProtocolParams(datum);

  assert.equal(params.transferCred.hash, deployment.transfer.scriptHash, "field 2 = transfer");
  assert.equal(params.thirdPartyCred.hash, deployment.thirdParty.scriptHash, "field 3 = third_party");
  assert.equal(params.unfrackingCred.hash, deployment.unfracking.scriptHash, "field 4 = unfracking");
  assert.equal(params.upgradeCred.hash, deployment.upgradeMultisig.scriptHash, "field 5 = upgrade");
  assert.equal(params.progLogicCred.hash, deployment.programmableLogicBase.scriptHash, "field 1 = PLB");
  assert.equal(params.registryNodeCs, deployment.directoryMint.scriptHash, "field 0 = registry policy");
  assert.equal(params.maxInlineDatumBytes, 1024n, "field 6 = max_inline_datum_bytes (devnet fixture)");

  // Each credential must be a SCRIPT credential. A key credential here has the
  // same shape and the same hash length; only the constructor index differs,
  // and programmable_logic_base would never resolve the delegate.
  for (const [name, c] of [
    ["progLogic", params.progLogicCred],
    ["transfer", params.transferCred],
    ["thirdParty", params.thirdPartyCred],
    ["unfracking", params.unfrackingCred],
  ] as const) {
    assert.equal(c.type, "script", `${name} must be a SCRIPT credential, not a key credential`);
  }

  // --- the registry origin node must be the SEVEN-field layout --------------
  const registryAddr = scriptAddress(networkId, deployment.directorySpend.scriptHash);
  const registryUtxos = await client.getUtxosWithUnit(
    EvoAddress.fromBech32(registryAddr),
    deployment.directoryMint.scriptHash
  );
  assert.equal(registryUtxos.length, 1, "exactly one registry origin node");
  const originDatum = getInlineDatum(registryUtxos[0]);
  assert.ok(originDatum, "the registry origin must carry an inline datum");
  const origin = decodeRegistryNode(originDatum);
  assert.equal(origin.key, "", "sentinel head has an empty key");
  assert.equal(origin.next, "ff".repeat(30), "sentinel tail pointer");

  // --- the four reference scripts must exist and be resolvable --------------
  for (const [name, ref] of [
    ["programmableLogicBase", deployment.programmableBaseRefInput],
    ["transfer", deployment.transferRefInput],
    ["thirdParty", deployment.thirdPartyRefInput],
    ["unfracking", deployment.unfrackingRefInput],
  ] as const) {
    assert.match(ref.txHash, /^[0-9a-f]{64}$/, `${name} reference input needs a real tx hash`);
  }
});
