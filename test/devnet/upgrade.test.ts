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
 *
 * ⚠⚠ THESE ARE NOT REGRESSION TESTS — THE POSITIVE IS A FIRST-EVER EXECUTION.
 * Every upgrade this repo has ever performed was authorised by a KEY credential.
 * On alpha.4 the bootstrap installs `upgrade_cred = Script(upgrade_multisig)`,
 * so test 1 below is the first time in this repo's history that a
 * `MultisigScript` has authorised ANYTHING on chain. A green here is ONE
 * OBSERVATION with nothing behind it — not restored parity, not "no
 * regression". Read it as such, and keep this qualifier inside the acceptance
 * rather than beside it.
 *
 * ⛔ AND WHAT THE ACT PARAMETER DOES **NOT** SETTLE. Every test here passes
 * `act:` explicitly, and `upgradeProtocol` routes it through one
 * `protocolParamsRedeemer(...)` call site. That proves the redeemer FIELD is
 * load-bearing on chain — mutating `act` to "NOMINATE_AUTHORITY" in test 1
 * makes the validator refuse (see the mutation record in the slice audit). It
 * CANNOT prove that arm 0's bytes were produced by `protocolParamsRedeemer`
 * rather than by the `voidData()` it replaced: `ProtocolUpgrade` encodes as
 * `Constr(0, [])` and so does `voidData()`, and no decoder on chain or off can
 * tell the two apart. That half is discharged only when arms 1 and 2 —
 * `Constr(1, [])` / `Constr(2, [])`, which `voidData()` cannot represent —
 * travel through the same call site on chain, which is T-F03-3's
 * nominate/promote pair, not this file's.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { requireDevnet, makeClient } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { readCoordination, upgradeProtocol } from "../harness/upgrade.js";

/** Which Ogmios validator purpose, and which numeric error, a negative expects. */
interface ExpectedRefusal {
  /**
   * The Ogmios `validator.purpose` that must have refused.
   *
   * ⛔ PIN `purpose`; NEVER PIN `index`. MEASURED, audit r1: the SAME rail
   * reported `index: 1` in the worker's runs and `index: 0` in the auditor's,
   * because the redeemer index is a position in the ledger-ordered input set and
   * therefore depends on coin selection. `purpose` was stable in every run on
   * every machine. An assertion on `index` would be flaky across environments
   * while looking stricter — which is the worst of both.
   */
  readonly purpose?: "spend" | "mint" | "withdraw" | "publish";
  /**
   * The inner Ogmios error code. `3012` is "the script evaluated to False";
   * `3011` is "an associated script witness is missing" — a MALFORMED
   * transaction, not a validator verdict. Both travel through the same `3010`
   * wrapper, so only this number separates "the rail bit" from "we built the
   * transaction wrong" (audit r1 F-3).
   */
  readonly code?: number;
}

/**
 * A negative test that passes because the CLIENT refused proves nothing about
 * the on-chain rail — it proves Evolution has an opinion. These rails live in
 * protocol_params, so the rejection must come from script evaluation.
 *
 * ⛔ AND "SCRIPT EVALUATION FAILED" IS NOT ENOUGH EITHER. MEASURED, audit r1
 * F-1: narrowing `omitAuthority` to drop only the signer moved test 5's refusal
 * from `protocol_params` (`purpose: "spend"`) to `upgrade_multisig`
 * (`purpose: "withdraw"`) — two different validators, two different rails — and
 * the test stayed GREEN, because the wrapper message is byte-identical. So a
 * negative must name WHICH validator refused, or it cannot notice when the rail
 * it documents stops being the rail it exercises.
 *
 * The pointer is supplied by `ogmios-evaluator.ts`, which appends
 * ` [ogmios code=<c> validators=<purpose>@<idx>=<code>,…]` to the message.
 *
 * ⚠ FACTORY, not a predicate — see the guard below.
 */
function assertRejectedByTheValidator(expected: ExpectedRefusal = {}) {
  // ⛔ FOOTGUN GUARD. This used to BE the predicate, so the obvious mistake is
  // to keep passing it bare: `assert.rejects(fn, assertRejectedByTheValidator)`.
  // Node would then call the FACTORY as the validator, and a factory returns a
  // function — truthy — so EVERY negative test would pass unconditionally, in
  // silence. Detect it by the argument node would have passed.
  if (expected instanceof Error) {
    throw new Error(
      "assertRejectedByTheValidator is a FACTORY: call it with parentheses, e.g. " +
        'assertRejectedByTheValidator({ purpose: "spend", code: 3012 }). Passed bare, ' +
        "it makes every negative test pass unconditionally."
    );
  }

  return (err: unknown): true => {
    const msg = String((err as Error)?.message ?? err);
    assert.match(
      msg,
      /Script evaluation failed|terminated with error/,
      "the rejection must come from the VALIDATOR, not from client-side validation — " +
        `got: ${msg.slice(0, 200)}`
    );

    // No expectation supplied ⇒ behave exactly as this guard always has.
    if (expected.purpose === undefined && expected.code === undefined) return true;

    const m = msg.match(/\[ogmios code=(\d+)(?: validators=([^\]]*))?\]/);
    assert.ok(
      m,
      "expected an Ogmios pointer in the message, but found none. The evaluator " +
        "appends it on every evaluation failure, so its absence means the refusal did not " +
        `come from script evaluation at all — got: ${msg.slice(0, 300)}`
    );

    const entries = (m![2] ?? "")
      .split(",")
      .filter(Boolean)
      .map((e) => {
        const parts = e.match(/^(\w+)@(\d+)=(\d+)$/);
        assert.ok(parts, `unparseable Ogmios validator entry ${JSON.stringify(e)}`);
        return { purpose: parts![1]!, code: Number(parts![3]!) };
      });
    assert.ok(entries.length > 0, `the Ogmios pointer named no validator — got: ${msg.slice(0, 300)}`);

    if (expected.purpose !== undefined) {
      // ⚑ SET EQUALITY, not "some entry matches". Ogmios reports EVERY failing
      // script, so "at least one is a spend" would still pass if a second
      // validator had begun failing alongside it — which is new information and
      // must redden rather than hide.
      const purposes = [...new Set(entries.map((e) => e.purpose))].sort();
      assert.deepEqual(
        purposes,
        [expected.purpose],
        `the refusal must come from ${expected.purpose}, and from nothing else — got ` +
          `${JSON.stringify(purposes)} in: ${msg.slice(0, 300)}`
      );
    }
    if (expected.code !== undefined) {
      for (const e of entries) {
        assert.equal(
          e.code,
          expected.code,
          `expected Ogmios ${expected.code} from ${e.purpose}, got ${e.code} — ` +
            `3012 is a validator verdict, 3011 is a malformed transaction, and they are ` +
            `not interchangeable evidence. In: ${msg.slice(0, 300)}`
        );
      }
    }
    return true;
  };
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
    // ⛔ THE ACT IS DECLARED, NOT DEFAULTED. `protocol_upgrade` is the only arm
    // that permits rewriting a mutable credential; it also FREEZES both
    // `upgrade_cred` and `pending_upgrade_cred`, which is what the untouched
    // block below then verifies from the chain rather than from this call.
    act: "PROTOCOL_UPGRADE",
    change: (p) => ({ ...p, transferCred: { type: "script", hash: newTransferCred } }),
  });

  const after = (await readCoordination(client, deployment)).params;

  // THE DELTA — the point of the whole ticket.
  assert.notEqual(after.transferCred.hash, before.transferCred.hash, "transfer_cred must have moved");
  assert.equal(after.transferCred.hash, newTransferCred, "and moved to the credential we chose");

  // Everything else must be untouched. An upgrade that quietly rewrites a
  // neighbouring field is indistinguishable from a correct one if you only
  // assert the field you meant to change.
  // ⚠ ALL FIVE REMAINING FIELDS OF THE SIX-FIELD alpha.4 DATUM, NAMED. A list
  // of "these must be unmoved" only ever detects removals and decays into a
  // stale subset — and the member it stops noticing is the NEWEST one, which is
  // the one least likely to be covered anywhere else. Here that is
  // `issuanceLogicCred`, added in alpha.4, which DISPLACED `transferCred` from
  // datum index 1: a field-order defect would move exactly this pair.
  assert.equal(after.plgCred.hash, before.plgCred.hash, "dispatcher untouched");
  assert.equal(
    after.issuanceLogicCred.hash,
    before.issuanceLogicCred.hash,
    "issuance_logic untouched — the newest field, and the one adjacent to the one we moved"
  );
  assert.equal(after.thirdPartyCred.hash, before.thirdPartyCred.hash, "third_party untouched");

  // The two the ARM itself freezes. `protocol_upgrade` requires
  // `new.upgrade_cred == old.upgrade_cred` AND
  // `new.pending_upgrade_cred == old.pending_upgrade_cred`, so asserting these
  // from the chain is what tests the arm rather than our own `change` function.
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "upgrade authority untouched");
  assert.equal(after.upgradeCred.type, before.upgradeCred.type, "and still the same KIND of credential");
  // ⚑ THE AUTHORITY THAT JUST AUTHORISED THIS IS A SCRIPT. Asserted positively,
  // not merely "unchanged": this is the first-ever on-chain satisfaction of a
  // MultisigScript in this repo, and "unchanged" would pass just as happily on
  // the old KEY-authority fixture.
  assert.equal(after.upgradeCred.type, "script", "the upgrade authority is the upgrade_multisig SCRIPT");
  assert.equal(
    after.upgradeCred.hash,
    deployment.upgradeMultisig.scriptHash,
    "and it is THIS deployment's upgrade_multisig"
  );
  // ⚑ AN IDENTITY, NOT AN ABSENCE. `protocol_upgrade` freezes the nomination,
  // and that freeze is untested from any other direction — a handover must not
  // be able to begin inside a transaction presenting itself as a parameter
  // change.
  assert.equal(before.pendingUpgradeCred, null, "no handover was in flight before");
  assert.equal(after.pendingUpgradeCred, null, "and protocol_upgrade did not start one");

  // ⚠ unfracking_cred and max_inline_datum_bytes are NOT asserted here because
  // they are no longer datum fields — see the designed-out block below.
});

/**
 * The rail: `sitting_authority_approves` is
 * `pairs.has_key(withdrawals, old.upgrade_cred)`, and on alpha.4
 * `old.upgrade_cred` is a SCRIPT credential — the upgrade_multisig. So this now
 * proves the trampoline bites against a script authority, which is a different
 * lookup in the withdrawals map from the key credential it used to exercise.
 */
test("REFUSED: an upgrade without the authority's withdraw-0", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        act: "PROTOCOL_UPGRADE",
        // ⛔ `omitAuthority` drops the WHOLE authorisation, on both branches —
        // no withdrawal, no script witness, no reference input, no signer. It
        // must stay that way: dropping only the withdrawal would quietly turn
        // this into a test of a narrower thing while still going red.
        omitAuthority: true,
        change: (p) => ({ ...p, transferCred: { type: "script", hash: "ab".repeat(28) } }),
      }),
    // ⛔ `purpose: "spend"` IS THE WHOLE POINT OF THIS ASSERTION. The rail under
    // test — `sitting_authority_approves` — lives in `protocol_params`; without
    // pinning the purpose this test passes just as happily when the refusal comes
    // from `upgrade_multisig` instead, which is a different validator enforcing a
    // different rail (measured: audit r1 F-1, mutant A1).
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
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
  //
  // ⚠ ON alpha.4 THIS NOW VIOLATES TWO RULES AT ONCE, and it matters which one
  // answers. `params_wellformed` refuses the 20-byte hash on BOTH handlers, and
  // `protocol_upgrade` separately freezes `upgrade_cred` (`new.upgrade_cred ==
  // old.upgrade_cred`), which this change also breaks. Both live inside the
  // same script evaluation, so both surface identically as Ogmios 3010 and the
  // test stands either way — but the two rails are not interchangeable
  // evidence, and a future reader must not read a green here as proof that the
  // well-formedness rail specifically fired. OBSERVED on devnet 2026-09-10:
  // Ogmios 3010 wrapping 3012 at `validator {index, purpose: "spend"}`, with no
  // traces, which is the shape both rails produce.
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        act: "PROTOCOL_UPGRADE",
        change: (p) => ({ ...p, upgradeCred: { type: "key", hash: "ab".repeat(20) } }),
      }),
    // Tightened alongside test 5. Both rails this change violates live in
    // `protocol_params`, so `spend` is right; `3012` additionally forbids a
    // `3011` from masquerading as a validator verdict here (audit r1 F-3 named
    // this test as the exposed one). ⚠ It does NOT say WHICH of the two rails
    // fired — that isolation is F-4, seated for T-F05.
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
    "a 20-byte upgrade_cred must be rejected — it would brick the protocol permanently"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "authority unchanged");
});
