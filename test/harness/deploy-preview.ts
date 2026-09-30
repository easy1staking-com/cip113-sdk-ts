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
import { readFileSync } from "node:fs";
import { previewChain, evoClient, EvoAddress, EvoAssets } from "../../dist/index.js";
import { bootstrapProtocol } from "./bootstrap.js";
import { saveInstance, requireInstanceName } from "./instances.mjs";

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
  // Resolved FIRST, deliberately: a missing or malformed instance name must
  // fail before the bootstrap spends anything. The seed UTxOs are one-shot.
  const instanceName = requireInstanceName("preview");

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

  console.log("\nbootstrapping — 7 transactions, each waited for on chain...\n");

  /**
   * ⛔ ASK THE SOURCE THE DEPLOYMENT WILL BE READ FROM, not the SDK's poller.
   *
   * MEASURED and recorded in bootstrap.ts: Evolution's own `awaitTx` gave up on
   * preview while the transaction had ALREADY been included — Blockfrost's
   * confirmation view lags block inclusion, so the poller and the reader
   * disagree. A bootstrap that aborts on a transaction that SUCCEEDED leaves
   * one-shot seeds spent and no record, which is the most expensive way for
   * this to fail. The harness names the remedy and no caller had implemented
   * it; this is that.
   *
   * 404 is "not yet", not "never" — Blockfrost returns it until the tx is
   * indexed. Anything else is reported rather than swallowed.
   */
  /** Two consecutive identical UTxO reads — a cheap proxy for "the view has settled". */
  const settleUtxoView = async () => {
    const fingerprint = async () => {
      // ⛔ `fetch` THROWS on a transport blip; it does not return a bad status.
      // MEASURED 2026-09-28: a bare `fetch failed` propagated out of this
      // poller AFTER all seven transactions were on chain, so bootstrapProtocol
      // threw instead of returning, and the DeploymentParams — the only thing
      // that cannot be rebuilt from the chain without guessing the seed mapping
      // — was never written. A deployment that succeeded and produced no record
      // is the most expensive way for this to fail.
      let r: Response;
      try {
        r = await fetch(
          `https://cardano-preview.blockfrost.io/api/v0/addresses/${address}/utxos?count=100`,
          { headers: { project_id: env.BLOCKFROST_KEY } }
        );
      } catch {
        return null; // transport failure is "unknown", never "settled"
      }
      if (!r.ok) return null;
      const u = (await r.json()) as Array<{ tx_hash: string; output_index: number }>;
      return u.map((x) => `${x.tx_hash}#${x.output_index}`).sort().join(",");
    };
    let prev = await fingerprint();
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 3_000));
      const now = await fingerprint();
      if (now !== null && now === prev) return;
      prev = now;
    }
    console.warn("  [settle] UTxO view still moving after 2 minutes; continuing anyway");
  };

  const awaitTx = async (txHash: string) => {
    const deadline = Date.now() + 10 * 60_000;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      let r: Response;
      try {
        r = await fetch(`https://cardano-preview.blockfrost.io/api/v0/txs/${txHash}`, {
          headers: { project_id: env.BLOCKFROST_KEY },
        });
      } catch (e) {
        // Same reason as the fingerprint above: a transport blip is "not yet",
        // not "failed". Retry until the deadline rather than abandoning a
        // deployment whose transactions are already on chain.
        console.warn(`  [awaitTx] ${txHash}: transport error, retrying — ${(e as Error)?.message}`);
        await new Promise((res) => setTimeout(res, 5_000));
        continue;
      }
      lastStatus = r.status;
      if (r.ok) {
        // ⛔ TX-VISIBLE IS NOT UTxO-SETTLED, AND THAT DISTINCTION COST A
        // DEPLOYMENT. Blockfrost serves `/txs/{hash}` and
        // `/addresses/{addr}/utxos` from views that advance INDEPENDENTLY.
        // MEASURED 2026-09-28: five transactions confirmed here, and the sixth
        // was then built against a UTxO list that still showed inputs the fifth
        // had already spent. The ledger refused it with
        //   ConwayMempoolFailure "All inputs are spent. Transaction has
        //   probably already been included"
        // — a message that names the wrong cause. It had NOT been included;
        // its inputs simply no longer existed. Waiting on tx-visibility alone
        // answers a question nobody asked.
        //
        // So settle the view the next step will actually read: two consecutive
        // IDENTICAL UTxO fingerprints. A single read cannot tell a settled
        // view from a stale one. Same technique the devnet harness uses
        // against Kupo, applied to the provider this path uses.
        await settleUtxoView();
        console.log(`  on chain: ${txHash}`);
        return;
      }
      if (r.status !== 404) {
        console.warn(`  [awaitTx] ${txHash}: unexpected ${r.status}, still waiting`);
      }
      await new Promise((res) => setTimeout(res, 5_000));
    }
    throw new Error(
      `Timed out after 10 minutes waiting for ${txHash} to appear on preview ` +
        `(last Blockfrost status ${lastStatus}). The transaction may still be on chain — ` +
        `CHECK BEFORE RE-RUNNING, because the seed UTxOs it spent are one-shot.`
    );
  };
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

  const deployment = await bootstrapProtocol({ client, isStakeRegistered, awaitTx });

  const out = saveInstance("preview", instanceName, deployment);
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
