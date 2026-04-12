/**
 * 01 - Initialize Compliance
 *
 * Creates the blacklist linked list on-chain. This is the first step
 * before registering a Freeze-and-Seize token.
 *
 * Usage: npm run fes:init-compliance
 * Prerequisite: npm run fes:setup
 */

import {
  CIP113,
  stringToHex,
  EvoAssets,
  EvoAddress,
  EvoTransactionHash,
} from "@easy1staking/cip113-sdk-ts";
import {
  freezeAndSeizeSubstandard,
  createFESScripts,
} from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
import {
  createSigningClient,
  getWalletAddress,
  getAdminPkh,
  getNetwork,
  loadStandardBlueprint,
  loadFESBlueprint,
  PREPROD_DEPLOYMENT,
  checkStakeRegistration,
  getTokenName,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 FES Example: Init Compliance ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh");

  const client = createSigningClient();
  const address = state.adminAddress!;
  const adminPkh = state.adminPkh!;
  const tokenName = getTokenName();
  const assetNameHex = stringToHex(tokenName);

  console.log(`Token name: ${tokenName} (hex: ${assetNameHex})`);

  // Pick largest UTxO as bootstrap (one-shot minting policy input)
  const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(address));
  const bootstrapUtxo = walletUtxos.reduce((best: any, u: any) =>
    EvoAssets.lovelaceOf(u.assets) > EvoAssets.lovelaceOf(best.assets) ? u : best,
  );
  const blacklistInitTxInput = {
    txHash: EvoTransactionHash.toHex(bootstrapUtxo.transactionId),
    outputIndex: Number(bootstrapUtxo.index),
  };

  console.log(`Bootstrap UTxO: ${blacklistInitTxInput.txHash}#${blacklistInitTxInput.outputIndex}`);

  // Pre-compute blacklist mint policy ID
  const fesBlueprint = loadFESBlueprint();
  const tempScripts = createFESScripts(fesBlueprint);
  const blacklistMint = tempScripts.buildBlacklistMint(blacklistInitTxInput, adminPkh);
  const blacklistNodePolicyId = blacklistMint.hash;

  console.log(`Blacklist node policy ID: ${blacklistNodePolicyId}`);

  // Create FES substandard
  const fes = freezeAndSeizeSubstandard({
    blueprint: fesBlueprint,
    deployment: {
      adminPkh,
      assetName: assetNameHex,
      blacklistNodePolicyId,
      blacklistInitTxInput,
    },
  });

  // Initialize protocol
  const standardBlueprint = loadStandardBlueprint();
  const protocol = CIP113.init({
    client,
    standard: { blueprint: standardBlueprint, deployment: PREPROD_DEPLOYMENT },
    substandards: [fes],
    checkStakeRegistration,
  });

  // Build init compliance tx
  console.log("\nBuilding init compliance transaction...");
  const result = await protocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address,
    adminAddress: address,
    assetName: tokenName,
    bootstrapUtxo,
  });

  // Sign, submit, and wait
  const txHash = await signSubmitAndWait(result, client, "InitCompliance");

  // Save state
  updateState({
    blacklistNodePolicyId,
    blacklistInitTxInput,
    initComplianceTxHash: txHash,
    assetName: tokenName,
    assetNameHex,
  });

  console.log("State saved. Run: npm run fes:register");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
