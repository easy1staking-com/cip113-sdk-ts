/**
 * FES registration's CIP-171 record — built, published and RECOMPUTED, devnet only.
 *
 * Published as a STANDALONE transaction rather than attached to the
 * registration tx. That is valid and is what the reference registry itself
 * emits: ingest filters on `label == 1984` alone and never sees the
 * transaction's scripts, so association is by SCRIPT HASH at lookup time. It
 * also avoids changing an SDK signature a consumer is mid-migration onto.
 *
 * ⚠ NOT DEPLOYED TO PREVIEW. FES's blueprint reports `v1.1.21+42babe5`, and the
 * reference backend's version check is full-string anchored, so ANY `+build`
 * suffix is refused. Emitting there today would reproduce a known, diagnosed
 * defect rather than test FES — and the record would sit FAILED beside core's.
 * The value is correct; the gap is theirs.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Data, Address as EvoAddress } from "@evolution-sdk/evolution";
import {
  decodeCip171Metadatum,
  parameterizeScript,
  computeScriptHash,
} from "../../dist/index.js";
import { requireDevnet, makeClient, settleWallet, STORE_URL } from "../harness/yaci.mjs";
import { bootstrapProtocol } from "../harness/bootstrap.js";
import { makeFesFixture } from "../harness/fes-setup.js";
import { buildDeploymentRecord } from "../harness/cip171-record.js";
import { publishCip171Record } from "../harness/publish-cip171.js";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";
import { fesBlueprintDir } from "../harness/paths.js";

before(async () => {
  await requireDevnet();
});

test("freeze-and-seize: its CIP-171 record publishes and recomputes to FES's own scripts", async () => {
  const deployment: any = await bootstrapProtocol();
  const client: any = await makeClient();
  const address = EvoAddress.toBech32(await client.address());
  const assetName = Buffer.from("FESPROV").toString("hex");
  const plb = deployment.programmableLogicBase.scriptHash;

  const fes: any = await makeFesFixture(client, address, assetName, plb);
  await settleWallet(client, await client.address());

  assert.ok(
    fes.paramEvents.length > 0,
    "the fixture must record FES's parameterisations — an empty manifest would " +
      "produce an empty record that still encodes and still publishes"
  );

  // The record is DERIVED from those calls, and refuses a blueprint whose
  // provenance is not VERIFIED.
  const record: any = buildDeploymentRecord(fesBlueprintDir(), fes.paramEvents);

  const txHash = await publishCip171Record(
    client,
    record,
    createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337")
  );

  // Read it back OFF THE CHAIN, not from the object we built.
  const resp = await fetch(`${STORE_URL}/txs/${txHash}/metadata`);
  assert.equal(resp.status, 200, "the record's tx must be indexed");
  const body: any = await resp.json();
  const entry = (Array.isArray(body) ? body : []).find((m: any) => String(m.label) === "1984");
  assert.ok(entry, "the published tx must carry label 1984");

  const chunks: Uint8Array[] = (
    Array.isArray(entry.value ?? entry.json_metadata) ? (entry.value ?? entry.json_metadata) : []
  ).map((c: any) => Uint8Array.from(Buffer.from(String(c).replace(/^0x/, ""), "hex")));
  const decoded = decodeCip171Metadatum(chunks);

  assert.equal(
    decoded.compilerVersion,
    fes.blueprint.preamble.compiler.version,
    "compilerVersion must be FES's OWN compiler, not core's and not the machine's"
  );

  // RECOMPUTE: each raw script + its recorded params must reproduce a hash FES
  // actually derived. "The record published" proves nothing about its contents.
  const fesHashes = new Set<string>(
    fes.paramEvents.map((e: any) => e.rawScriptHash.toLowerCase())
  );
  const rawByHash = new Map<string, string>();
  for (const v of fes.blueprint.validators ?? []) {
    if (v.compiledCode) rawByHash.set(computeScriptHash(v.compiledCode).toLowerCase(), v.compiledCode);
  }

  const derived = new Set<string>();
  for (const e of fes.paramEvents) derived.add(
    parameterizeScript(rawByHash.get(e.rawScriptHash.toLowerCase())!, e.params).hash.toLowerCase()
  );

  const unmatched: string[] = [];
  for (const s of decoded.scripts) {
    assert.ok(fesHashes.has(s.rawScriptHash.toLowerCase()), `unknown raw script ${s.rawScriptHash}`);
    const raw = rawByHash.get(s.rawScriptHash.toLowerCase())!;
    const applied = parameterizeScript(raw, s.params.map((p: string) => Data.fromCBORHex(p)));
    if (!derived.has(applied.hash.toLowerCase())) {
      unmatched.push(`${s.rawScriptHash} -> ${applied.hash}`);
    }
  }
  assert.deepEqual(unmatched, [], `every recorded FES script must recompute:\n${unmatched.join("\n")}`);

  console.error(
    `=== CIP-171 FES === tx ${txHash}; ${decoded.scripts.length} scripts recomputed; ` +
      `compiler ${decoded.compilerVersion}; env "${decoded.env ?? ""}"`
  );
});
