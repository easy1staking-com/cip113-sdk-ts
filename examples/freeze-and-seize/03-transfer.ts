/**
 * 03 - Transfer Tokens
 *
 * Transfer programmable tokens between addresses. The transfer includes
 * a blacklist non-membership proof — if the sender is blacklisted,
 * the transfer will be denied.
 *
 * Usage: npm run fes:transfer
 * Prerequisite: npm run fes:register
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
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 FES Example: Transfer ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput");

  const client = createSigningClient();
  const senderAddress = state.adminAddress!;

  // Determine recipient
  const secondClient = createSecondClient();
  const recipientAddress = secondClient
    ? await getWalletAddress(secondClient)
    : senderAddress; // transfer to self if no second wallet

  console.log(`Sender:    ${senderAddress}`);
  console.log(`Recipient: ${recipientAddress}`);
  console.log(`Token:     ${state.tokenPolicyId}`);

  // Create protocol
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

  // Transfer
  const quantity = 100n;
  console.log(`\nTransferring ${quantity} tokens...`);

  const result = await protocol.transfer({
    senderAddress,
    recipientAddress,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    quantity,
    substandardId: "freeze-and-seize",
  });

  const txHash = await signSubmitAndWait(result, client, "Transfer");

  updateState({ lastTransferTxHash: txHash });
  console.log(`Transferred ${quantity} tokens!`);
  console.log("Run: npm run fes:mint");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
