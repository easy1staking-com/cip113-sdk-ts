/**
 * freeze-and-seize on a live CIP-113 0.5.0-alpha.4 devnet.
 *
 * Covers initCompliance → register → mint → transfer → freeze → refused
 * transfer → unfreeze → seize → burn across three tests. In alpha.4 every mint
 * and burn carries a second protocol withdrawal, `issuance_logic`; omitting it
 * is silent until script evaluation because issuance_mint scans for its
 * redeemer and names neither the missing withdrawal nor the policy.
 *
 * Unlike `dummy`, FES cannot be constructed and used directly: its
 * `blacklist_mint` is parameterised by the UTxO `initCompliance` consumes. See
 * test/harness/fes-setup.ts for why the ordering is forced.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Data as EvoData,
  RewardAccount as EvoRewardAccount,
  Transaction as EvoTransaction,
  Withdrawals as EvoWithdrawals,
} from "@evolution-sdk/evolution";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";
import { CIP113, stringToHex, baseAddress, rewardAddress } from "../../dist/index.js";
import { requireDevnet, makeClient, waitFor, settleWallet, KUPO_URL } from "../harness/yaci.mjs";
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
  // Unsigned CBOR is a lower bound: signing adds witnesses. This assertion is
  // necessary but not sufficient; acceptance on chain establishes the actual
  // signed transaction also fit.
  const regBytes = reg.cbor.length / 2;
  console.error(`  [tx size] fes.register: ${regBytes} bytes unsigned (limit 16384)`);
  assert.ok(regBytes < 16_384, `register transaction is ${regBytes} bytes unsigned, over the 16384 cap`);

  const policy = reg.tokenPolicyId!;
  const regTx = EvoTransaction.fromCBORHex(reg.cbor);
  // Documentation of the complete withdrawal set, not an upstream guard: the
  // live evaluator runs during build and catches an omitted or shifted member
  // before CBOR exists.
  const regWithdrawals = regTx.body.withdrawals;
  assert.ok(regWithdrawals, "register must carry its two script withdrawals");
  const regWithdrawalEntries = EvoWithdrawals.entries(regWithdrawals);
  assert.equal(regWithdrawalEntries.length, 2, "register must carry exactly two withdrawals");
  assert.ok(
    regWithdrawalEntries.some(
      ([account]) =>
        EvoRewardAccount.toBech32(account) ===
        rewardAddress(networkId, deployment.issuanceLogic.scriptHash)
    ),
    "register withdrawals must include issuance_logic"
  );

  // This assertion is independently load-bearing: metadata.outputIndices is a
  // published API value the evaluator and ledger never see. It compares that
  // value against the actual transaction output and kills a mis-declared tag
  // list even when the transaction itself remains valid.
  const outputIndices = reg.metadata?.outputIndices as Record<string, number> | undefined;
  assert.ok(outputIndices, "register must publish its planned output indices");
  const newNodeOutput = regTx.body.outputs[outputIndices.OUT_NEW_NODE];
  assert.ok(newNodeOutput, "the metadata-selected new-node output must exist");
  assert.equal(
    EvoAssets.getByUnit(newNodeOutput.assets, deployment.registry.scriptHash + policy),
    1n,
    "metadata.outputIndices.OUT_NEW_NODE must select the output carrying this policy's registry NFT"
  );

  await submitStep("register", reg);

  const plb = deployment.programmableLogicBase.scriptHash;
  const issuerPlb = baseAddress(networkId, plb, address);
  await waitFor(async () => (await heldAt(issuerPlb, policy, assetName)) === 1_000n, {
    what: "the FES supply to appear at the issuer's programmable address",
    timeoutMs: 120_000,
  });

  // --- subsequent mint: alpha.4's RefInput proof and mandatory params input -
  const more = await protocol.mint({
    substandardId: "freeze-and-seize",
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    quantity: 500n,
  });
  const mintBytes = more.cbor.length / 2;
  console.error(`  [tx size] fes.mint: ${mintBytes} bytes unsigned (limit 16384)`);
  assert.ok(mintBytes < 16_384, `mint transaction is ${mintBytes} bytes unsigned, over the 16384 cap`);
  // Documentation of the complete withdrawal set; live evaluation during
  // build is the guard that rejects a missing or shifted member.
  const mintWithdrawals = EvoTransaction.fromCBORHex(more.cbor).body.withdrawals;
  assert.ok(mintWithdrawals, "mint must carry its two script withdrawals");
  const mintWithdrawalEntries = EvoWithdrawals.entries(mintWithdrawals);
  assert.equal(mintWithdrawalEntries.length, 2, "mint must carry exactly two withdrawals");
  assert.ok(
    mintWithdrawalEntries.some(
      ([account]) =>
        EvoRewardAccount.toBech32(account) ===
        rewardAddress(networkId, deployment.issuanceLogic.scriptHash)
    ),
    "mint withdrawals must include issuance_logic"
  );
  // Preserve the harness's known optional-_signBuilder type debt at exactly
  // its baseline count; this path is a signing client and the runtime value is
  // asserted by submitStep's dereference.
  await submitStep("mint", more as { _signBuilder: any });
  await settleWallet(client, await client.address());
  await waitFor(async () => (await heldAt(issuerPlb, policy, assetName)) === 1_500n, {
    what: "the subsequent FES mint to raise issuer supply to 1,500",
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


/**
 * `burn`'s FIRST EVER EXECUTION.
 *
 * Migrated in S-5 and exercised by nothing until now — it was "clean by
 * construction", which is a different word from "verified". It is also the
 * operation that turned out to hold the REFERENCE IMPLEMENTATION for the
 * seize defect: it withdraws at `third_party` and ATTACHES it, which is
 * exactly what seize did before 09bd468 removed it. Nobody compared against
 * `burn` because it sat outside the feature area.
 *
 * PROOF OF HARNESS — two mutations, and they proved DIFFERENT things:
 *
 *   1. src, burn half (`-(burnAmount / 2n)`)  → RED, but at SUBMIT, not here:
 *      the validator refuses a partial burn outright. That proves the CHAIN
 *      enforces full destruction; it never reaches this assertion, so it
 *      discharges nothing about the guard. Recorded because a red that never
 *      touched the assertion is not evidence for the assertion.
 *   2. assertion expects one token too few      → RED HERE, ERR_ASSERTION,
 *      `actual 0n !== expected -1n`, after a SUCCESSFUL burn. That is the
 *      guard reading real chain state and comparing it exactly — so it is
 *      not vacuous and not merely checking "supply went down".
 *
 * ⚠ Neither mutation simulates the defect this guard is really aimed at —
 * a burn that MOVES tokens instead of destroying them — because the
 * validator will not build such a transaction. That case remains covered by
 * construction (supply is chain-wide) rather than by demonstration.
 *
 * ⚠ THE ASSERTION IS SUPPLY, NOT BALANCE. "The issuer's balance went down"
 * is equally consistent with a TRANSFER, and a burn that silently moved
 * tokens instead of destroying them would pass a balance check. Total supply
 * is summed chain-wide from Kupo across every unspent output carrying the
 * asset, so a token that merely moved still counts.
 */
test("freeze-and-seize: burn destroys tokens — chain-wide supply falls, not just a balance", async () => {
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const networkId = client.chain.id;
  const address = EvoAddress.toBech32(await client.address());
  const assetName = stringToHex("BRN" + deployment.txHash.slice(0, 6));
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

  // Chain-wide supply: every unspent output carrying this exact asset.
  // ⚠ `?unspent` IS LOad-BEARING. Kupo's /matches returns every output it has
  // ever indexed, SPENT ONES INCLUDED — so without it this function sums
  // historical outputs and reports supply that no longer exists. It cost a
  // false accusation against `burn`: the pre-burn UTxO was still counted, the
  // total looked unchanged, and a working burn read as "it moved the tokens
  // instead of destroying them".
  const totalSupply = async (policyHex: string, nameHex: string) => {
    const resp = await fetch(`${KUPO_URL}/matches/${policyHex}.${nameHex}?unspent`);
    const body = await resp.json();
    if (!Array.isArray(body)) {
      throw new Error(`Kupo asset pattern rejected — cannot measure supply: ${JSON.stringify(body).slice(0, 200)}`);
    }
    let total = 0n;
    for (const m of body) {
      const assets = m?.value?.assets ?? {};
      for (const [unit, qty] of Object.entries(assets)) {
        if (unit.replace(".", "") === policyHex + nameHex) total += BigInt(qty as never);
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
  await waitFor(async () => (await totalSupply(policy, assetName)) === 1_000n, {
    what: "the registered supply to be visible chain-wide before burning",
    timeoutMs: 120_000,
  });

  // Pick the UTxO to burn and record what it carries — `burn` destroys the
  // WHOLE quantity held by the chosen UTxO, so the expected delta is that
  // UTxO's own amount rather than a number the test picks.
  const issuerUtxos = await client.getUtxos(EvoAddress.fromBech32(issuerPlb));
  const target = issuerUtxos.find((u: any) => {
    for (const p of EvoAssets.policies(u.assets)) {
      if (String(p) === policy) return true;
    }
    return false;
  });
  assert.ok(target, "expected an issuer UTxO carrying the token to burn");

  const { TransactionHash } = await import("@evolution-sdk/evolution");
  const burnedQty = (() => {
    for (const p of EvoAssets.policies(target.assets)) {
      if (String(p) !== policy) continue;
      for (const [name, qty] of EvoAssets.tokens(target.assets, p).entries()) {
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
  assert.ok(burnedQty > 0n, "the targeted UTxO must actually carry the token");

  const supplyBefore = await totalSupply(policy, assetName);

  const burned = await protocol.burn({
    substandardId: "freeze-and-seize",
    feePayerAddress: address,
    tokenPolicyId: policy,
    assetName,
    utxoTxHash: TransactionHash.toHex(target.transactionId),
    utxoOutputIndex: Number(target.index),
    holderAddress: address,
  });
  const burnBytes = burned.cbor.length / 2;
  console.error(`  [tx size] fes.burn: ${burnBytes} bytes unsigned (limit 16384)`);
  assert.ok(burnBytes < 16_384, `burn transaction is ${burnBytes} bytes unsigned, over the 16384 cap`);

  const burnTx = EvoTransaction.fromCBORHex(burned.cbor);
  // Documentation of what the chain already guards completely: the evaluator
  // rejects missing and extra members before this decoded-transaction check can
  // run. Keep both count and identity because they make the four-way seam
  // readable at the call site.
  const burnWithdrawals = burnTx.body.withdrawals;
  assert.ok(burnWithdrawals, "burn must carry its four script withdrawals");
  const burnWithdrawalEntries = EvoWithdrawals.entries(burnWithdrawals);
  assert.equal(burnWithdrawalEntries.length, 4, "burn must carry exactly four withdrawals");
  const issuanceLogicReward = rewardAddress(
    networkId,
    deployment.issuanceLogic.scriptHash
  );
  assert.ok(
    burnWithdrawalEntries.some(
      ([account]) => EvoRewardAccount.toBech32(account) === issuanceLogicReward
    ),
    "burn withdrawals must include issuance_logic"
  );

  // The same registry reference-input index is encoded for two different
  // scripts and compared by a third. Decode both public facts rather than
  // assuming their shared builder source stayed wired correctly.
  const thirdPartyReward = rewardAddress(networkId, deployment.thirdParty.scriptHash);
  assert.ok(
    burnWithdrawalEntries.some(
      ([account]) => EvoRewardAccount.toBech32(account) === thirdPartyReward
    ),
    "burn withdrawals must include third_party"
  );

  const redeemers = burnTx.witnessSet.redeemers?.toArray();
  assert.ok(redeemers, "burn must carry redeemers");
  const thirdPartyData = redeemers.find(
    (r) =>
      r.tag === "reward" &&
      r.data instanceof EvoData.Constr &&
      r.data.index === 0n &&
      r.data.fields.length === 2 &&
      r.data.fields.every((field) => typeof field === "bigint")
  )?.data;
  const issuanceLogicData = redeemers.find(
    (r) => r.tag === "reward" && r.data instanceof Map
  )?.data;
  assert.ok(
    thirdPartyData instanceof EvoData.Constr &&
      thirdPartyData.index === 0n &&
      typeof thirdPartyData.fields[0] === "bigint",
    "third_party withdrawal must carry ThirdPartyRedeemer { registry_node_idx, outputs_start_idx }"
  );
  assert.ok(issuanceLogicData instanceof Map, "issuance_logic withdrawal redeemer must be a policy map");
  let registryProof: EvoData.Data | undefined;
  for (const [key, proof] of issuanceLogicData.entries()) {
    if (Buffer.from(key as Uint8Array).toString("hex") === policy) {
      registryProof = proof as EvoData.Data;
      break;
    }
  }
  assert.ok(
    registryProof instanceof EvoData.Constr &&
      registryProof.index === 0n &&
      typeof registryProof.fields[0] === "bigint",
    "issuance_logic must map this policy to RefInput { index }"
  );
  assert.equal(
    thirdPartyData.fields[0],
    registryProof.fields[0],
    "ThirdPartyRedeemer.registry_node_idx must equal issuance_logic RefInput.index"
  );

  await submitStep("burn", burned);

  // Poll, then REPORT THE NUMBERS. "Timed out waiting for X" tells you the
  // assertion failed but not what the chain actually did, and the difference
  // between "supply unchanged" (burn moved tokens) and "supply fell by the
  // wrong amount" (burn destroyed the wrong quantity) is the whole diagnosis.
  let observed = supplyBefore;
  for (let i = 0; i < 40; i++) {
    observed = await totalSupply(policy, assetName);
    if (observed === supplyBefore - burnedQty) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  const holders = await (async () => {
    const r = await fetch(`${KUPO_URL}/matches/${policy}.${assetName}?unspent`);
    const b = await r.json();
    return (Array.isArray(b) ? b : []).map((m: any) => `${m.address?.slice(0, 24)}… ${JSON.stringify(m.value?.assets)}`);
  })();
  console.error(`=== BURN: WHO HOLDS THE ASSET AFTER === ${JSON.stringify(holders, null, 1)}`);
  console.error(`=== BURN: policy=${policy} assetName=${assetName} issuerPlb=${issuerPlb}`);
  console.error(
    `=== BURN SUPPLY === before=${supplyBefore} burnedQty=${burnedQty} ` +
      `expected=${supplyBefore - burnedQty} observed=${observed} ` +
      `issuerPlbAfter=${await (async () => {
        const us = await client.getUtxos(EvoAddress.fromBech32(issuerPlb));
        let t = 0n;
        for (const u of us) for (const pp of EvoAssets.policies(u.assets)) {
          if (String(pp) !== policy) continue;
          for (const [n, q] of EvoAssets.tokens(u.assets, pp).entries()) {
            const raw = (n as any)?.bytes ?? n;
            const hex = typeof raw === "string" ? raw : Array.from(raw as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
            if (hex === assetName) t += q as bigint;
          }
        }
        return t;
      })()}`
  );
  assert.equal(
    await totalSupply(policy, assetName),
    supplyBefore - burnedQty,
    "supply must fall by exactly the burned quantity — a smaller fall means tokens moved rather than died"
  );
});
