/**
 * 03 - Add User
 *
 * Adds the current wallet as a verified, non-blacklisted user.
 * Requires an existing power user (from step 02) as reference input.
 *
 * BUILD ONLY — does not submit. Logs CBOR for inspection.
 *
 * Usage: npx tsx examples/bafin/03-add-user.ts
 * Prerequisite: 02-add-power-user submitted and confirmed
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard, addUser } from "../../src/substandards/bafin/index.js";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 BaFin: Add User ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "globalStateInitTxInput",
    "powerUsersInitTxInput", "usersInitTxInput");

  const client = await createSigningClient();
  const address = state.adminAddress!;
  const walletPkh = state.adminPkh!;

  console.log(`Wallet: ${address}`);
  console.log(`Adding as user: ${walletPkh}`);
  console.log(`Power user (ref input): ${walletPkh}`);

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

  // Init protocol to resolve scripts
  CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
  });

  const resolved = bafin.getScripts();

  // Build add user tx
  console.log("\nBuilding add user transaction...");
  const result = await addUser({
    client,
    scripts: {
      usersMint: resolved.usersMint,
      usersSpend: resolved.usersSpend,
      usersLinkedListPolicyId: resolved.usersLinkedListPolicyId,
      powerUsersSpend: resolved.powerUsersSpend,
      powerUsersLinkedListPolicyId: resolved.powerUsersLinkedListPolicyId,
    },
    networkId: bafin.getNetworkId(),
    feePayerAddress: address,
    powerUserCredentialHash: walletPkh,
    newUserCredentialHash: walletPkh,
    isVerified: true,
    isBlacklisted: false,
  });

  // Log results (BUILD ONLY)
  console.log(`\n--- TX Built (not submitted) ---`);
  console.log(`TX Hash: ${result.txHash}`);
  console.log(`CBOR (${result.cbor.length / 2} bytes):`);
  console.log(result.cbor);
  console.log(`\nMetadata:`);
  console.log(JSON.stringify(result.metadata, null, 2));

  const txHash = await signSubmitAndWait(result, client, "Add User");
  updateState({ addUserTxHash: txHash });
  console.log("Submitted. Run: npx tsx examples/bafin/04-register.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
