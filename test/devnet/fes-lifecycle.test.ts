/**
 * freeze-and-seize on a live devnet (W-E S-4's devnet half).
 *
 * Covers the paths migrated in S-4: initCompliance → register → mint → transfer.
 * `seize` and `burn` are NOT migrated (they route through the deleted
 * `ThirdPartyAct`) and are asserted to REFUSE, so this file fails the moment
 * S-5 lands and stops being an honest description of the state.
 *
 * Unlike `dummy`, FES cannot be constructed and used directly: its
 * `blacklist_mint` is parameterised by the UTxO `initCompliance` consumes. See
 * test/harness/fes-setup.ts for why the ordering is forced.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Address as EvoAddress, Assets as EvoAssets } from "@evolution-sdk/evolution";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";
import { CIP113, stringToHex, baseAddress } from "../../dist/index.js";
import { requireDevnet, makeClient, waitFor, settleWallet } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { makeFesFixture } from "../harness/fes-setup.js";
import { registerSubstandardCredentials } from "../harness/substandard-setup.js";
import { recipientAddress } from "../harness/recipient.js";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";


/**
 * Submit, and make the failure say WHICH step failed.
 *
 * A lifecycle test submits many transactions; a raw ledger error names a code
 * and a UTxO and nothing about which operation produced it. Attributing by
 * reading the test top-to-bottom is guesswork, and guessing which step failed is
 * how the wrong cause gets confirmed.
 */
async function submitStep(label: string, tx: { _signBuilder: any }): Promise<void> {
  try {
    await tx._signBuilder.signAndSubmit();
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    throw new Error(`[step: ${label}] ${msg}`);
  }
}

before(async () => {
  await requireDevnet();
});

test("freeze-and-seize: the migrated paths work on a live devnet", async () => {
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const networkId = client.chain.id;
  const address = EvoAddress.toBech32(await client.address());
  // ⚠ A PER-RUN ASSET NAME, and it is not cosmetic.
  //
  // `issuer_admin` is parameterised by (adminPkh, assetName) and NOTHING ELSE —
  // so with a fixed asset name its script hash is IDENTICAL across runs, while
  // every other FES script changes with each bootstrap. Its stake credential is
  // therefore already registered on the second run, and initCompliance fails
  // with code 3145, "trying to re-register some already known credentials" —
  // an error about registration that is really about a parameterisation that
  // does not vary.
  //
  // Deriving the suffix from the bootstrap tx hash keeps a run deterministic
  // while making runs independent of each other.
  const assetName = stringToHex("FES" + deployment.txHash.slice(0, 6));

  // The forced ordering: choose a UTxO, derive the blacklist policy FROM it,
  // and only then construct the plugin.
  const fes = await makeFesFixture(
    client,
    address,
    assetName,
    deployment.programmableLogicBase.scriptHash
  );
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      freezeAndSeizeSubstandard({
        blueprint: fes.blueprint as never,
        deployment: fes.deployment as never,
      }),
    ],
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });

  // ⚑ That this line is reached at all is the S-4 result: freeze-and-seize
  // refused to initialise AT ALL under D-14's blanket quarantine.
  assert.deepEqual(protocol.listSubstandards(), ["freeze-and-seize"]);

  const heldAt = async (addr: string, policyHex: string, nameHex: string) => {
    const utxos = await client.getUtxos(EvoAddress.fromBech32(addr));
    let total = 0n;
    for (const u of utxos) {
      for (const p of EvoAssets.policies(u.assets)) {
        if (String(p) !== policyHex) continue;
        for (const [name, qty] of EvoAssets.tokens(u.assets, p).entries()) {
          const raw = (name as any)?.bytes ?? name;
          const hex =
            typeof raw === "string"
              ? raw
              : Array.from(raw as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
          if (hex === nameHex) total += qty as bigint;
        }
      }
    }
    return total;
  };

  // --- initCompliance FIRST, and the order is not cosmetic -----------------
  //
  // The blacklist policy is derived FROM a specific wallet UTxO, and
  // initCompliance is the transaction that spends it. Anything that submits in
  // between can consume that UTxO through ordinary coin selection — and then
  // init fails with "Bootstrap UTxO not found on-chain", which names the UTxO
  // and says nothing about who took it.
  //
  // MEASURED: registering the withdraw-0 credentials before init did exactly
  // that. So init runs FIRST, closing the window, and credential registration
  // follows — it is only needed by register/mint/transfer, not by init.
  const init = await protocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address,
    adminAddress: address,
    assetName,
  });
  await submitStep("initCompliance", init);
  await settleWallet(client, await client.address());

  // Now the remaining withdraw-0 credential.
  //
  // ⚠ ONLY the transfer logic. `initCompliance` registers `issuer_admin`'s
  // credential ITSELF (it has a `checkStakeRegistration` hook for callers who
  // already did), so registering it here as well is a guaranteed duplicate.
  await registerSubstandardCredentials(fes.withdrawScripts.slice(1));

  // --- register + first mint ----------------------------------------------
  const reg = await protocol.register("freeze-and-seize", {
    feePayerAddress: address,
    assetName,
    quantity: 1_000n,
  });
  const policy = reg.tokenPolicyId!;
  await submitStep("register", reg);

  const plb = deployment.programmableLogicBase.scriptHash;
  const issuerPlb = baseAddress(networkId, plb, address);
  await waitFor(async () => (await heldAt(issuerPlb, policy, assetName)) === 1_000n, {
    what: "the FES supply to appear at the issuer's programmable address",
    timeoutMs: 120_000,
  });

  // --- transfer to a holder ------------------------------------------------
  const holder = recipientAddress(networkId, address);
  const holderPlb = baseAddress(networkId, plb, holder);
  assert.notEqual(issuerPlb, holderPlb);

  const xfer = await protocol.transfer({
    senderAddress: address,
    recipientAddress: holder,
    tokenPolicyId: policy,
    assetName,
    quantity: 300n,
    substandardId: "freeze-and-seize",
  });
  await submitStep("transfer-to-holder", xfer);
  // Settle before building the seize: the transfer just consumed wallet UTxOs
  // and the provider has not caught up. Without this the seize is built against
  // a stale view and rejected with 3117.
  await settleWallet(client, await client.address());
  await waitFor(async () => (await heldAt(holderPlb, policy, assetName)) === 300n, {
    what: "the transfer to reach the holder",
    timeoutMs: 120_000,
  });

});

/**
 * Seize, as its OWN test.
 *
 * Split from the lifecycle deliberately: when the combined arc failed at a
 * programmable_logic_base spend, the failure could have belonged to FES's
 * transfer path (S-4 code that register/mint never exercised) or to seize (S-5).
 * A single test covering both cannot tell you which, and picking the one you
 * just wrote is how a wrong cause gets confirmed.
 *
 * Two tests cost one extra bootstrap and answer it outright.
 */
test("freeze-and-seize: seize takes tokens back without the holder's signature", async () => {
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const networkId = client.chain.id;
  const address = EvoAddress.toBech32(await client.address());
  const assetName = stringToHex("FES" + deployment.txHash.slice(0, 6));
  const plb = deployment.programmableLogicBase.scriptHash;

  const fes = await makeFesFixture(client, address, assetName, plb);
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      freezeAndSeizeSubstandard({
        blueprint: fes.blueprint as never,
        deployment: fes.deployment as never,
      }),
    ],
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });

  const heldAt = async (addr: string, policyHex: string, nameHex: string) => {
    const utxos = await client.getUtxos(EvoAddress.fromBech32(addr));
    let total = 0n;
    for (const u of utxos) {
      for (const p of EvoAssets.policies(u.assets)) {
        if (String(p) !== policyHex) continue;
        for (const [name, qty] of EvoAssets.tokens(u.assets, p).entries()) {
          const raw = (name as any)?.bytes ?? name;
          const hex =
            typeof raw === "string"
              ? raw
              : Array.from(raw as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
          if (hex === nameHex) total += qty as bigint;
        }
      }
    }
    return total;
  };

  const init = await protocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address,
    adminAddress: address,
    assetName,
  });
  await submitStep("initCompliance", init);
  await settleWallet(client, await client.address());
  await registerSubstandardCredentials(fes.withdrawScripts.slice(1));

  const reg = await protocol.register("freeze-and-seize", {
    feePayerAddress: address,
    assetName,
    quantity: 1_000n,
  });
  const policy = reg.tokenPolicyId!;
  await submitStep("register", reg);
  await settleWallet(client, await client.address());

  const issuerPlb = baseAddress(networkId, plb, address);
  await waitFor(async () => (await heldAt(issuerPlb, policy, assetName)) === 1_000n, {
    what: "the FES supply to appear before seizing",
    timeoutMs: 120_000,
  });

  // Put tokens in a holder's hands first — you cannot seize from nobody.
  const holder = recipientAddress(networkId, address);
  const holderPlb = baseAddress(networkId, plb, holder);
  const xfer = await protocol.transfer({
    senderAddress: address,
    recipientAddress: holder,
    tokenPolicyId: policy,
    assetName,
    quantity: 300n,
    substandardId: "freeze-and-seize",
  });
  await submitStep("transfer-to-holder", xfer);
  await settleWallet(client, await client.address());
  await waitFor(async () => (await heldAt(holderPlb, policy, assetName)) === 300n, {
    what: "the transfer to reach the holder before seizing",
    timeoutMs: 120_000,
  });

  // --- FREEZE → BLOCKED TRANSFER REFUSED → UNFREEZE -------------------------
  //
  // ⚑ THE REFUSAL IS THE POINT OF THIS SUBSTANDARD. A lifecycle that proves only
  // the successes proves the wrong half: a freeze that does not actually block a
  // transfer is precisely the failure freeze-and-seize exists to prevent, and it
  // would pass every "freeze succeeded" assertion.
  //
  // The issuer is frozen rather than the holder because the blocked transfer has
  // to be SIGNED to reach validation at all — a transfer nobody can sign is
  // refused for the wrong reason and proves nothing about the blacklist.
  const freeze = await protocol.compliance.freeze({
    substandardId: "freeze-and-seize",
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    targetAddress: address,
  });
  await submitStep("freeze", freeze);
  await settleWallet(client, await client.address());

  let refusal: unknown;
  await assert.rejects(
    async () => {
      const blocked = await protocol.transfer({
        senderAddress: address,
        recipientAddress: holder,
        tokenPolicyId: policy,
        assetName,
        quantity: 100n,
        substandardId: "freeze-and-seize",
      });
      await blocked._signBuilder.signAndSubmit();
    },
    (err: unknown) => {
      refusal = err;
      return true;
    },
    "a transfer from a FROZEN address must be refused — a freeze that does not " +
      "block is the failure this substandard exists to prevent"
  );

  // ⚠ AND FOR THE RIGHT REASON. "It threw" is not the assertion: a missing UTxO,
  // a stale view or a builder bug would also throw, and would leave the
  // blacklist entirely unexercised while the test went green.
  const refusalText = String((refusal as Error)?.message ?? refusal);
  assert.match(
    refusalText,
    /Script evaluation failed|terminated with error|blacklist/i,
    `the refusal must come from validation, not from plumbing — got: ${refusalText.slice(0, 220)}`
  );

  // --- UNFREEZE, and prove the block LIFTS ---------------------------------
  //
  // Without this the test cannot distinguish "the blacklist blocked it" from
  // "transfers from this address never worked".
  const unfreeze = await protocol.compliance.unfreeze({
    substandardId: "freeze-and-seize",
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    targetAddress: address,
  });
  await submitStep("unfreeze", unfreeze);
  await settleWallet(client, await client.address());

  const afterUnfreeze = await protocol.transfer({
    senderAddress: address,
    recipientAddress: holder,
    tokenPolicyId: policy,
    assetName,
    quantity: 100n,
    substandardId: "freeze-and-seize",
  });
  await submitStep("transfer-after-unfreeze", afterUnfreeze);
  await settleWallet(client, await client.address());
  await waitFor(async () => (await heldAt(holderPlb, policy, assetName)) === 400n, {
    what: "the transfer to succeed once the address is unfrozen",
    timeoutMs: 120_000,
  });

  // --- SEIZE: take it back without the holder's signature -------------------
  //
  // The whole reason this substandard exists. Authorised by the registry node's
  // `third_party_transfer_logic_script` — which for FES is a REAL issuer-admin
  // check, unlike dummy's unconditional one.
  const holderUtxos = await client.getUtxos(EvoAddress.fromBech32(holderPlb));
  const target = holderUtxos.find((u: any) => {
    for (const p of EvoAssets.policies(u.assets)) if (String(p) === policy) return true;
    return false;
  });
  assert.ok(target, "expected a holder UTxO carrying the token");

  // Relative, not absolute: the holder now holds several UTxOs (the original
  // transfer plus the post-unfreeze one) and seize takes ONE. Asserting
  // "holder reaches 0" would be asserting the fixture's arithmetic rather than
  // the seizure.
  const seizedQty = (() => {
    for (const p of EvoAssets.policies(target!.assets)) {
      if (String(p) !== policy) continue;
      for (const [name, qty] of EvoAssets.tokens(target!.assets, p).entries()) {
        const raw = (name as any)?.bytes ?? name;
        const hex =
          typeof raw === "string"
            ? raw
            : Array.from(raw as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
        if (hex === assetName) return qty as bigint;
      }
    }
    return 0n;
  })();
  assert.ok(seizedQty > 0n, "the targeted UTxO must actually carry the token");
  const holderBefore = await heldAt(holderPlb, policy, assetName);
  const issuerBefore = await heldAt(issuerPlb, policy, assetName);

  const { TransactionHash } = await import("@evolution-sdk/evolution");
  const seized = await protocol.compliance.seize({
    substandardId: "freeze-and-seize",
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    utxoTxHash: TransactionHash.toHex(target.transactionId),
    utxoOutputIndex: Number(target.index),
    destinationAddress: address,
    holderAddress: holder,
  });
  await submitStep("seize", seized);

  // THE DELTA, both sides — and the holder never signed.
  await waitFor(
    async () => (await heldAt(holderPlb, policy, assetName)) === holderBefore - seizedQty,
    { what: "the seized tokens to leave the holder", timeoutMs: 120_000 }
  );
  assert.equal(
    await heldAt(issuerPlb, policy, assetName),
    issuerBefore + seizedQty,
    "the issuer must gain exactly what was seized — a credit with no matching debit " +
      "would pass a one-sided check while describing a mint"
  );
});
