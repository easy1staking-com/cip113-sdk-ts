/**
 * 09 - Unfreeze Address
 *
 * Remove an address from the blacklist. Once unfrozen,
 * the address can transfer tokens again.
 *
 * Usage: npm run fes:unfreeze
 * Prerequisite: npm run fes:freeze
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
  console.log("=== CIP-113 FES Example: Unfreeze ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput", "frozenAddress");

  const client = createSigningClient();

  console.log(`Unfreezing address: ${state.frozenAddress}`);

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

  const result = await protocol.compliance.unfreeze({
    feePayerAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    targetAddress: state.frozenAddress!,
  });

  await signSubmitAndWait(result, client, "Unfreeze");

  updateState({ frozenAddress: undefined });
  console.log("Address unfrozen!");
  console.log("Run: npm run fes:transfer-unfrozen");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
