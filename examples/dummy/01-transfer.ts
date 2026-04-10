/**
 * 01 - Dummy Transfer
 *
 * Transfer tokens using the dummy substandard.
 * The dummy substandard has no compliance checks — transfers always succeed.
 *
 * Note: This requires a pre-existing dummy token on-chain.
 * Set TOKEN_POLICY_ID and ASSET_NAME_HEX in your .env or state.
 *
 * Usage: npm run dummy:transfer
 * Prerequisite: npm run dummy:setup + existing dummy token
 */

import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { dummySubstandard } from "@easy1staking/cip113-sdk-ts/dummy";
import {
  createSigningClient,
  loadStandardBlueprint,
  loadDummyBlueprint,
  PREPROD_DEPLOYMENT,
} from "../shared/config.js";
import { loadState, requireState } from "../shared/state.js";
import { signSubmitAndWait } from "../shared/wait-tx.js";

async function main() {
  console.log("=== CIP-113 Dummy Example: Transfer ===\n");

  const state = loadState();
  requireState(state, "adminAddress", "tokenPolicyId", "assetNameHex");

  const client = createSigningClient();

  const dummy = dummySubstandard({ blueprint: loadDummyBlueprint() });
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment: PREPROD_DEPLOYMENT },
    substandards: [dummy],
  });

  const quantity = 10n;
  console.log(`Transferring ${quantity} tokens (dummy, no compliance)...`);

  const result = await protocol.transfer({
    senderAddress: state.adminAddress!,
    recipientAddress: state.adminAddress!,
    tokenPolicyId: state.tokenPolicyId!,
    assetName: state.assetNameHex!,
    quantity,
  });

  await signSubmitAndWait(result, client, "DummyTransfer");
  console.log("Transfer complete!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
