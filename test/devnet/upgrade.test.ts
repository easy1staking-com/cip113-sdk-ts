/**
 * In-place protocol upgrade on a live devnet (T-D07).
 *
 * ACCEPTANCE IS A DELTA, NOT A STATE. An upgrade that changes nothing
 * observable proves nothing: the transaction would succeed, the datum would be
 * rewritten with identical content, and every assertion about "the datum is
 * well-formed" would pass without the upgrade path having been exercised at
 * all. So every test here reads the coordination datum BEFORE and AFTER and
 * asserts on the difference.
 *
 * The negatives matter more than the positive. coordination_spend's whole job
 * is refusing bad upgrades — a positive-only suite would confirm that it lets
 * things through, which is the half that cannot brick a protocol.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { requireDevnet, makeClient } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { readCoordination, upgradeProtocol } from "../harness/upgrade.js";

/**
 * A negative test that passes because the CLIENT refused proves nothing about
 * the on-chain rail — it proves Evolution has an opinion. These rails live in
 * coordination_spend, so the rejection must come from script evaluation.
 *
 * OBSERVED: all three rejections below arrive as Ogmios code 3010, "Some
 * scripts of the transactions terminated with error(s)".
 */
function assertRejectedByTheValidator(err: unknown): true {
  const msg = String((err as Error)?.message ?? err);
  assert.match(
    msg,
    /Script evaluation failed|terminated with error/,
    "the rejection must come from the VALIDATOR, not from client-side validation — " +
      `got: ${msg.slice(0, 200)}`
  );
  return true;
}

before(async () => {
  await requireDevnet();
});

test("an upgrade rewrites the live wiring in place — proven as a before/after delta", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();

  const before = (await readCoordination(client, deployment)).params;

  // A genuinely DIFFERENT transfer credential. `transfer` is parameterised only
  // by params_policy, so a second instance of the SAME protocol has the SAME
  // transfer hash — there is no way to produce a distinct one within one
  // deployment. So we bootstrap a second protocol and adopt its transfer script,
  // which is a real, deployed, registered credential rather than a random hash.
  const other = await bootstrapProtocol();
  const newTransferCred = other.transfer.scriptHash;
  assert.notEqual(newTransferCred, before.transferCred.hash, "the swap must actually change something");

  await upgradeProtocol(blueprint, deployment, {
    change: (p) => ({ ...p, transferCred: { type: "script", hash: newTransferCred } }),
  });

  const after = (await readCoordination(client, deployment)).params;

  // THE DELTA — the point of the whole ticket.
  assert.notEqual(after.transferCred.hash, before.transferCred.hash, "transfer_cred must have moved");
  assert.equal(after.transferCred.hash, newTransferCred, "and moved to the credential we chose");

  // Everything else must be untouched. An upgrade that quietly rewrites a
  // neighbouring field is indistinguishable from a correct one if you only
  // assert the field you meant to change.
  assert.equal(after.thirdPartyCred.hash, before.thirdPartyCred.hash, "third_party untouched");
  assert.equal(after.unfrackingCred.hash, before.unfrackingCred.hash, "unfracking untouched");
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "upgrade authority untouched");
  assert.equal(after.maxInlineDatumBytes, before.maxInlineDatumBytes, "datum bound untouched");

  // The frozen fields are frozen by the validator, but assert them anyway: the
  // rail existing is not evidence the rail ran.
  assert.equal(after.progLogicCred.hash, before.progLogicCred.hash, "prog_logic_cred FROZEN");
  assert.equal(after.registryNodeCs, before.registryNodeCs, "registry_node_cs FROZEN");
});

test("REFUSED: an upgrade without the authority's withdraw-0", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        omitAuthority: true,
        change: (p) => ({ ...p, transferCred: { type: "script", hash: "ab".repeat(28) } }),
      }),
    assertRejectedByTheValidator,
    "an upgrade with no authority withdrawal must be rejected"
  );

  // And the chain state must be UNCHANGED — a rejected transaction that still
  // moved something would be worse than one that succeeded.
  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.transferCred.hash, before.transferCred.hash, "state must not have moved");
});

test("REFUSED: an upgrade that rewrites a FROZEN field", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;

  // prog_logic_cred anchors every programmable token address. coordination_spend
  // freezes it permanently and no authority can override that — which is the
  // difference between a wiring change and a protocol substitution.
  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        change: (p) => ({ ...p, progLogicCred: { type: "script", hash: "cd".repeat(28) } }),
      }),
    assertRejectedByTheValidator,
    "rewriting prog_logic_cred must be rejected even WITH valid authority"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.progLogicCred.hash, before.progLogicCred.hash, "prog_logic_cred still frozen");
});

test("REFUSED: a mutable credential that is not 28 bytes — the one-way brick", async () => {
  // Upstream: "Writing one here is a ONE-WAY BRICK: an unsatisfiable
  // upgrade_cred makes this validator's own authority check permanently
  // unsatisfiable, with no repair path." A reward account is a header byte plus
  // a 28-byte hash, so a wrong-length credential can never appear in
  // tx.withdrawals and the protocol can never be upgraded again.
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        change: (p) => ({ ...p, upgradeCred: { type: "key", hash: "ab".repeat(20) } }),
      }),
    assertRejectedByTheValidator,
    "a 20-byte upgrade_cred must be rejected — it would brick the protocol permanently"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "authority unchanged");
});
