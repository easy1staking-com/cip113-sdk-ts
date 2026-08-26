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
import { CIP113 } from "../../dist/index.js";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";
import { loadStandardBlueprint } from "../harness/bootstrap.js";
import { registerSubstandardCredentials } from "../harness/substandard-setup.js";
import { dummyBlueprintDir } from "../harness/paths.js";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";
import { fesBlueprintDir } from "../harness/paths.js";

before(async () => {
  await requireDevnet();
});

test("freeze-and-seize: its REGISTRATION tx carries a CIP-171 record that recomputes", async () => {
  const deployment: any = await bootstrapProtocol();
  const client: any = await makeClient();
  const address = EvoAddress.toBech32(await client.address());
  // ⚠ DERIVED FROM THE BOOTSTRAP, NOT CONSTANT. `issuer_admin` is parameterised
  // by (adminPkh, assetName) — both fixed if the name is a literal — so its
  // stake credential would be IDENTICAL on every run and the second run dies
  // with 3145, "trying to re-register some already known credentials". The
  // devnet keeps its chain between runs; only the bootstrap is fresh.
  const assetName = Buffer.from("FESPROV").toString("hex") + deployment.txHash.slice(0, 6);
  const plb = deployment.programmableLogicBase.scriptHash;

  const fes: any = await makeFesFixture(client, address, assetName, plb);
  await settleWallet(client, await client.address());

  assert.ok(
    fes.paramEvents.length > 0,
    "the fixture must record FES's parameterisations — an empty manifest would " +
      "produce an empty record that still encodes and still publishes"
  );

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      freezeAndSeizeSubstandard({ blueprint: fes.blueprint, deployment: fes.deployment }),
    ],
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });

  const init = await protocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address,
    adminAddress: address,
    assetName,
  });
  await init._signBuilder.signAndSubmit();
  await settleWallet(client, await client.address());
  await registerSubstandardCredentials(fes.withdrawScripts.slice(1));

  // The record is DERIVED from FES's own parameterisations, and refuses a
  // blueprint whose provenance is not VERIFIED.
  const record: any = buildDeploymentRecord(fesBlueprintDir(), fes.paramEvents);

  // ⚑ ATTACHED TO THE REGISTRATION TRANSACTION — the one that parameterises
  // the token's scripts. A standalone record is equally valid to a verifier,
  // but it must be REMEMBERED to be published; this cannot be forgotten,
  // because it rides the transaction that creates what it describes.
  const reg = await protocol.register("freeze-and-seize", {
    feePayerAddress: address,
    assetName,
    quantity: 1_000n,
    cip171Record: record,
  });
  await reg._signBuilder.signAndSubmit();
  const txHash = reg.txHash;
  // The registration tx is the SECOND of a chain — it spends UTxOs initCompliance
  // produced. Metadata is not free here: anything that grows it eats room the
  // chain has already committed to. Measured, not assumed.
  console.error(
    `=== CIP-171 FES REGISTRATION TX === ${(reg.cbor.length / 2)} bytes unsigned (cap 16384)`
  );
  await settleWallet(client, await client.address());

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

/**
 * Dummy's guard, fired ON PURPOSE.
 *
 * `dummy/v0.2.0` is pinned UNVERIFIED: its source commit is not reachable
 * upstream, so no verifier could reproduce the artefact. The record builder
 * must REFUSE it rather than emit a claim nobody can check — a metadatum,
 * unlike a file, cannot be deleted.
 *
 * This guard has never fired in anger. Watching it fire deliberately is the
 * difference between "it is in place" and "it works".
 */
test("dummy: the record builder REFUSES an UNVERIFIED blueprint", async () => {
  const deployment: any = await bootstrapProtocol();
  const client: any = await makeClient();
  const address = EvoAddress.toBech32(await client.address());
  const plb = deployment.programmableLogicBase.scriptHash;

  // Reuse FES's fixture purely to obtain a non-empty parameterisation manifest;
  // the refusal must depend on the BLUEPRINT's provenance, not on the events.
  const fes: any = await makeFesFixture(
    client,
    address,
    Buffer.from("DUMMYGUARD").toString("hex") + deployment.txHash.slice(0, 6),
    plb
  );
  assert.ok(fes.paramEvents.length > 0, "need a non-empty manifest to prove the refusal is about provenance");

  assert.throws(
    () => buildDeploymentRecord(dummyBlueprintDir(), fes.paramEvents),
    (e: Error) => {
      assert.match(e.message, /UNVERIFIED/, "the refusal must name the provenance state");
      assert.match(
        e.message,
        /cannot be deleted|permanent public claim/,
        "and must say WHY — a wrong metadatum is not retractable"
      );
      return true;
    },
    "a non-VERIFIED blueprint must never yield a CIP-171 record"
  );
});
