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
 * ⚠⚠ AND SO ARE THE HANDOVER TESTS — `nominateAuthority` AND `promoteAuthority`
 * ARE FIRST-EVER EXECUTIONS TOO. `NominateAuthority` and `PromoteAuthority` had
 * never been submitted by anything, anywhere, before the tests below. There is
 * no prior working state, so "no regression" is not the success criterion here
 * either: each is ONE OBSERVATION. That qualifier is part of the acceptance,
 * not a footnote to it.
 *
 * ⛔ WHAT THE ACT PARAMETER SETTLES, AND WHAT REMAINS TRUE BY CONSTRUCTION.
 * Every test here passes `act:` explicitly, and `upgradeProtocol` routes all
 * three arms through ONE `protocolParamsRedeemer(...)` call site.
 *
 *   * SETTLED, on chain, by the handover tests below. `NominateAuthority` and
 *     `PromoteAuthority` encode as `Constr(1, [])` and `Constr(2, [])` — two
 *     values `voidData()` (which is `Constr(0, [])`) CANNOT PRODUCE. A green
 *     nominate and a green promote therefore prove that that single call site
 *     genuinely encodes the arm it is given, because had it been emitting
 *     `voidData()` the validator would have run `protocol_upgrade` against a
 *     datum whose `upgrade_cred`/`pending_upgrade_cred` had moved, and refused.
 *     Mutations P2 and P3 (swapping the two arms) are the negative half of the
 *     same proof: both are refused on chain.
 *   * NOT SETTLED, AND NEVER WILL BE. Arm 0's bytes are byte-identical to
 *     `voidData()`'s, so no decoder on chain or off can distinguish a
 *     `protocolParamsRedeemer("PROTOCOL_UPGRADE")` caller from a stale
 *     `voidData()` one. ⇒ **That residue is closed BY CONSTRUCTION — one call
 *     site, no default on `act` — NOT BY DEMONSTRATION**, and no devnet run can
 *     ever close it. Whoever changes `UpgradeOptions.act` or that call site is
 *     removing the only guarantee arm 0 has.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { requireDevnet, makeClient, settleWallet, waitFor } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import {
  readCoordination,
  upgradeProtocol,
  nominateAuthority,
  promoteAuthority,
  withdrawalCredentials,
} from "../harness/upgrade.js";
import {
  stakingCredentialHash,
  EvoAddress,
  EvoAssets,
  EvoTransactionHash,
  type Cip113Credential,
  type DeploymentParams,
} from "../../dist/index.js";
import {
  Withdrawals as EvoWithdrawals,
  RewardAccount as EvoRewardAccount,
  Credential as EvoCredential,
  Bytes as EvoBytes,
} from "@evolution-sdk/evolution";

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

/**
 * The nominee K: the bootstrapping wallet's own stake KEY, as a CIP-113
 * credential. Read from the wallet, not hardcoded, so it is the same credential
 * `bootstrap.ts` registered.
 *
 * ⛔ HAZARD 3 — A KEY WITHDRAW-0 NEEDS A FOURTH THING. A script withdraw-0
 * needs the withdrawal entry, a script witness and a registered stake
 * credential. A KEY one needs a **DRep delegation** on top: Conway rejects a
 * withdrawal from a credential that does not engage in on-chain governance with
 * code **3150**, *"credentials that do not engage in on-chain governance"*, EVEN
 * FOR A ZERO WITHDRAWAL. `bootstrap.ts` tx3/tx4 registers AND `AlwaysAbstain`-
 * delegates this exact key so a promotion can present it.
 *
 * ⇒ If a promotion below ever fails with 3150, the defect is in the bootstrap's
 * idempotence (a key registered by an earlier run and never delegated), NOT in
 * these tests or in `promoteAuthority`.
 */
async function nomineeKey(client: any): Promise<Cip113Credential> {
  const bech32 = EvoAddress.toBech32(await client.address());
  return { type: "key", hash: stakingCredentialHash(bech32) };
}

/**
 * Wait until the provider agrees the protocol-params UTxO is the one `txHash`
 * produced, then let the wallet view settle too.
 *
 * ⚠ REQUIRED BETWEEN CHAINED PHASES, and it is not decoration. Kupo trails the
 * node: immediately after a confirmed spend of the params UTxO, `getUtxos`
 * still reports the SPENT one. The next phase would then build against a UTxO
 * the node knows is gone and be rejected with code 3117, "unknown UTxO
 * references as inputs" — an error that names a UTxO and reads like a builder
 * defect. The bootstrap settles at its own entry and exit; a test chaining
 * nominate → promote → upgrade owns the gaps in between (yaci.mjs
 * `settleWallet`'s own note).
 *
 * ⚑ It waits on the UTxO's PRODUCING TRANSACTION, never on the datum content.
 * Waiting until the datum says what the test is about to assert would make the
 * assertion circular — it could then only ever time out, never fail with a
 * value. This waits on a coordinate and leaves every claim about content to the
 * assertions.
 */
async function settleParams(
  client: any,
  deployment: DeploymentParams,
  txHash: string
): Promise<void> {
  await waitFor(
    async () => {
      const { utxo } = await readCoordination(client, deployment);
      return EvoTransactionHash.toHex(utxo.transactionId) === txHash;
    },
    {
      timeoutMs: 90_000,
      intervalMs: 1_000,
      what: `the protocol-params UTxO to be the output of ${txHash}`,
    }
  );
  await settleWallet(client, await client.address());
}

/**
 * Read the protocol-params datum AND the continuing output's ADA leg together.
 *
 * ⚑ THE ADA LEG IS READ FROM CHAIN, NOT FROM THE BUILDER'S ARITHMETIC. The
 * harness computes a min-UTxO floor for the continuing output; asserting that
 * computation against itself would be a tautology. This reads what the output
 * actually carries, so the "never below the input" claim is a comparison of two
 * independent chain observations.
 */
async function readParamsAndAda(
  client: any,
  deployment: DeploymentParams
): Promise<{ params: Awaited<ReturnType<typeof readCoordination>>["params"]; lovelace: bigint }> {
  const { utxo, params } = await readCoordination(client, deployment);
  return { params, lovelace: EvoAssets.lovelaceOf(utxo.assets) };
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

// ---------------------------------------------------------------------------
// The two-phase authority handover (T-F03-3)
//
// Upstream splits a handover into two transactions on purpose: a direct rewrite
// of `upgrade_cred` would reinstate the one-way brick (a typo, or the hash of a
// script nobody deployed, takes the protocol over and nothing can ever move it
// back). The evidence the two phases demand instead is that the INCOMING
// authority exists, runs and consents — which is what the nominee's own
// withdraw-0 in phase two is.
//
// ⛔ THE ASYMMETRY THAT DECIDES EVERY TEST BELOW. `protocol_upgrade` and
// `nominate_authority` both require the SITTING authority's withdraw-0.
// `promote_authority` requires the NOMINEE's, and ONLY the nominee's — the
// sitting authority does not appear in a promotion at all. A reader who assumes
// symmetry will add the sitting authority's withdrawal and never notice,
// because an extra withdrawal is not refused; it is simply not what the rule
// reads. Mutation P1 is what proves this was implemented rather than assumed.
// ---------------------------------------------------------------------------

test("the upgrade authority is handed over from the multisig to a key — a before/after delta", async () => {
  // ⚠⚠ A FIRST-EVER EXECUTION, TWICE OVER. Neither `nominate_authority` nor
  // `promote_authority` had ever been submitted by this repo — or, as far as
  // this repo knows, by anything — before this test. A green here is ONE
  // OBSERVATION apiece with nothing behind it: not restored parity, not "no
  // regression". Both qualifiers are part of what this test asserts.
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const K = await nomineeKey(client);

  // ---- step 1: the sitting state, read from chain -------------------------
  const genesisRead = await readParamsAndAda(client, deployment);
  const genesis = genesisRead.params;
  assert.equal(genesis.upgradeCred.type, "script", "the bootstrap installs a SCRIPT authority");
  assert.equal(
    genesis.upgradeCred.hash,
    deployment.upgradeMultisig.scriptHash,
    "and it is THIS deployment's upgrade_multisig — the BEFORE half of the delta"
  );
  assert.equal(genesis.pendingUpgradeCred, null, "and no handover is in flight");

  // ---- step 2: NOMINATE — phase one ---------------------------------------
  // Authorised by the SITTING authority (the multisig), through the routed
  // branch `upgradeProtocol` already had. Nothing takes effect: the nominee
  // holds no power at all until it activates itself.
  const nomination = await nominateAuthority(blueprint, deployment, K);
  await settleParams(client, deployment, nomination.txHash);
  const nominatedRead = await readParamsAndAda(client, deployment);
  const nominated = nominatedRead.params;

  // ⚑ THE RECORD, NOT THE ABSENCE OF A CHANGE. "nothing else moved" would pass
  // just as happily if the nomination had silently not been written — a test
  // that passes because nothing happened cannot tell you WHY nothing happened.
  // So: the nomination IS `Some`, it IS a key credential, and it names EXACTLY
  // K.
  assert.notEqual(nominated.pendingUpgradeCred, null, "a nomination must be standing");
  assert.equal(nominated.pendingUpgradeCred!.type, "key", "the nominee is a KEY credential");
  assert.equal(
    nominated.pendingUpgradeCred!.hash,
    K.hash,
    "and it is exactly K — the wallet's own registered, DRep-delegated stake key"
  );
  // And `upgrade_cred` has NOT moved. Phase one changes who MAY take over, not
  // who HAS authority.
  assert.equal(nominated.upgradeCred.type, "script", "the sitting authority is still a script");
  assert.equal(
    nominated.upgradeCred.hash,
    deployment.upgradeMultisig.scriptHash,
    "and still the upgrade_multisig — a nomination moves nothing"
  );

  // ⚑⚑ THE POSITIVE CONTROL FOR THE EXCLUSIVITY ASSERTION BELOW, and without it
  // that assertion could pass on an instrument that simply cannot see script
  // withdrawals. Before believing a zero, produce a known non-zero THROUGH THE
  // SAME INSTRUMENT: a nomination is authorised by the SITTING authority, so
  // `withdrewFrom` here must be exactly the multisig's SCRIPT credential.
  assert.deepEqual(
    [...nomination.withdrewFrom],
    [{ type: "script", hash: deployment.upgradeMultisig.scriptHash }],
    "a nomination withdraws from the sitting authority — and this run proves the withdrawal " +
      "reader can SEE a script credential, which is what makes the promotion's 'no script " +
      "withdrawal' below a real negative rather than a silent empty list"
  );

  // The ADA leg never falls. See the promote step for why this is asserted at
  // every phase rather than only where the datum shrinks.
  assert.ok(
    nominatedRead.lovelace >= genesisRead.lovelace,
    `a nomination must never lower the protocol UTxO's ADA: ${genesisRead.lovelace} -> ` +
      `${nominatedRead.lovelace}`
  );

  // ---- step 3: PROMOTE — phase two ----------------------------------------
  // ⛔ AUTHORISED BY THE NOMINEE, NOT BY THE MULTISIG. See the asymmetry note
  // above the block. `promoteAuthority` takes no nominee argument: it reads the
  // nominee out of the datum, because the datum is what the validator reads.
  const promotion = await promoteAuthority(blueprint, deployment);
  await settleParams(client, deployment, promotion.txHash);
  const promotedRead = await readParamsAndAda(client, deployment);
  const promoted = promotedRead.params;

  // THE DELTA — the point of the whole slice. Both halves, from chain.
  assert.equal(promoted.upgradeCred.type, "key", "the authority is now a KEY credential");
  assert.equal(promoted.upgradeCred.hash, K.hash, "and it is K — the AFTER half of the delta");
  assert.equal(promoted.pendingUpgradeCred, null, "and the nomination is consumed");

  // `promote_authority` is a PURE RECORD EQUALITY: the only permitted
  // difference is that the nomination became the authority. Asserted from
  // chain, field by field, against the state read after phase one.
  assert.equal(promoted.plgCred.hash, nominated.plgCred.hash, "dispatcher unmoved by the promotion");
  assert.equal(
    promoted.issuanceLogicCred.hash,
    nominated.issuanceLogicCred.hash,
    "issuance_logic unmoved — the newest field, and the one a field-order defect would move"
  );
  assert.equal(promoted.transferCred.hash, nominated.transferCred.hash, "transfer unmoved");
  assert.equal(promoted.thirdPartyCred.hash, nominated.thirdPartyCred.hash, "third_party unmoved");

  // ⛔⛔ THE PROMOTION WITHDREW FROM THE NOMINEE AND FROM NOBODY ELSE — AND THIS
  // IS THE ONE PROPERTY IN THIS FILE THAT NO ON-CHAIN NEGATIVE CAN EVER COVER.
  //
  // Upstream's rail is `pairs.has_key(withdrawals, nominee)`: an EXISTENCE
  // check that never mentions `old.upgrade_cred`. A promotion carrying the
  // nominee's withdrawal AND the sitting multisig's is therefore ACCEPTED on
  // chain. Mutation P1 proves the nominee's withdrawal is NECESSARY; it says
  // nothing about the multisig's being ABSENT, and that too-broad direction is
  // the one nobody runs.
  //
  // ⚠ WHY IT MATTERS, in one sentence: a promotion that also carries the
  // outgoing authority's withdraw-0 REQUIRES THE OUTGOING AUTHORITY'S
  // COOPERATION — destroying the exact property the two-phase design exists to
  // provide, which is that a nominee can activate itself when the sitting
  // multisig is unavailable, has lost quorum, or is hostile. A maintainer
  // "being safe" would introduce it, and every on-chain test would stay green.
  //
  // ⚑ ASSERTED OFF-CHAIN, ON THE BUILT TRANSACTION. `withdrewFrom` is read from
  // `built.toTransaction()`, not from a note of what the builder intended — see
  // `withdrawalCredentials` in the harness. The auditor's attempt to demonstrate
  // this on chain was INCONCLUSIVE (`withdraw@1=3110`, "Extraneous
  // (non-required) redeemers" — a malformed transaction of the experiment's own
  // making), which is itself the argument for asserting it here.
  assert.deepEqual(
    [...promotion.withdrewFrom],
    [K],
    "the promotion must withdraw from the nominee K and from nobody else"
  );
  // ⚠ NOT REDUNDANT WITH THE deepEqual ABOVE, and deliberately kept separate:
  // this one names the specific credential whose presence is the harm, so it
  // still fires — and still says WHY — if the exact-list assertion is ever
  // loosened to a length or membership check by someone adding a legitimate
  // second withdrawal for an unrelated reason.
  assert.ok(
    !promotion.withdrewFrom.some((c) => c.hash === deployment.upgradeMultisig.scriptHash),
    `the promotion must NOT withdraw from the sitting multisig ` +
      `(${deployment.upgradeMultisig.scriptHash}) — a promotion that needs the outgoing ` +
      `authority's cooperation is not a promotion. Got: ${JSON.stringify(promotion.withdrewFrom)}`
  );

  // ⛔ THE ADA LEG NEVER FALLS, AND THE PROMOTION IS THE PHASE THAT COULD MAKE
  // IT. A promotion SHRINKS the datum `Some(Credential)` -> `None`, so a floor
  // computed from the new datum alone would re-set this output DOWN. MEASURED,
  // audit r1 M11: replacing the harness's `minUtxoAtLeast(lovelaceOf(carried),
  // …)` floor with `0n` drifts 2,012,770 -> 1,861,920 — **150,850 lovelace per
  // promotion**, out of the protocol UTxO and into the wallet's change — and the
  // suite was GREEN. alpha.4 leaves lovelace unconstrained, so the chain permits
  // it. This assertion is what makes M11 redden.
  assert.ok(
    promotedRead.lovelace >= nominatedRead.lovelace,
    `a promotion must never lower the protocol UTxO's ADA, even though the datum shrinks: ` +
      `${nominatedRead.lovelace} -> ${promotedRead.lovelace}`
  );

  // ⚑ THE DELTA, PRINTED. Not decoration: the assertions above prove the
  // handover happened, and this line is what lets a reader of a run log say
  // WHICH credentials it happened between. A green row records that a
  // comparison held; only the values record what was compared.
  console.error(
    `  [handover] upgrade_cred: ${genesis.upgradeCred.type}/${genesis.upgradeCred.hash}` +
      ` -> ${promoted.upgradeCred.type}/${promoted.upgradeCred.hash}`
  );

  // ---- step 4: the new authority actually AUTHORISES ----------------------
  // ⛔ THIS IS THE STEP THAT PROVES THE HANDOVER IS REAL rather than merely
  // written. A datum naming K is a claim; K spending the params UTxO is the
  // fact. `upgradeProtocol` routes on the DATUM's credential, so this upgrade
  // takes the KEY branch of that router.
  //
  // ⚑ AND IT REVIVES A BRANCH THAT WAS DEAD IN COVERAGE (T-F03-2 audit F-5):
  // every devnet test installs a SCRIPT authority, so nothing anywhere
  // executed `upgradeProtocol`'s key path. After this promotion it does.
  //
  // ⚠ A SYNTHETIC 28-BYTE HASH IS ADMISSIBLE HERE and it is a deliberate scope
  // limit, not laziness. The claim under test is "K can authorise a parameter
  // change", and `protocol_params` requires of `transfer_cred` only that it be
  // 28 bytes — it never dereferences it. This step therefore says NOTHING about
  // whether the resulting protocol can still transfer a token; it is the last
  // step against a throwaway fixture and it is not asked to.
  const newTransferCred = "5e".repeat(28);
  assert.notEqual(
    newTransferCred,
    promoted.transferCred.hash,
    "the swap must actually change something"
  );
  const upgradeHash = await upgradeProtocol(blueprint, deployment, {
    act: "PROTOCOL_UPGRADE",
    change: (p) => ({ ...p, transferCred: { type: "script", hash: newTransferCred } }),
  });
  await settleParams(client, deployment, upgradeHash.txHash);
  const underKRead = await readParamsAndAda(client, deployment);
  const underK = underKRead.params;

  assert.equal(underK.transferCred.hash, newTransferCred, "K authorised a real parameter change");
  assert.notEqual(
    underK.transferCred.hash,
    promoted.transferCred.hash,
    "and the credential genuinely moved"
  );
  assert.equal(underK.upgradeCred.type, "key", "K is still the authority afterwards");
  assert.equal(underK.upgradeCred.hash, K.hash, "and still exactly K");
  assert.equal(underK.pendingUpgradeCred, null, "and a ProtocolUpgrade started no new handover");

  // K authorises with its own KEY withdraw-0 and nothing else — the mirror of
  // the promotion assertion, on the arm that now routes through
  // `upgradeProtocol`'s revived key branch.
  assert.deepEqual(
    [...upgradeHash.withdrewFrom],
    [K],
    "an upgrade under K withdraws from K — the multisig is no longer involved in this protocol"
  );
  assert.ok(
    underKRead.lovelace >= promotedRead.lovelace,
    `an upgrade must never lower the protocol UTxO's ADA: ${promotedRead.lovelace} -> ` +
      `${underKRead.lovelace}`
  );
});

/**
 * R-5, direction one. `protocol_upgrade` requires
 * `new.pending_upgrade_cred == old.pending_upgrade_cred`, so a handover can
 * never BEGIN inside a transaction presenting itself as a parameter change.
 *
 * ⚑ POSITIVE CONTROL, ONE VARIABLE APART: the same nomination submitted under
 * `act: "NOMINATE_AUTHORITY"` is exactly step 2 of test 1, and must have
 * succeeded in this same run. Without that neighbour this test would prove the
 * validator refuses things, not that it refuses the right thing.
 */
test("REFUSED: a nomination cannot ride inside a ProtocolUpgrade", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const K = await nomineeKey(client);
  const before = (await readCoordination(client, deployment)).params;
  assert.equal(before.pendingUpgradeCred, null, "fixture precondition: nothing nominated yet");

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        // The sitting authority's withdrawal IS present and IS valid — this
        // transaction is refused for its SHAPE, not for its authorisation.
        act: "PROTOCOL_UPGRADE",
        change: (p) => ({ ...p, pendingUpgradeCred: K }),
      }),
    // `spend` is `protocol_params`, where this rail lives. `3012` is a
    // validator verdict; `3011` would be a malformed transaction, and the two
    // are not interchangeable evidence.
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
    "a ProtocolUpgrade that writes a nomination must be rejected"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.pendingUpgradeCred, null, "no nomination was written");
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "and the authority did not move");
});

/**
 * R-5, direction two. `nominate_authority` is ONE RECORD EQUALITY over
 * everything except the nomination, so a parameter change can never ride
 * inside a handover's first phase.
 *
 * ⚑ POSITIVE CONTROL, ONE VARIABLE APART: remove the `transferCred` line below
 * and this is test 1's step 2 verbatim, which succeeded in this same run. The
 * single variable between the green and the red is the smuggled parameter.
 */
test("REFUSED: a parameter change cannot ride inside a NominateAuthority", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const K = await nomineeKey(client);
  const before = (await readCoordination(client, deployment)).params;

  await assert.rejects(
    () =>
      upgradeProtocol(blueprint, deployment, {
        act: "NOMINATE_AUTHORITY",
        change: (p) => ({
          ...p,
          pendingUpgradeCred: K,
          transferCred: { type: "script", hash: "cd".repeat(28) },
        }),
      }),
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
    "a NominateAuthority carrying a parameter change must be rejected"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.pendingUpgradeCred, null, "the nomination did not land either");
  assert.equal(after.transferCred.hash, before.transferCred.hash, "and transfer did not move");
});

/**
 * The rail: `pairs.has_key(withdrawals, nominee)` inside `promote_authority`.
 * This is the evidence upstream demands — that the incoming authority exists,
 * runs and consents — and it is the ONLY thing standing between a nomination
 * and a takeover.
 */
test("REFUSED: a promotion without the nominee's own withdraw-0", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const K = await nomineeKey(client);

  const nomination = await nominateAuthority(blueprint, deployment, K);
  await settleParams(client, deployment, nomination.txHash);
  const before = (await readCoordination(client, deployment)).params;
  assert.equal(before.pendingUpgradeCred!.hash, K.hash, "precondition: K is the standing nominee");

  await assert.rejects(
    () => promoteAuthority(blueprint, deployment, { omitNomineeWithdrawal: true }),
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
    "a promotion with no withdrawal from the nominee must be rejected"
  );

  // ⚑ A REJECTED TRANSACTION THAT MOVED SOMETHING WOULD BE WORSE THAN ONE THAT
  // SUCCEEDED. Both halves of the state, asserted as records.
  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.upgradeCred.type, "script", "the authority is still the multisig");
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "and did not move");
  assert.notEqual(after.pendingUpgradeCred, null, "and the nomination is STILL standing");
  assert.equal(after.pendingUpgradeCred!.hash, K.hash, "and still names exactly K");
});

/**
 * The rail: `promote_authority`'s record equality — the only permitted
 * difference is that the nomination became the authority.
 *
 * Upstream's reason, which is the whole argument for splitting the phases:
 * nomination and revocation RACE BY CONSTRUCTION. If the nominee wins that
 * race, the outcome must be the handover the sitting authority already
 * consented to — never that handover PLUS an arbitrary protocol change
 * smuggled into the very transaction the sitting authority was trying to
 * abort.
 *
 * ⚑ POSITIVE CONTROL, ONE VARIABLE APART: drop `smuggleChange` and this is
 * test 1's step 3, which succeeded in this same run.
 */
test("REFUSED: a promotion cannot smuggle a parameter change", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const K = await nomineeKey(client);

  const nomination = await nominateAuthority(blueprint, deployment, K);
  await settleParams(client, deployment, nomination.txHash);
  const before = (await readCoordination(client, deployment)).params;
  assert.equal(before.pendingUpgradeCred!.hash, K.hash, "precondition: K is the standing nominee");

  await assert.rejects(
    () =>
      promoteAuthority(blueprint, deployment, {
        // The nominee's withdrawal IS present and IS valid. The single variable
        // is the extra field in the continuing datum.
        smuggleChange: (p) => ({
          ...p,
          thirdPartyCred: { type: "script", hash: "ef".repeat(28) },
        }),
      }),
    assertRejectedByTheValidator({ purpose: "spend", code: 3012 }),
    "a promotion carrying a parameter change must be rejected"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "the authority did not move");
  assert.equal(after.thirdPartyCred.hash, before.thirdPartyCred.hash, "third_party did not move");
  assert.equal(after.pendingUpgradeCred!.hash, K.hash, "and the nomination is still standing");
});

/**
 * The CLIENT-SIDE veto, and the one refusal in this file that is deliberately
 * NOT asserted through `assertRejectedByTheValidator` — because the whole point
 * is that it never reaches a validator.
 *
 * ⛔ MEASURED, mutation P4 (2026-09-10, this devnet): delete this guard, make
 * `requireNominee` fall back to the sitting authority so the transaction is
 * actually built, and promote a protocol whose `pending_upgrade_cred` is
 * `None`. The result is an ON-CHAIN refusal from
 * `expect Some(nominee) = old.pending_upgrade_cred`, reported by Ogmios as:
 *
 *     code 3012, validationError "An error has occurred: The machine
 *     terminated because of an error, either from a built-in function or from
 *     an explicit use of 'error'", **traces: []**
 *
 * ⇒ THAT MESSAGE NAMES NOTHING. Not the field, not the protocol, not the
 * remedy — and it is byte-indistinguishable from the four legitimate refusals
 * above. A check that fires before anything is built or spent has already won
 * (verification-harness §16b), and here it additionally converts a bare 3012
 * into a sentence a caller can act on.
 *
 * This test costs nothing on chain: it asserts the guard fires BEFORE any
 * transaction exists, which is the property.
 */
test("REFUSED, client-side: promoting a protocol with no standing nomination", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const before = (await readCoordination(client, deployment)).params;
  assert.equal(before.pendingUpgradeCred, null, "fixture precondition: nothing is nominated");

  await assert.rejects(
    () => promoteAuthority(blueprint, deployment),
    // ⚑ THE MESSAGE IS THE ASSERTION. `assert.rejects(fn)` alone passes on ANY
    // rejection, including the very on-chain 3012 this guard exists to
    // pre-empt — so the pattern below is what distinguishes "refused early, by
    // name" from "refused late, by nothing".
    /no standing nomination.*pending_upgrade_cred is None/s,
    "promoteAuthority must refuse by name, client-side, before building anything"
  );

  const after = (await readCoordination(client, deployment)).params;
  assert.equal(after.pendingUpgradeCred, null, "and nothing was submitted");
  assert.equal(after.upgradeCred.hash, before.upgradeCred.hash, "and the authority did not move");
});

/**
 * R-1 (T-F03-3 audit residue) — `withdrawalCredentials`'s multi-entry path.
 *
 * PURE OFFLINE, NO CHAIN. Every transaction the rest of this suite builds
 * carries exactly one withdrawal, so a mutant that truncates the reader to
 * its first entry changes nothing observable anywhere else in this file —
 * that survivor is the auditor's N5. This test constructs its own two-entry
 * `Withdrawals` (one `makeScriptHash`, one `makeKeyHash`) and reads it back,
 * so the property is pinned on the reader itself rather than on anything the
 * ledger decides. It is gated behind this file's `before(requireDevnet)` like
 * every test here — it needs no chain, but it runs with the devnet subset.
 *
 * Order asserted: `Withdrawals` is backed by a JS `Map`, `fromEntries` builds
 * that map from the array given (`new Map(entries)`, insertion order), and
 * `Withdrawals.entries()` is `Array.from(map.entries())` — so the order out
 * is the order given to `fromEntries`, here [script, key].
 */
test("withdrawalCredentials reads back a TWO-entry withdrawal set in full — not truncated to the first", () => {
  const scriptHashHex = "aa".repeat(28);
  const keyHashHex = "bb".repeat(28);

  const scriptAccount = new EvoRewardAccount.RewardAccount({
    networkId: 0,
    stakeCredential: EvoCredential.makeScriptHash(EvoBytes.fromHex(scriptHashHex)),
  });
  const keyAccount = new EvoRewardAccount.RewardAccount({
    networkId: 0,
    stakeCredential: EvoCredential.makeKeyHash(EvoBytes.fromHex(keyHashHex)),
  });
  const withdrawals = EvoWithdrawals.fromEntries([
    [scriptAccount, 0n],
    [keyAccount, 0n],
  ]);
  const fakeBuiltTx = { body: { withdrawals } } as any;

  const creds = withdrawalCredentials(fakeBuiltTx);

  // The N5 mutant (truncate to withdrawals.entries[0] only) leaves this at
  // length 1, missing the key entry entirely — `deepEqual` on the full,
  // ordered array is what kills it; a length-only assertion would not.
  assert.deepEqual(
    creds,
    [
      { type: "script", hash: scriptHashHex },
      { type: "key", hash: keyHashHex },
    ],
    "both entries must come back, in the order they were given, with the right tags"
  );
});

// ⛔ The two `retryTransient` guards that stood here in round 1 have MOVED to
// `test/retry.test.mjs`. They were pure offline logic gated behind this file's
// `before(requireDevnet)`, so the invariant "no ledger verdict is ever retried"
// was defended only on a machine with a live devnet — and CI does not run
// test:devnet. `npm test` globs `test/*.test.mjs`, so they now run on every
// push. The withdrawalCredentials reader above stays here: it belongs with the
// upgrade harness (T-F03-3 residue R-1).
