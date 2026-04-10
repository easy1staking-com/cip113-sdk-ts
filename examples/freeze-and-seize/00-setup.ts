/**
 * 00 - Setup
 *
 * Validates environment configuration, shows wallet address and ADA balance.
 * Run this first to make sure everything is wired up correctly.
 *
 * Usage: npm run fes:setup
 */

import {
  createSigningClient,
  getWalletAddress,
  getAdminPkh,
  getNetwork,
  createSecondClient,
} from "../shared/config.js";
import { updateState } from "../shared/state.js";
import { EvoAssets, EvoAddress } from "@easy1staking/cip113-sdk-ts";

async function main() {
  console.log("=== CIP-113 FES Example: Setup ===\n");

  const network = getNetwork();
  console.log(`Network: ${network}`);

  // Primary wallet
  const client = createSigningClient();
  const address = await getWalletAddress(client);
  const adminPkh = getAdminPkh(address);

  console.log(`Wallet address: ${address}`);
  console.log(`Payment key hash: ${adminPkh}`);

  // Check balance
  const utxos = await client.getUtxos(EvoAddress.fromBech32(address));
  const totalLovelace = utxos.reduce(
    (sum: bigint, u: any) => sum + EvoAssets.lovelaceOf(u.assets),
    0n,
  );
  const adaBalance = Number(totalLovelace) / 1_000_000;
  console.log(`Balance: ${adaBalance.toFixed(6)} ADA (${utxos.length} UTxOs)`);

  if (totalLovelace < 10_000_000n) {
    console.warn("\nWarning: Low balance. Get test ADA from the faucet:");
    console.warn("  https://docs.cardano.org/cardano-testnets/tools/faucet/");
  }

  // Optional second wallet
  const secondClient = createSecondClient();
  if (secondClient) {
    const secondAddr = await getWalletAddress(secondClient);
    console.log(`\nSecond wallet: ${secondAddr}`);
  } else {
    console.log("\nNo SECOND_WALLET_MNEMONIC set — transfers will go to self.");
  }

  // Save state
  updateState({ adminAddress: address, adminPkh });

  console.log("\nSetup complete. Run: npm run fes:init-compliance");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
