/**
 * Tiny dispatcher for the `yaci:*` npm scripts (reset, topup).
 * Keeps README one-liners free of curl.
 */

import { topupAddress, resetDevnet } from "./yaci.js";

const [, , cmd, ...args] = process.argv;

async function run() {
  switch (cmd) {
    case "reset": {
      await resetDevnet();
      console.log("Yaci devnet reset.");
      return;
    }
    case "topup": {
      const [address, adaStr] = args;
      if (!address || !adaStr) {
        console.error("Usage: tsx shared/yaci-cli.ts topup <addr> <ada>");
        process.exit(1);
      }
      await topupAddress(address, BigInt(adaStr) * 1_000_000n);
      console.log(`Topped up ${address} with ${adaStr} ADA.`);
      return;
    }
    default:
      console.error(`Unknown command: ${cmd ?? "(none)"}`);
      console.error("Available: reset | topup <addr> <ada>");
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
