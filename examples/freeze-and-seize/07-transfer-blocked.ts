/**
 * 07 - Transfer Blocked
 *
 * Demonstrates that a frozen address cannot transfer tokens.
 * The SDK checks blacklist membership and throws before building the tx.
 *
 * Usage: npm run fes:transfer-blocked
 * Prerequisite: npm run fes:freeze
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
import {
  createSigningClient,
  createSecondClient,
  getWalletAddress,
  loadStandardBlueprint,
  loadFESBlueprint,
  PREPROD_DEPLOYMENT,
} from "../shared/config.js";
import { loadState, requireState } from "../shared/state.js";

async function main() {
  console.log("=== CIP-113 FES Example: Transfer Blocked ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput", "frozenAddress");

  // Use the frozen address's wallet as sender
  const secondClient = createSecondClient();
  const client = secondClient || createSigningClient();
  const senderAddress = state.frozenAddress!;

  console.log(`Attempting transfer from frozen address: ${senderAddress}`);

  const fes = freezeAndSeizeSubstandard({
    blueprint: loadFESBlueprint(),
    deployment: {
      adminPkh: state.adminPkh!,
      assetName: state.assetNameHex!,
      blacklistNodePolicyId: state.blacklistNodePolicyId!,
      blacklistInitTxInput: state.blacklistInitTxInput as { txHash: string; outputIndex: number },
    },
  });

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: PREPROD_DEPLOYMENT },
    substandards: [fes],
  });

  try {
    await protocol.transfer({
      senderAddress,
      recipientAddress: state.adminAddress!,
      tokenPolicyId: state.tokenPolicyId!,
      assetName: state.assetNameHex!,
      quantity: 1n,
      substandardId: "freeze-and-seize",
    });

    console.error("ERROR: Transfer should have been blocked!");
    process.exit(1);
  } catch (error: any) {
    console.log(`Transfer correctly denied: ${error.message}`);
    console.log("\nBlacklist enforcement is working!");
    console.log("Run: npm run fes:seize");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
