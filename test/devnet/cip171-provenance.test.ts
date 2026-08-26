/**
 * The bootstrap's CIP-171 record must RECOMPUTE to the hashes actually deployed.
 *
 * ⚠ "The transaction submitted" is not evidence. A wrong-arity constr-0 record
 * is discarded by the reference parser with only a log line — no error, no
 * REJECTED row, no trace — so a dropped record and a never-published one are
 * indistinguishable from outside. The only check worth running is a positive
 * one, and the strongest available offline is recomputation:
 *
 *     raw script + recorded params  ->  hash  ==  the hash on chain
 *
 * A record that does not survive that is decoration.
 *
 * NOT CIRCULAR: the record is read back through CBOR encode -> decode, and the
 * comparison target comes from DeploymentParams, which is produced by a
 * different path than the recorder that built the record.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  decodeCip171Metadatum,
  parameterizeScript,
  computeScriptHash,
} from "../../dist/index.js";
import { requireDevnet } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { STORE_URL } from "../harness/yaci.mjs";

before(async () => {
  await requireDevnet();
});

test("the bootstrap's CIP-171 record recomputes to the deployed script hashes", async () => {
  const deployment: any = await bootstrapProtocol();
  const blueprint: any = loadStandardBlueprint();

  // 1. Read the record back OFF THE CHAIN, not from the object we built.
  const resp = await fetch(`${STORE_URL}/txs/${deployment.txHash}/metadata`);
  assert.equal(resp.status, 200, "the bootstrap tx must be indexed");
  const body: any = await resp.json();
  const entry = (Array.isArray(body) ? body : []).find(
    (m: any) => String(m.label) === "1984"
  );
  assert.ok(entry, `the bootstrap tx must carry label 1984 — got labels ${JSON.stringify(
    (Array.isArray(body) ? body : []).map((m: any) => m.label)
  )}`);

  // 2. Reassemble and decode.
  const chunks: Uint8Array[] = (
    Array.isArray(entry.value ?? entry.json_metadata)
      ? (entry.value ?? entry.json_metadata)
      : []
  ).map((c: any) =>
    Uint8Array.from(Buffer.from(String(c).replace(/^0x/, ""), "hex"))
  );
  assert.ok(chunks.length > 0, "the metadatum must be a non-empty array of byte chunks");
  const record = decodeCip171Metadatum(chunks);

  // 3. The compiler version is the ARTEFACT's, not this machine's. Aiken is
  //    machine-global here and the versions genuinely differ, so a record
  //    naming the local toolchain is a false provenance claim.
  assert.equal(
    record.compilerVersion,
    blueprint.preamble.compiler.version,
    "compilerVersion must come from the blueprint's preamble, not from `aiken --version`"
  );

  // 4. RECOMPUTE. Every raw script + its recorded params must produce a hash
  //    that the deployment actually uses.
  // Harvest EVERY 28-byte hex value in DeploymentParams, whatever the key.
  // An earlier version collected only `.scriptHash` and reported four false
  // failures: the deployment stores several of these as policy ids and as bare
  // strings, so a narrow collector accuses a correct record.
  const deployedHashes = new Set<string>();
  const collect = (o: any) => {
    if (typeof o === "string") {
      if (/^[0-9a-fA-F]{56}$/.test(o)) deployedHashes.add(o.toLowerCase());
      return;
    }
    if (!o || typeof o !== "object") return;
    for (const v of Object.values(o)) collect(v);
  };
  collect(deployment);

  const rawByHash = new Map<string, string>();
  for (const v of blueprint.validators ?? []) {
    if (v.compiledCode) rawByHash.set(computeScriptHash(v.compiledCode).toLowerCase(), v.compiledCode);
  }

  assert.ok(record.scripts.length > 0, "the record must describe at least one script");
  const unmatched: string[] = [];
  for (const s of record.scripts) {
    const raw = rawByHash.get(s.rawScriptHash.toLowerCase());
    assert.ok(raw, `record names raw script ${s.rawScriptHash}, absent from the blueprint`);
    const applied = parameterizeScript(
      raw,
      s.params.map((p: string) => Data.fromCBORHex(p))
    );
    if (!deployedHashes.has(applied.hash.toLowerCase())) {
      unmatched.push(`${s.rawScriptHash} -> ${applied.hash} (not among the deployed hashes)`);
    }
  }
  assert.deepEqual(
    unmatched,
    [],
    `every recorded script must recompute to a DEPLOYED hash. A record that does not is ` +
      `decoration: it would verify to a script nobody is running.\n${unmatched.join("\n")}`
  );

  console.error(
    `=== CIP-171 === ${record.scripts.length} scripts recomputed to deployed hashes; ` +
      `compiler ${record.compilerVersion}; env "${record.env ?? ""}"`
  );
});
