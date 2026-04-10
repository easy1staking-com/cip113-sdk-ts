/**
 * 02 - Register Token
 *
 * Mints the initial token supply and registers it in the CIP-113 registry.
 * The token policy ID is derived from the issuer admin script.
 *
 * Usage: npm run fes:register
 * Prerequisite: npm run fes:init-compliance
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadFESBlueprint,
  PREPROD_DEPLOYMENT,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 FES Example: Register Token ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "blacklistNodePolicyId", "blacklistInitTxInput", "assetName");

  const client = createSigningClient();
  const address = state.adminAddress!;

  // Create FES substandard with saved deployment params
  const fes = freezeAndSeizeSubstandard({
    blueprint: loadFESBlueprint(),
    deployment: {
      adminPkh: state.adminPkh!,
      assetName: state.assetNameHex!,
      blacklistNodePolicyId: state.blacklistNodePolicyId!,
      blacklistInitTxInput: state.blacklistInitTxInput as { txHash: string; outputIndex: number },
    },
  });

  // Initialize protocol
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: PREPROD_DEPLOYMENT },
    substandards: [fes],
  });

  // Register token (first mint + registry insert)
  const quantity = 1_000_000n;
  console.log(`Registering token "${state.assetName}" with initial supply: ${quantity}`);

  const result = await protocol.register("freeze-and-seize", {
    feePayerAddress: address,
    assetName: state.assetName!,
    quantity,
    recipientAddress: address,
  });

  console.log(`Token policy ID: ${result.tokenPolicyId}`);

  // Sign, submit, and wait
  const txHash = await signSubmitAndWait(result, client, "Register");

  // Save state
  updateState({
    tokenPolicyId: result.tokenPolicyId,
    registerTxHash: txHash,
  });

  console.log(`Token registered! Policy: ${result.tokenPolicyId}`);
  console.log("Run: npm run fes:transfer");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
