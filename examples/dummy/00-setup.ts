/**
 * 00 - Dummy Setup
 *
 * Same as FES setup — validates env and shows wallet info.
 *
 * Usage: npm run dummy:setup
 */

import {
  createSigningClient,
  getWalletAddress,
  getAdminPkh,
  getNetwork,
} from "../shared/config.js";
import { updateState } from "../shared/state.js";
import { EvoAssets, EvoAddress } from "@easy1staking/cip113-sdk-ts";

async function main() {
  console.log("=== CIP-113 Dummy Example: Setup ===\n");

  const network = getNetwork();
  console.log(`Network: ${network}`);

  const client = createSigningClient();
  const address = await getWalletAddress(client);
  const adminPkh = getAdminPkh(address);

  console.log(`Wallet address: ${address}`);
  console.log(`Payment key hash: ${adminPkh}`);

  const utxos = await client.getUtxos(EvoAddress.fromBech32(address));
  const totalLovelace = utxos.reduce(
    (sum: bigint, u: any) => sum + EvoAssets.lovelaceOf(u.assets),
    0n,
  );
  console.log(`Balance: ${(Number(totalLovelace) / 1_000_000).toFixed(6)} ADA`);

  updateState({ adminAddress: address, adminPkh });
  console.log("\nSetup complete. Run: npm run dummy:transfer");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
