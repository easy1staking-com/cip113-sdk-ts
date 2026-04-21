/**
 * 04 - Register Token
 *
 * First mint + CIP-113 registry insert + global state update.
 * This is the main registration transaction.
 *
 * BUILD ONLY — does not submit. Logs CBOR for inspection.
 *
 * Usage: npx tsx examples/bafin/04-register.ts
 * Prerequisite: 03-add-user submitted and confirmed
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard } from "../../src/substandards/bafin/index.js";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 BaFin: Register Token ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "assetName", "assetNameHex",
    "globalStateInitTxInput", "powerUsersInitTxInput", "usersInitTxInput");

  const client = await createSigningClient();
  const address = state.adminAddress!;
  const walletPkh = state.adminPkh!;

  console.log(`Wallet: ${address}`);
  console.log(`Token: ${state.assetName}`);

  // Create BaFin substandard
  const bafin = bafinSubstandard({
    blueprint: loadBaFinBlueprint(),
    deployment: {
      ownerCredentialHash: walletPkh,
      securityAssetName: state.assetNameHex!,
      globalStateInitTxInput: state.globalStateInitTxInput as { txHash: string; outputIndex: number },
      powerUsersInitTxInput: state.powerUsersInitTxInput as { txHash: string; outputIndex: number },
      usersInitTxInput: state.usersInitTxInput as { txHash: string; outputIndex: number },
    },
  });

  // Initialize protocol
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
  });

  const resolved = bafin.getScripts();
  console.log(`Token policy ID: ${resolved.tokenPolicyId}`);

  // Build register tx
  const quantity = 1_000_000n;
  console.log(`\nBuilding register transaction (qty: ${quantity})...`);

  const result = await protocol.register("bafin", {
    feePayerAddress: address,
    assetName: state.assetName!,
    quantity,
    recipientAddress: address,
    config: {
      powerUserCredentialHash: walletPkh,
    },
  });

  // Log results (BUILD ONLY)
  console.log(`\n--- TX Built (not submitted) ---`);
  console.log(`TX Hash: ${result.txHash}`);
  console.log(`Token Policy ID: ${result.tokenPolicyId}`);
  console.log(`CBOR (${result.cbor.length / 2} bytes):`);
  console.log(result.cbor);
  console.log(`\nMetadata:`);
  console.log(JSON.stringify(result.metadata, null, 2));

  const txHash = await signSubmitAndWait(result, client, "Register Token");
  updateState({ tokenPolicyId: result.tokenPolicyId, registerTxHash: txHash });
  console.log(`Token registered! Policy: ${result.tokenPolicyId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
