/**
 * 02 - Add Power User
 *
 * Adds the current wallet as a power user with all permissions.
 *
 * BUILD ONLY — does not submit. Logs CBOR for inspection.
 *
 * Usage: npx tsx examples/bafin/02-add-power-user.ts
 * Prerequisite: 01-init-linked-lists submitted and confirmed
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { bafinSubstandard, addPowerUser } from "../../src/substandards/bafin/index.js";
import { createOgmiosEvaluator } from "../shared/ogmios-evaluator.js";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadBaFinBlueprint,
  loadDeployment,
} from "../shared/config.js";
import { loadState, updateState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 BaFin: Add Power User ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "adminPkh", "globalStateInitTxInput",
    "powerUsersInitTxInput", "usersInitTxInput");

  const client = await createSigningClient();
  const address = state.adminAddress!;
  const walletPkh = state.adminPkh!;

  console.log(`Wallet: ${address}`);
  console.log(`Adding as power user: ${walletPkh}`);

  // Create BaFin substandard (to get resolved scripts)
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
  let evaluator: ReturnType<typeof createOgmiosEvaluator> | undefined;
  if (process.env.SKIP_OGMIOS) {
    console.log("Ogmios evaluator: SKIPPED (SKIP_OGMIOS set) — using default (Blockfrost)");
  } else {
    const ogmiosUrl = process.env.OGMIOS_URL || "http://panic-station:31357";
    evaluator = createOgmiosEvaluator(ogmiosUrl);
    console.log(`Ogmios evaluator: ${ogmiosUrl}`);
  }

  // Build add power user tx
  console.log("\nBuilding add power user transaction...");
  const result = await addPowerUser({
    client,
    scripts: {
      powerUsersMint: resolved.powerUsersMint,
      powerUsersSpend: resolved.powerUsersSpend,
      powerUsersLinkedListPolicyId: resolved.powerUsersLinkedListPolicyId,
    },
    networkId: bafin.getNetworkId(),
    feePayerAddress: address,
    ownerCredentialHash: walletPkh,
    evaluator,
    newPowerUser: {
      credentialHash: walletPkh,
      isAdmin: true,
      canMint: true,
      canBurn: true,
      canPause: true,
      canVerify: true,
      canBlacklist: true,
      canForceTransfer: true,
    },
  });

  // Log results (BUILD ONLY)
  console.log(`\n--- TX Built (not submitted) ---`);
  console.log(`TX Hash: ${result.txHash}`);
  console.log(`CBOR (${result.cbor.length / 2} bytes):`);
  console.log(result.cbor);
  console.log(`\nMetadata:`);
  console.log(JSON.stringify(result.metadata, null, 2));

  const txHash = await signSubmitAndWait(result, client, "Add Power User");
  updateState({ addPowerUserTxHash: txHash });
  console.log("Submitted. Run: npx tsx examples/bafin/03-add-user.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
