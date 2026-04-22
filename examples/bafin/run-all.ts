/**
 * Full BaFin registration lifecycle in a single process.
 *
 * 1. FRAGMENT: one tx creates 3 small sentinel outputs (2 ADA each) to self.
 *    Their outRefs become the GS/PU/Users one-shot bootstraps — isolated from
 *    fee selection since they're too small to be picked as fee inputs.
 * 2. INIT LINKED LISTS: mints power_users + users root NFTs.
 * 3. ADD POWER USER: adds admin wallet as power user.
 * 4. ADD USER:        adds admin wallet as verified user.
 * 5. REGISTER:        first mint + CIP-113 registry insert + GS mint.
 *
 * Each step submits and waits for confirmation before the next — robust at
 * the cost of ~20s per step on preview.
 *
 * Usage: OGMIOS_URL=http://127.0.0.1:31357 npx tsx bafin/run-all.ts
 */

import {
  CIP113,
  stringToHex,
  EvoAssets,
  EvoAddress,
  EvoTransactionHash,
} from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard, addPowerUser, addUser, registerMintingLogicStake } from "../../src/substandards/bafin/index.js";
import { createOgmiosEvaluator } from "../shared/ogmios-evaluator.js";
import { createBlockfrostEvaluator } from "../shared/blockfrost-evaluator.js";
import {
  createSigningClient,
  getWalletAddress,
  getAdminPkh,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
  getTokenName,
  checkStakeRegistration,
  getNetwork,
} from "../shared/config.js";
import { updateState } from "../shared/state.js";

const SENTINEL_ADA = 2_000_000n;
const MIN_WALLET_ADA = 50_000_000n;

async function main() {
  console.log("=== CIP-113 BaFin: Full registration lifecycle ===\n");

  const client = await createSigningClient();
  const address = await getWalletAddress(client);
  const walletPkh = getAdminPkh(address);
  console.log(`Wallet: ${address}`);
  console.log(`Admin PKH: ${walletPkh}`);

  // --- Preflight: wallet balance check ---
  const utxos = await client.getUtxos(EvoAddress.fromBech32(address));
  const balance = utxos.reduce(
    (s: bigint, u: any) => s + EvoAssets.lovelaceOf(u.assets),
    0n,
  );
  console.log(`Balance: ${Number(balance) / 1e6} ADA (${utxos.length} UTxOs)`);
  if (balance < MIN_WALLET_ADA) {
    console.error(`Need at least ${Number(MIN_WALLET_ADA) / 1e6} ADA — aborting.`);
    process.exit(1);
  }

  // ------------------------------------------------------------------------
  // STEP 0: FRAGMENTATION TX
  // Creates 3 sentinel outputs (2 ADA each) to self. outRefs become bootstraps.
  // ------------------------------------------------------------------------
  console.log("\n--- Step 0: Fragmentation (create 3 sentinel UTxOs) ---");
  const evoAddr = EvoAddress.fromBech32(address);
  let fragTx = client.newTx();
  for (let i = 0; i < 3; i++) {
    fragTx = fragTx.payToAddress({
      address: evoAddr,
      assets: EvoAssets.fromLovelace(SENTINEL_ADA),
    });
  }
  const fragBuilt = await fragTx.build({ changeAddress: evoAddr });
  const fragTxHash = await fragBuilt.signAndSubmit();
  const fragHashHex =
    typeof fragTxHash === "string" ? fragTxHash : EvoTransactionHash.toHex(fragTxHash);
  console.log(`  fragment submitted: ${fragHashHex}`);
  console.log(`  waiting for confirmation...`);
  await client.awaitTx(EvoTransactionHash.fromHex(fragHashHex), 3_000, 120_000);
  console.log(`  confirmed.`);

  // Poll wallet UTxOs until Blockfrost reflects the new outputs (indexing lag).
  const waitForFragUtxos = async () => {
    for (let attempt = 1; attempt <= 15; attempt++) {
      const after = await client.getUtxos(EvoAddress.fromBech32(address));
      const seen = after.filter(
        (u: any) => EvoTransactionHash.toHex(u.transactionId) === fragHashHex,
      ).length;
      if (seen >= 3) {
        console.log(`  fragment UTxOs indexed (attempt ${attempt}).`);
        return;
      }
      await new Promise((r) => setTimeout(r, 4_000));
    }
    throw new Error("Fragment outputs never appeared in wallet UTxOs");
  };
  await waitForFragUtxos();

  const gsBootstrap     = { txHash: fragHashHex, outputIndex: 0 };
  const puBootstrap     = { txHash: fragHashHex, outputIndex: 1 };
  const usersBootstrap  = { txHash: fragHashHex, outputIndex: 2 };
  console.log(`  GS bootstrap:    ${gsBootstrap.txHash}#${gsBootstrap.outputIndex}`);
  console.log(`  PU bootstrap:    ${puBootstrap.txHash}#${puBootstrap.outputIndex}`);
  console.log(`  Users bootstrap: ${usersBootstrap.txHash}#${usersBootstrap.outputIndex}`);

  // ------------------------------------------------------------------------
  // Build BaFin substandard + CIP-113 protocol
  // ------------------------------------------------------------------------
  const tokenName = getTokenName();
  const assetNameHex = stringToHex(tokenName);
  console.log(`\nToken: ${tokenName} (hex ${assetNameHex})`);

  const bafin = bafinSubstandard({
    blueprint: loadBaFinBlueprint(),
    deployment: {
      ownerCredentialHash: walletPkh,
      securityAssetName: assetNameHex,
      globalStateInitTxInput: gsBootstrap,
      powerUsersInitTxInput: puBootstrap,
      usersInitTxInput: usersBootstrap,
    },
  });

  const ogmiosUrl = process.env.SKIP_OGMIOS ? undefined : process.env.OGMIOS_URL;
  let evaluator: ReturnType<typeof createOgmiosEvaluator> | undefined;
  if (ogmiosUrl) {
    evaluator = createOgmiosEvaluator(ogmiosUrl);
  } else if (process.env.VERBOSE_BF_EVAL) {
    const bfProject = process.env.BLOCKFROST_PROJECT_ID || "";
    const bfBase = process.env.BLOCKFROST_URL || `https://cardano-${process.env.NETWORK || "preview"}.blockfrost.io/api/v0`;
    evaluator = createBlockfrostEvaluator(bfBase, bfProject);
  }
  if (evaluator) {
    bafin.setEvaluator(evaluator);
    console.log(`Ogmios evaluator: ${ogmiosUrl}`);
  }

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
    checkStakeRegistration,
  });

  const resolved = bafin.getScripts();
  console.log(`Derived policies:`);
  console.log(`  global state:   ${resolved.globalStatePolicyId}`);
  console.log(`  power users LL: ${resolved.powerUsersLinkedListPolicyId}`);
  console.log(`  users LL:       ${resolved.usersLinkedListPolicyId}`);
  console.log(`  token:          ${resolved.tokenPolicyId}`);

  // ------------------------------------------------------------------------
  // Helper: submit + wait
  // ------------------------------------------------------------------------
  const submit = async (
    label: string,
    result: { _signBuilder?: any; txHash: string },
  ): Promise<string> => {
    console.log(`\n--- ${label} ---`);
    if (!result._signBuilder) throw new Error(`${label}: no _signBuilder`);
    const h = await result._signBuilder.signAndSubmit();
    const hex = typeof h === "string" ? h : EvoTransactionHash.toHex(h);
    console.log(`  submitted: ${hex}`);
    console.log(`  waiting...`);
    await client.awaitTx(EvoTransactionHash.fromHex(hex), 3_000, 180_000);
    console.log(`  confirmed. Letting Blockfrost index...`);
    const indexLagMs = getNetwork() === "yaci" ? 1_000 : 30_000;
    await new Promise((r) => setTimeout(r, indexLagMs));
    return hex;
  };

  // ------------------------------------------------------------------------
  // STEP 1: initCompliance (LL roots)
  // ------------------------------------------------------------------------
  const initResult = await protocol.compliance.init("bafin", {
    feePayerAddress: address,
    adminAddress: address,
    assetName: tokenName,
  });
  const tx1 = await submit("Step 1: Init Linked Lists", initResult);

  // ------------------------------------------------------------------------
  // STEP 2: addPowerUser
  // ------------------------------------------------------------------------
  const puResult = await addPowerUser({
    client,
    scripts: {
      powerUsersMint: resolved.powerUsersMint,
      powerUsersSpend: resolved.powerUsersSpend,
      powerUsersLinkedListPolicyId: resolved.powerUsersLinkedListPolicyId,
    },
    networkId: bafin.getNetworkId(),
    feePayerAddress: address,
    ownerCredentialHash: walletPkh,
    evaluator,
    newPowerUser: {
      credentialHash: walletPkh,
      isAdmin: true,
      canMint: true,
      canBurn: true,
      canPause: true,
      canVerify: true,
      canBlacklist: true,
      canForceTransfer: true,
    },
  });
  const tx2 = await submit("Step 2: Add Power User", puResult);

  // ------------------------------------------------------------------------
  // STEP 3: addUser
  // ------------------------------------------------------------------------
  const userResult = await addUser({
    client,
    scripts: {
      usersMint: resolved.usersMint,
      usersSpend: resolved.usersSpend,
      usersLinkedListPolicyId: resolved.usersLinkedListPolicyId,
      powerUsersSpend: resolved.powerUsersSpend,
      powerUsersLinkedListPolicyId: resolved.powerUsersLinkedListPolicyId,
    },
    networkId: bafin.getNetworkId(),
    feePayerAddress: address,
    powerUserCredentialHash: walletPkh,
    newUserCredentialHash: walletPkh,
    isVerified: true,
    isBlacklisted: false,
    evaluator,
  });
  const tx3 = await submit("Step 3: Add User", userResult);

  // ------------------------------------------------------------------------
  // STEP 3.5: pre-register minting_logic stake cred (Conway rejects
  // RegCert + withdraw-0 bundled, so we split it into its own tx).
  // ------------------------------------------------------------------------
  const mlRegResult = await registerMintingLogicStake({
    client,
    mintingLogic: resolved.mintingLogic,
    feePayerAddress: address,
    excludeUtxoRefs: [gsBootstrap, puBootstrap, usersBootstrap],
    evaluator,
  });
  const tx3b = await submit("Step 3.5: Register Minting Logic Stake Cred", mlRegResult);

  // ------------------------------------------------------------------------
  // STEP 4: register
  // ------------------------------------------------------------------------
  const regResult = await protocol.register("bafin", {
    feePayerAddress: address,
    assetName: tokenName,
    quantity: 1_000_000n,
    recipientAddress: address,
    config: { powerUserCredentialHash: walletPkh },
  });
  const tx4 = await submit("Step 4: Register Token", regResult);

  // ------------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------------
  console.log("\n=== Summary ===");
  console.log(`Fragment tx:      ${fragHashHex}`);
  console.log(`Init linked lists: ${tx1}`);
  console.log(`Add power user:   ${tx2}`);
  console.log(`Add user:         ${tx3}`);
  console.log(`Register token:   ${tx4}`);
  console.log(`\nToken policy:    ${resolved.tokenPolicyId}`);
  console.log(`Token asset name: ${tokenName} (hex ${assetNameHex})`);

  updateState({
    adminAddress: address,
    adminPkh: walletPkh,
    assetName: tokenName,
    assetNameHex,
    globalStateInitTxInput: gsBootstrap,
    powerUsersInitTxInput: puBootstrap,
    usersInitTxInput: usersBootstrap,
    fragmentTxHash: fragHashHex,
    initLinkedListsTxHash: tx1,
    addPowerUserTxHash: tx2,
    addUserTxHash: tx3,
    registerTxHash: tx4,
    tokenPolicyId: resolved.tokenPolicyId,
  });
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  // Dump full error tree including Effect-wrapped causes
  try {
    const seen = new WeakSet();
    const serialize = (obj: any, depth: number): any => {
      if (obj == null || typeof obj !== "object" || depth > 8) return String(obj);
      if (seen.has(obj)) return "[circular]";
      seen.add(obj);
      const out: any = {};
      for (const k of Object.keys(obj)) {
        try { out[k] = serialize(obj[k], depth + 1); } catch { out[k] = "[unserializable]"; }
      }
      for (const sym of Object.getOwnPropertySymbols(obj)) {
        try { out[sym.toString()] = serialize((obj as any)[sym], depth + 1); } catch {}
      }
      if (obj.message) out.__message = obj.message;
      if (obj.cause) out.__cause = serialize(obj.cause, depth + 1);
      return out;
    };
    console.error("TREE:", JSON.stringify(serialize(e, 0), null, 2).slice(0, 3000));
  } catch (dumpErr) {
    console.error("dump failed:", dumpErr);
  }
  process.exit(1);
});
