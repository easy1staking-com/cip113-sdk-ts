/**
 * Chain Test — Build all 4 BaFin txs in sequence without submitting.
 *
 * Uses chained outputs from each tx as inputs/additional UTxOs for the next.
 * All txs are evaluated by Ogmios but never submitted.
 *
 * Usage: npx tsx examples/bafin/chain-test.ts
 * Prerequisite: npx tsx examples/bafin/00-setup.ts
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard, addPowerUser, addUser } from "../../src/substandards/bafin/index.js";
import { createOgmiosEvaluator } from "../shared/ogmios-evaluator.js";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
  checkStakeRegistration,
} from "../shared/config.js";
import { loadState, requireState } from "../shared/state.js";

import type { UTxO } from "@evolution-sdk/evolution";

async function main() {
  console.log("=== CIP-113 BaFin: Chain Test (all 4 txs, no submit) ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "assetName", "assetNameHex",
    "globalStateInitTxInput", "powerUsersInitTxInput", "usersInitTxInput");

  const client = createSigningClient();
  const address = state.adminAddress!;
  const walletPkh = state.adminPkh!;

  const ogmiosUrl = process.env.OGMIOS_URL || "http://panic-station:31357";
  const evaluator = createOgmiosEvaluator(ogmiosUrl);
  console.log(`Ogmios: ${ogmiosUrl}`);
  console.log(`Wallet: ${address}\n`);

  // Create BaFin substandard
  const bafin = bafinSubstandard({
    blueprint: loadBaFinBlueprint(),
    deployment: {
      ownerCredentialHash: walletPkh,
      securityAssetName: state.assetNameHex!,
      globalStateInitTxInput: state.globalStateInitTxInput as { txHash: string; outputIndex: number },
      powerUsersInitTxInput: state.powerUsersInitTxInput as { txHash: string; outputIndex: number },
      usersInitTxInput: state.usersInitTxInput as { txHash: string; outputIndex: number },
    },
  });

  bafin.setEvaluator(evaluator);

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
    checkStakeRegistration,
  });

  const resolved = bafin.getScripts();

  // Accumulate chained outputs from all txs
  let allChainedUtxos: UTxO.UTxO[] = [];

  // --- TX 1: Init linked lists + global state ---
  console.log("--- TX 1: Init linked lists + global state ---");
  const initResult = await protocol.compliance.init("bafin", {
    feePayerAddress: address,
    adminAddress: address,
    assetName: state.assetName!,
  });
  console.log(`  TX Hash: ${initResult.txHash}`);
  console.log(`  CBOR: ${initResult.cbor.length / 2} bytes`);
  console.log(`  Chained UTxOs: ${(initResult.chainAvailable as any[])?.length ?? 0}`);

  if (initResult.chainAvailable) {
    allChainedUtxos = [...allChainedUtxos, ...(initResult.chainAvailable as UTxO.UTxO[])];
  }

  // --- TX 2: Add power user ---
  console.log("\n--- TX 2: Add power user ---");
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
    extraUtxos: allChainedUtxos,
    chainedUtxos: allChainedUtxos,
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
  console.log(`  TX Hash: ${puResult.txHash}`);
  console.log(`  CBOR: ${puResult.cbor.length / 2} bytes`);
  console.log(`  Chained UTxOs: ${(puResult.chainAvailable as any[])?.length ?? 0}`);

  if (puResult.chainAvailable) {
    allChainedUtxos = [...allChainedUtxos, ...(puResult.chainAvailable as UTxO.UTxO[])];
  }

  // --- TX 3: Add user ---
  console.log("\n--- TX 3: Add user ---");
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
    extraUtxos: allChainedUtxos,
    chainedUtxos: allChainedUtxos,
  });
  console.log(`  TX Hash: ${userResult.txHash}`);
  console.log(`  CBOR: ${userResult.cbor.length / 2} bytes`);
  console.log(`  Chained UTxOs: ${(userResult.chainAvailable as any[])?.length ?? 0}`);

  if (userResult.chainAvailable) {
    allChainedUtxos = [...allChainedUtxos, ...(userResult.chainAvailable as UTxO.UTxO[])];
  }

  // --- TX 4: Register token ---
  console.log("\n--- TX 4: Register token ---");
  const regResult = await protocol.register("bafin", {
    feePayerAddress: address,
    assetName: state.assetName!,
    quantity: 1_000_000n,
    recipientAddress: address,
    config: {
      powerUserCredentialHash: walletPkh,
    },
    chainedUtxos: allChainedUtxos,
  });
  console.log(`  TX Hash: ${regResult.txHash}`);
  console.log(`  Token Policy: ${regResult.tokenPolicyId}`);
  console.log(`  CBOR: ${regResult.cbor.length / 2} bytes`);

  console.log("\n=== All 4 txs built and evaluated successfully! ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
