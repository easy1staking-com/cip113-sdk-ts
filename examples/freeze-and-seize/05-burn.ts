/**
 * 05 - Burn Tokens
 *
 * Burn tokens from a specific UTxO. Requires issuer admin privileges.
 * Finds the first UTxO holding the token at the admin's PLB address.
 *
 * Usage: npm run fes:burn
 * Prerequisite: npm run fes:register
 */

import {
  CIP113,
  baseAddress,
  EvoAddress,
  EvoTransactionHash,
} from "@easy1staking/cip113-sdk-ts";
import * as Assets from "@evolution-sdk/evolution/Assets";
import * as PolicyId from "@evolution-sdk/evolution/PolicyId";
import * as AssetName from "@evolution-sdk/evolution/AssetName";
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
  console.log("=== CIP-113 FES Example: Burn ===\n");

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

  // Find a token UTxO at the admin's PLB address
  const plbHash = PREPROD_DEPLOYMENT.programmableLogicBase.scriptHash;
  const networkId = client.chain.id;
  const plbAddr = baseAddress(networkId, plbHash, state.adminAddress!);

  console.log(`Searching for token UTxOs at PLB address: ${plbAddr}`);
  const utxos = await client.getUtxos(EvoAddress.fromBech32(plbAddr));

  // Find a UTxO holding our token
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
    console.error("No token UTxOs found to burn.");
    process.exit(1);
  }

  const txHash = EvoTransactionHash.toHex(tokenUtxo.transactionId);
  const outputIndex = Number(tokenUtxo.index);
  console.log(`Burning from UTxO: ${txHash}#${outputIndex}`);

  const result = await protocol.burn({
    feePayerAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    utxoTxHash: txHash,
    utxoOutputIndex: outputIndex,
    substandardId: "freeze-and-seize",
  });

  await signSubmitAndWait(result, client, "Burn");
  console.log("Tokens burned!");
  console.log("Run: npm run fes:freeze");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
