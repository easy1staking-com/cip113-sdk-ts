/**
 * 04 - Mint Additional Tokens
 *
 * Mint more tokens for an already-registered programmable token.
 * Requires issuer admin privileges.
 *
 * Usage: npm run fes:mint
 * Prerequisite: npm run fes:register
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
  console.log("=== CIP-113 FES Example: Mint ===\n");

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

  const quantity = 500_000n;
  console.log(`Minting ${quantity} additional tokens (policy: ${state.tokenPolicyId})`);

  const result = await protocol.mint({
    feePayerAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    quantity,
    recipientAddress: state.adminAddress!,
  });

  await signSubmitAndWait(result, client, "Mint");
  console.log(`Minted ${quantity} tokens!`);
  console.log("Run: npm run fes:burn");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
