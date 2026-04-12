/**
 * 10 - Transfer After Unfreeze
 *
 * Demonstrates that after unfreezing, the address can transfer tokens again.
 * This completes the full Freeze-and-Seize lifecycle.
 *
 * Usage: npm run fes:transfer-unfrozen
 * Prerequisite: npm run fes:unfreeze
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadFESBlueprint,
  PREPROD_DEPLOYMENT,
} from "../shared/config.js";
import { loadState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 FES Example: Transfer After Unfreeze ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput");

  const client = createSigningClient();

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

  const quantity = 10n;
  console.log(`Transferring ${quantity} tokens (post-unfreeze)...`);

  const result = await protocol.transfer({
    senderAddress: state.adminAddress!,
    recipientAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    quantity,
    substandardId: "freeze-and-seize",
  });

  await signSubmitAndWait(result, client, "Transfer");

  console.log("Transfer successful! The full FES lifecycle is complete.");
  console.log("\nLifecycle summary:");
  console.log("  00-setup             -> Wallet configured");
  console.log("  01-init-compliance   -> Blacklist created");
  console.log("  02-register          -> Token minted & registered");
  console.log("  03-transfer          -> Tokens transferred");
  console.log("  04-mint              -> Additional tokens minted");
  console.log("  05-burn              -> Tokens burned");
  console.log("  06-freeze            -> Address frozen");
  console.log("  07-transfer-blocked  -> Transfer denied (blacklisted)");
  console.log("  08-seize             -> Tokens seized from frozen address");
  console.log("  09-unfreeze          -> Address unfrozen");
  console.log("  10-transfer-unfrozen -> Transfer works again");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
