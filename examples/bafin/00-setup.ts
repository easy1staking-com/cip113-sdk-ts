/**
 * 00 - BaFin Setup
 *
 * Validates environment, shows wallet info, picks bootstrap UTxOs for
 * linked list + global state initialization, and computes all derived policy IDs.
 *
 * Usage: npx tsx examples/bafin/00-setup.ts
 */

import {
  CIP113,
  stringToHex,
  EvoAssets,
  EvoAddress,
  EvoTransactionHash,
} from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard } from "../../src/substandards/bafin/index.js";
import {
  createSigningClient,
  getWalletAddress,
  getAdminPkh,
  getNetwork,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
  getTokenName,
} from "../shared/config.js";
import { updateState } from "../shared/state.js";

async function main() {
  console.log("=== CIP-113 BaFin: Setup ===\n");

  const network = getNetwork();
  console.log(`Network: ${network}`);

  const client = await createSigningClient();
  const address = await getWalletAddress(client);
  const walletPkh = getAdminPkh(address);

  console.log(`Wallet address: ${address}`);
  console.log(`Payment key hash (owner): ${walletPkh}`);

  // Check balance
  const utxos = await client.getUtxos(EvoAddress.fromBech32(address));
  const totalLovelace = utxos.reduce(
    (sum: bigint, u: any) => sum + EvoAssets.lovelaceOf(u.assets),
    0n,
  );
  const adaBalance = Number(totalLovelace) / 1_000_000;
  console.log(`Balance: ${adaBalance.toFixed(6)} ADA (${utxos.length} UTxOs)`);

  if (totalLovelace < 50_000_000n) {
    console.warn("\nWarning: Low balance. BaFin init needs ~50 ADA across 4 txs.");
  }

  // Pick three UTxOs as bootstrap for one-shot minting (global state + 2 linked lists)
  const sorted = [...utxos].sort((a: any, b: any) => {
    const aL = EvoAssets.lovelaceOf(a.assets);
    const bL = EvoAssets.lovelaceOf(b.assets);
    return aL > bL ? -1 : aL < bL ? 1 : 0;
  });

  if (sorted.length < 3) {
    console.error("\nNeed at least 3 UTxOs for bootstrap. Send some ADA to split UTxOs.");
    process.exit(1);
  }

  const gsBootstrap = {
    txHash: EvoTransactionHash.toHex(sorted[0].transactionId),
    outputIndex: Number(sorted[0].index),
  };
  const puBootstrap = {
    txHash: EvoTransactionHash.toHex(sorted[1].transactionId),
    outputIndex: Number(sorted[1].index),
  };
  const usersBootstrap = {
    txHash: EvoTransactionHash.toHex(sorted[2].transactionId),
    outputIndex: Number(sorted[2].index),
  };

  console.log(`\nBootstrap UTxOs:`);
  console.log(`  Global state: ${gsBootstrap.txHash}#${gsBootstrap.outputIndex}`);
  console.log(`  Power users:  ${puBootstrap.txHash}#${puBootstrap.outputIndex}`);
  console.log(`  Users:        ${usersBootstrap.txHash}#${usersBootstrap.outputIndex}`);

  // Token name
  const tokenName = getTokenName();
  const assetNameHex = stringToHex(tokenName);
  console.log(`\nToken name: ${tokenName} (hex: ${assetNameHex})`);

  // Initialize protocol to compute all derived IDs
  const bafin = bafinSubstandard({
    blueprint: loadBaFinBlueprint(),
    deployment: {
      ownerCredentialHash: walletPkh,
      securityAssetName: assetNameHex,
      globalStateInitTxInput: gsBootstrap,
      powerUsersInitTxInput: puBootstrap,
      usersInitTxInput: usersBootstrap,
    },
  });

  CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
  });

  const resolved = bafin.getScripts();

  console.log(`\nDerived policy IDs:`);
  console.log(`  Global state:  ${resolved.globalStatePolicyId}`);
  console.log(`  Power users LL: ${resolved.powerUsersLinkedListPolicyId}`);
  console.log(`  Users LL:       ${resolved.usersLinkedListPolicyId}`);
  console.log(`  Token policy:   ${resolved.tokenPolicyId}`);

  // Save state
  updateState({
    adminAddress: address,
    adminPkh: walletPkh,
    assetName: tokenName,
    assetNameHex,
    globalStateInitTxInput: gsBootstrap,
    powerUsersInitTxInput: puBootstrap,
    usersInitTxInput: usersBootstrap,
  });

  console.log("\nState saved. Run: npx tsx examples/bafin/01-init-linked-lists.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
