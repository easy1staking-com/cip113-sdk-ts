/**
 * Deploy a CIP-113 protocol instance to a public testnet (preview).
 *
 * Same sequence as the devnet fixture — `bootstrapProtocol` — with the provider
 * swapped. It is NOT a test: it writes permanent state to a shared chain, so it
 * is run by hand and its output is a `DeploymentParams` to keep.
 *
 * ⚠ CIP-171 metadata is NOT emitted here. That path does not exist yet, and it
 * costs this deployment nothing: CIP-0171 associates a record with a script BY
 * SCRIPT HASH, not by transaction — "query the blockchain for transactions
 * containing metadata label 1984 ... if the computed script hash matches an
 * on-chain script hash, the link is verified". A record can therefore be
 * published later, by anyone, in any transaction. Deploying now forecloses
 * nothing.
 *
 * Usage: npx tsx test/harness/deploy-preview.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { previewChain, evoClient, EvoAddress, EvoAssets } from "../../dist/index.js";
import { bootstrapProtocol } from "./bootstrap.js";

function loadEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

async function main() {
  const env = loadEnv(new URL("../../.env.preview", import.meta.url).pathname);
  for (const k of ["WALLET_MNEMONIC", "BLOCKFROST_KEY"]) {
    if (!env[k]) throw new Error(`.env.preview is missing ${k}`);
  }

  // ⚠ previewChain comes from OUR dist, not from @evolution-sdk/evolution —
  // that package does not export it, and `Client.make(undefined)` SILENTLY
  // DEFAULTS TO MAINNET. Measured: it derived an addr1q… address and queried
  // mainnet without raising anything.
  const client = evoClient(previewChain)
    .withBlockfrost({
      projectId: env.BLOCKFROST_KEY,
      baseUrl: "https://cardano-preview.blockfrost.io/api/v0",
    })
    .withSeed({ mnemonic: env.WALLET_MNEMONIC });

  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  const utxos = await client.getUtxos(addressObj);
  const balance = utxos.reduce((s: bigint, u: any) => s + EvoAssets.lovelaceOf(u.assets), 0n);

  console.log(`network   : preview (id ${client.chain.id})`);
  console.log(`address   : ${address}`);
  console.log(`balance   : ${Number(balance) / 1e6} ADA across ${utxos.length} UTxO(s)`);
  if (client.chain.id !== 0) throw new Error("refusing: not a testnet");

  console.log("\nbootstrapping — 3 transactions, each waited for on chain...\n");
  // Ask the chain whether the upgrade authority's stake credential is already
  // registered, rather than letting the bootstrap infer it from an error
  // string. The wallet's credential survives across deployments, and
  // Blockfrost's opaque "submitTx failed" carries none of the words the
  // devnet-era tolerance matched on.
  const isStakeRegistered = async (stakeAddress: string) => {
    const r = await fetch(
      `https://cardano-preview.blockfrost.io/api/v0/accounts/${stakeAddress}`,
      { headers: { project_id: env.BLOCKFROST_KEY } }
    );
    return r.ok; // 200 registered, 404 not
  };

  const deployment = await bootstrapProtocol({ client, isStakeRegistered });

  const out = new URL("../../deployment-preview.json", import.meta.url).pathname;
  writeFileSync(out, JSON.stringify(deployment, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nDeploymentParams written to ${out}`);
  console.log(`bootstrap tx: ${deployment.txHash}`);
}

main().catch((e) => {
  // Print the WHOLE error. "Blockfrost submitTx failed" names the caller, not
  // the cause; the ledger's reason lives in the nested response body.
  console.error("DEPLOYMENT FAILED:", e?.message ?? e);
  const seen = new Set<unknown>();
  const dump = (o: any, depth = 0): void => {
    if (!o || depth > 6 || seen.has(o)) return;
    seen.add(o);
    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v.length < 4000 && /[a-z]/i.test(v)) {
          console.error(`  ${"  ".repeat(depth)}${k}: ${v.slice(0, 600)}`);
        } else if (v && typeof v === "object") dump(v, depth + 1);
      }
    }
  };
  dump(e);
  process.exitCode = 1;
});
