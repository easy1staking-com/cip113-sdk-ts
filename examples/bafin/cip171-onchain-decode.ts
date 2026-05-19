/**
 * Fetch the CIP-171 metadata from a preview bootstrap tx and decode it via
 * the SDK helper. Confirms that what the bootstrap submitted is a valid
 * CIP-171 record that any verifier (e.g. uplc-link) can parse.
 */

import "dotenv/config";
import { decodeCip171Metadatum, CompilerType } from "@easy1staking/cip113-sdk-ts";

const TX_HASH = process.argv[2] ?? process.env.TX_HASH;
const NETWORK = process.env.NETWORK ?? "preview";
const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;

if (!TX_HASH) throw new Error("Pass tx hash as argv[2] or set TX_HASH");
if (!PROJECT_ID) throw new Error("BLOCKFROST_PROJECT_ID required");

const url = `https://cardano-${NETWORK}.blockfrost.io/api/v0/txs/${TX_HASH}/metadata`;
const res = await fetch(url, { headers: { project_id: PROJECT_ID } });
if (!res.ok) throw new Error(`Blockfrost ${res.status}: ${await res.text()}`);

type BFMetadatum = { label: string; json_metadata: unknown };
const items = (await res.json()) as BFMetadatum[];
const cip171 = items.find((m) => m.label === "1984");
if (!cip171) throw new Error("No metadata label 1984 on this tx");
if (!Array.isArray(cip171.json_metadata)) {
  throw new Error("Expected an array under label 1984");
}

const chunks = (cip171.json_metadata as string[]).map((s) => {
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
});

console.log(`tx     : ${TX_HASH}`);
console.log(`network: ${NETWORK}`);
console.log(`chunks : ${chunks.length} (${chunks.reduce((n, c) => n + c.length, 0)} bytes)`);
console.log(`sizes  : ${chunks.map((c) => c.length).join(",")}`);

const record = decodeCip171Metadatum(chunks);

const compilerName =
  Object.entries(CompilerType).find(([, v]) => v === record.compilerType)?.[0] ??
  `unknown(${record.compilerType})`;

console.log("\n--- decoded CIP-171 record ---");
console.log(`compilerType    : ${record.compilerType} (${compilerName})`);
console.log(`sourceUrl       : ${record.sourceUrl}`);
console.log(`commitHash      : ${record.commitHash}`);
console.log(`sourcePath      : ${JSON.stringify(record.sourcePath)}`);
console.log(`compilerVersion : ${record.compilerVersion}`);
console.log(`scripts         : ${record.scripts.length}`);
for (const s of record.scripts) {
  console.log(`  - ${s.rawScriptHash}  (${s.params.length} param${s.params.length === 1 ? "" : "s"})`);
}
console.log("\nVERIFIER OK — record decoded and parsed.");
