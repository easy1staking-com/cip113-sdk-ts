/**
 * 06 - Freeze Address
 *
 * Add an address to the blacklist. Once frozen, that address
 * cannot transfer programmable tokens.
 *
 * Usage: npm run fes:freeze
 * Prerequisite: npm run fes:init-compliance
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
  console.log("=== CIP-113 FES Example: Freeze ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput");

  const client = createSigningClient();

  // Determine target address to freeze
  const secondClient = createSecondClient();
  const targetAddress = secondClient
    ? await getWalletAddress(secondClient)
    : state.adminAddress!;

  console.log(`Freezing address: ${targetAddress}`);

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

  const result = await protocol.compliance.freeze({
    feePayerAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    targetAddress,
  });

  await signSubmitAndWait(result, client, "Freeze");

  updateState({ frozenAddress: targetAddress });
  console.log(`Address frozen: ${targetAddress}`);
  console.log("Run: npm run fes:transfer-blocked");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
