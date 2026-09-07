/**
 * In-place protocol upgrade on a live devnet (T-D07).
 *
 * ACCEPTANCE IS A DELTA, NOT A STATE. An upgrade that changes nothing
 * observable proves nothing: the transaction would succeed, the datum would be
 * rewritten with identical content, and every assertion about "the datum is
 * well-formed" would pass without the upgrade path having been exercised at
 * all. So every test here reads the protocol-params datum BEFORE and AFTER and
 * asserts on the difference.
 *
 * The negatives matter more than the positive. protocol_params' whole job
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
 * protocol_params, so the rejection must come from script evaluation.
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
  assert.equal(after.plgCred.hash, before.plgCred.hash, "dispatcher untouched");
  assert.equal(after.thirdPartyCred.hash, before.thirdPartyCred.hash, "third_party untouched");
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "upgrade authority untouched");

  // ⚠ unfracking_cred and max_inline_datum_bytes are NOT asserted here because
  // they are no longer datum fields — see the designed-out block below.
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

/**
 * ⛔ DESIGNED OUT BY THE alpha.3 PARAMS REDUCTION — not deleted for convenience.
 *
 * This slot held "REFUSED: rewriting prog_logic_cred is rejected even WITH
 * valid authority". The code path it covered no longer exists: `prog_logic_cred`
 * and `registry_node_cs` are not datum fields any more, so there is nothing for
 * a freeze rail to refuse. Upstream says so in the validator's own header —
 * "There are no frozen-field rails left to enforce".
 *
 * ⚠ AND THE THREAT IT COVERED DID NOT VANISH WITH THE RAIL — it moved one hop,
 * which is worth writing down so nobody reads this removal as a hardening.
 * The FIELDS are unrepresentable, so no upgrade can edit them in place. The
 * VALUES are still reachable: an upgrade that rewrites `plg_cred` installs a
 * dispatcher naming delegates of the authority's choosing, and those delegates
 * carry whatever `prog_logic_cred` and `registry_node_cs` they were compiled
 * with. That is the same authority acting in the same transaction — the
 * pre-existing upgrade threat model, unchanged, not a new escape.
 *
 * What still guards the datum is the wellformedness rail (every credential a
 * 28-byte hash), enforced by BOTH handlers so the state the spend refuses to
 * move to is also a state the mint refuses to create. The brick test below
 * exercises it.
 */


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
