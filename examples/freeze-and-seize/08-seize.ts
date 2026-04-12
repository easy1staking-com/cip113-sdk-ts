/**
 * 08 - Seize Tokens
 *
 * Seize tokens from a frozen address and send them to a destination.
 * Requires issuer admin privileges. The target address must be frozen first.
 *
 * Usage: npm run fes:seize
 * Prerequisite: npm run fes:freeze
 */

import {
  CIP113,
  baseAddress,
  EvoAddress,
  EvoTransactionHash,
} from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
import * as Assets from "@evolution-sdk/evolution/Assets";
import * as PolicyId from "@evolution-sdk/evolution/PolicyId";
import * as AssetName from "@evolution-sdk/evolution/AssetName";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadFESBlueprint,
  PREPROD_DEPLOYMENT,
} from "../shared/config.js";
import { loadState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 FES Example: Seize ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "tokenPolicyId", "assetNameHex",
    "blacklistNodePolicyId", "blacklistInitTxInput", "frozenAddress");

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

  // Find the frozen address's token UTxO
  const plbHash = PREPROD_DEPLOYMENT.programmableLogicBase.scriptHash;
  const networkId = client.chain.id;
  const holderPlbAddr = baseAddress(networkId, plbHash, state.frozenAddress!);
  console.log(`Searching for tokens at frozen address PLB: ${holderPlbAddr}`);
  const utxos = await client.getUtxos(EvoAddress.fromBech32(holderPlbAddr));

  function hasToken(utxo: any): boolean {
    const pols = Assets.policies(utxo.assets);
    for (const pol of pols) {
      if (PolicyId.toHex(pol) !== state.tokenPolicyId) continue;
      const toks = Assets.tokens(utxo.assets, pol);
      for (const [aname, qty] of toks) {
        if (AssetName.toHex(aname) === state.assetNameHex && qty > 0n) return true;
      }
    }
    return false;
  }
  const tokenUtxo = utxos.find(hasToken);

  if (!tokenUtxo) {
    console.log("No tokens found at frozen address — nothing to seize.");
    process.exit(0);
  }

  const txHash = EvoTransactionHash.toHex(tokenUtxo.transactionId);
  const outputIndex = Number(tokenUtxo.index);
  console.log(`Seizing from UTxO: ${txHash}#${outputIndex}`);

  const result = await protocol.compliance.seize({
    feePayerAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    utxoTxHash: txHash,
    utxoOutputIndex: outputIndex,
    destinationAddress: state.adminAddress!,
    holderAddress: state.frozenAddress!,
  });

  await signSubmitAndWait(result, client, "Seize");
  console.log("Tokens seized!");
  console.log("Run: npm run fes:unfreeze");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
