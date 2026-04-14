/**
 * 01 - Init Linked Lists
 *
 * Creates both power_users and users linked lists on-chain.
 * Also registers stake addresses for CIP-113 logic scripts.
 *
 * BUILD ONLY — does not submit. Logs CBOR for inspection.
 *
 * Usage: npx tsx examples/bafin/01-init-linked-lists.ts
 * Prerequisite: npx tsx examples/bafin/00-setup.ts
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard } from "../../src/substandards/bafin/index.js";
import { createOgmiosEvaluator } from "../shared/ogmios-evaluator.js";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
  checkStakeRegistration,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 BaFin: Init Linked Lists ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "globalStateInitTxInput",
    "powerUsersInitTxInput", "usersInitTxInput");

  const client = createSigningClient();
  const address = state.adminAddress!;

  console.log(`Wallet: ${address}`);
  console.log(`PU bootstrap: ${(state.powerUsersInitTxInput as any).txHash}#${(state.powerUsersInitTxInput as any).outputIndex}`);
  console.log(`Users bootstrap: ${(state.usersInitTxInput as any).txHash}#${(state.usersInitTxInput as any).outputIndex}`);

  // Create BaFin substandard
  const bafin = bafinSubstandard({
    blueprint: loadBaFinBlueprint(),
    deployment: {
      ownerCredentialHash: state.adminPkh!,
      securityAssetName: state.assetNameHex!,
      globalStateInitTxInput: state.globalStateInitTxInput as { txHash: string; outputIndex: number },
      powerUsersInitTxInput: state.powerUsersInitTxInput as { txHash: string; outputIndex: number },
      usersInitTxInput: state.usersInitTxInput as { txHash: string; outputIndex: number },
    },
  });

  // Use Ogmios for tx evaluation (returns Aiken stack traces on failure)
  const ogmiosUrl = process.env.OGMIOS_URL || "http://panic-station:31357";
  console.log(`Ogmios evaluator: ${ogmiosUrl}`);
  bafin.setEvaluator(createOgmiosEvaluator(ogmiosUrl));

  // Initialize protocol
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: loadDeployment() },
    substandards: [bafin],
    checkStakeRegistration,
  });

  // Build init compliance tx
  console.log("\nBuilding init linked lists transaction...");
  const result = await protocol.compliance.init("bafin", {
    feePayerAddress: address,
    adminAddress: address,
    assetName: state.assetName!,
  });

  // Log results (BUILD ONLY — no submit)
  console.log(`\n--- TX Built (not submitted) ---`);
  console.log(`TX Hash: ${result.txHash}`);
  console.log(`CBOR (${result.cbor.length / 2} bytes):`);
  console.log(result.cbor);
  console.log(`\nMetadata:`);
  console.log(JSON.stringify(result.metadata, null, 2));

  // Uncomment to submit:
  // const txHash = await signSubmitAndWait(result, client, "Init Linked Lists");
  // updateState({ initLinkedListsTxHash: txHash });
  // console.log("Submitted. Run: npx tsx examples/bafin/02-add-power-user.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
