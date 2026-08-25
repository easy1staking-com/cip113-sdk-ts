/**
 * dummy token lifecycle on a live devnet (T-D08).
 *
 * This is where T-D04's withdrawal ordering stops being DERIVED and becomes
 * OBSERVED — but ONLY if the fixture is built to distinguish the two candidate
 * orderings. A transfer carrying only SCRIPT withdrawals cannot: script-first
 * and key-first agree on the answer when there are no key credentials present,
 * so the run would confirm T-D04 vacuously while looking like observation.
 *
 * So the ordering assertion below is computed over a MIXED set.
 *
 * Pre-registered prediction (before running): a transfer is the first thing that
 * exercises programmable_logic_base's withdraw-0 dispatch, and Conway rejects a
 * withdrawal — even a zero one — from a credential not delegated to a DRep
 * (code 3150, OBSERVED in T-D07 for a key credential). If the three script
 * delegates hit 3150, that is the PREDICTED case and the fix is
 * register-and-delegate. If they do NOT, that is also a result: it would mean
 * 3150 scopes differently for script credentials than for key ones.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Address as EvoAddress } from "@evolution-sdk/evolution";
import { dummySubstandard } from "../../dist/substandards/dummy/index.js";
import {
  CIP113,
  stringToHex,
  baseAddress,
  compareWithdrawalKeys,
  sortWithdrawalKeys,
  withdrawalIndexOf,
} from "../../dist/index.js";
import { dummyBlueprintPath } from "../harness/paths.js";
import { readFileSync } from "node:fs";
import { requireDevnet, makeClient, waitFor } from "../harness/yaci.mjs";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";
import { recipientAddress } from "../harness/recipient.js";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";

before(async () => {
  await requireDevnet();
});

test("BLOCKED: the bundled dummy blueprint cannot register its withdraw-0 credentials", async () => {
  // ⛔ Asserts the BLOCKER, so this file fails the moment it is lifted — the same
  // discipline the standard-side bootstrap used, and for the same reason: a
  // skipped test is invisible and a permanently red one trains people to ignore
  // failures.
  //
  // WHEN THIS FAILS, the fix is to delete this test and restore the lifecycle
  // assertions preserved in `dummyLifecycleAssertions()` below.
  //
  // ⚠ And note what the standard side taught us: a blocker can vanish because it
  // was FIXED or because it was RESTRUCTURED AWAY. PLG's blocker disappeared
  // because PLG ceased to exist. Do not assume a publish-capable dummy blueprint
  // means someone added a handler — check what actually changed.
  const dummyBp = JSON.parse(readFileSync(dummyBlueprintPath(), "utf-8"));
  const titles = dummyBp.validators.map((v: { title: string }) => v.title);

  assert.ok(
    !titles.includes("transfer.issue.publish") && !titles.includes("transfer.transfer.publish"),
    "The dummy blueprint now HAS publish handlers — the blocker is lifted. Delete this test " +
      "and wire up dummyLifecycleAssertions()."
  );

  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();

  assert.throws(
    () =>
      CIP113.init({
        client,
        standard: { blueprint: loadStandardBlueprint(), deployment },
        substandards: [dummySubstandard({ blueprint: dummyBp })],
      }),
    /cannot operate on CIP-113 0\.5\.x.*publish handler/s,
    "dummy must refuse UP FRONT, naming the missing handlers — not fail three transactions " +
      "later at submission with an unexplained reward-account error"
  );
});

/**
 * The real lifecycle acceptance, kept ready for a publish-capable dummy blueprint.
 *
 * Deliberately not wired to a `test()`: it cannot pass, and a test that cannot
 * pass is either a skip (invisible) or a red (ignored). Everything it needs is
 * implemented — register, mint and transfer are all written and the register
 * transaction has been OBSERVED passing script evaluation on a devnet. Only the
 * withdraw-0 registration is blocked.
 */
export async function dummyLifecycleAssertions() {
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const networkId = client.chain.id;
  const address = EvoAddress.toBech32(await client.address());

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      dummySubstandard({ blueprint: JSON.parse(readFileSync(dummyBlueprintPath(), "utf-8")) }),
    ],
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });

  const assetName = stringToHex("DUMMY");
  const plb = deployment.programmableLogicBase.scriptHash;

  const heldAt = async (addr: string, unit: string) => {
    const utxos = await client.getUtxos(EvoAddress.fromBech32(addr));
    return utxos.reduce((n: bigint, u: any) => {
      const q = u.assets?.get?.(unit);
      return n + (typeof q === "bigint" ? q : 0n);
    }, 0n);
  };

  const reg = await protocol.register("dummy", {
    feePayerAddress: address,
    assetName,
    quantity: 1_000n,
  });
  const policy = reg.tokenPolicyId!;
  const unit = policy + assetName;
  await reg._signBuilder.signAndSubmit();
  await waitFor(async () => (await heldAt(baseAddress(networkId, plb, address), unit)) === 1_000n, {
    what: "the registered supply to appear",
    timeoutMs: 120_000,
  });

  // register proves the OutputIndex proof; mint proves the RefInput one — a
  // different constructor and a different path through issuance_mint.
  const more = await protocol.mint({
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    quantity: 500n,
    substandardId: "dummy",
  });
  await more._signBuilder.signAndSubmit();
  await waitFor(async () => (await heldAt(baseAddress(networkId, plb, address), unit)) === 1_500n, {
    what: "the additional mint to settle",
    timeoutMs: 120_000,
  });

  const recipient = recipientAddress(networkId, address);
  const senderPlb = baseAddress(networkId, plb, address);
  const recipientPlb = baseAddress(networkId, plb, recipient);
  assert.notEqual(senderPlb, recipientPlb, "a transfer to oneself would prove nothing");

  const before = await heldAt(senderPlb, unit);
  const tx = await protocol.transfer({
    senderAddress: address,
    recipientAddress: recipient,
    tokenPolicyId: policy,
    assetName,
    quantity: 400n,
    substandardId: "dummy",
  });
  await tx._signBuilder.signAndSubmit();

  // THE DELTA, both sides: a credit with no matching debit would pass a
  // one-sided assertion while describing a mint.
  await waitFor(async () => (await heldAt(recipientPlb, unit)) === 400n, {
    what: "the transferred tokens to arrive",
    timeoutMs: 120_000,
  });
  assert.equal(await heldAt(senderPlb, unit), before - 400n, "sender must fall by exactly 400");
}

// ---------------------------------------------------------------------------
// The T-D04 fixture constraint, made explicit and non-vacuous
// ---------------------------------------------------------------------------

test("withdrawal ordering is exercised against BOTH credential kinds", () => {
  // This does not need a chain — it needs the two orderings to DISAGREE, which
  // is the thing a script-only fixture cannot arrange.
  //
  // A wallet adding a key-hash reward withdrawal during balancing is the common
  // real case, and it is exactly what makes the wire-format answer wrong.
  const coreTransfer = { hash: "cc".repeat(28), isScript: true };
  const walletReward = { hash: "00".repeat(28), isScript: false };

  // Wire-format order (header byte 0xE0 key < 0xF0 script) would put the KEY
  // first. The ledger's derived Ord puts the SCRIPT first.
  assert.ok(
    compareWithdrawalKeys(coreTransfer, walletReward) < 0,
    "script before key — the opposite of what the serialised reward address suggests"
  );

  const mixed = [walletReward, coreTransfer];
  assert.deepEqual(sortWithdrawalKeys(mixed), [coreTransfer, walletReward]);
  assert.equal(
    withdrawalIndexOf(mixed, coreTransfer),
    0,
    "with a key withdrawal present, the two candidate orderings give DIFFERENT answers — " +
      "this assertion is the one a script-only fixture cannot make"
  );
  assert.equal(withdrawalIndexOf(mixed, walletReward), 1);
});
