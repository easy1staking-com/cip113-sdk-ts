/**
 * The provenance gate must REFUSE a pin that does not describe the blueprint.
 *
 * ⚠ WHY THIS IS THE TEST THAT MATTERS. A drifted pin does not produce an error
 * downstream — it produces a record that is well-formed, encodes cleanly, and
 * VERIFIES against the wrong source. Nothing after this point can detect it:
 * not the encoder, not the registry, not a consumer. The refusal here is the
 * only place the mistake is visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { provenanceFromPin, buildCip171RecordFromPin } from "../dist/index.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const FES_BP  = read("../blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json");
const FES_PIN = read("../blueprints/substandards/freeze-and-seize/v0.1.0/UPSTREAM_PIN.json");
const DUM_BP  = read("../blueprints/substandards/dummy/v0.2.0/plutus.json");
const DUM_PIN = read("../blueprints/substandards/dummy/v0.2.0/UPSTREAM_PIN.json");
const OLD_PIN = read("../blueprints/standard/v0.3.0/UPSTREAM_PIN.json");

test("provenance: a matching blueprint and pin yield the artefact's OWN compiler", () => {
  const p = provenanceFromPin(FES_BP, FES_PIN);
  assert.equal(p.compilerVersion, FES_BP.preamble.compiler.version);
  assert.equal(p.compilerVersion, "v1.1.21+42babe5");
  assert.match(p.commitHash, /^[0-9a-f]{40}$/, "a full sha, never an abbreviation");
  assert.equal(p.sourcePath, "src/substandards/freeze-and-seize");
  // env is a POSITIVE claim: "" means built without --env, not "unrecorded".
  assert.equal(p.env, "");
});

test("provenance: REFUSES the wrong pin for a blueprint — the silent-drift case", () => {
  assert.throws(
    () => provenanceFromPin(FES_BP, DUM_PIN),
    (e) => {
      assert.match(e.message, /drifted|does not match/i);
      return true;
    },
    "a pin describing a different artefact must never yield a record: it would " +
      "encode, verify, and describe the wrong source"
  );
  // ...and the converse, so the test cannot pass by the gate being one-sided.
  assert.throws(() => provenanceFromPin(DUM_BP, FES_PIN), /drifted|does not match/i);
});

test("provenance: REFUSES a blueprint whose provenance is not VERIFIED", () => {
  assert.throws(
    () => provenanceFromPin(FES_BP, OLD_PIN),
    (e) => {
      assert.match(e.message, /UNVERIFIED/);
      assert.match(e.message, /cannot be deleted|permanent, public claim/);
      return true;
    }
  );
});

test("provenance: REFUSES an abbreviated or absent commit", () => {
  const short = { ...FES_PIN, upstream: { ...FES_PIN.upstream, commit: "12637c7" } };
  assert.throws(() => provenanceFromPin(FES_BP, short), /40-character|abbreviation/i);
  const none = { ...FES_PIN, upstream: { ...FES_PIN.upstream, commit: null } };
  assert.throws(() => provenanceFromPin(FES_BP, none), /40-character|names nothing/i);
});

test("provenance: params are bytestring-wrapped, never inline PlutusData", async () => {
  const { Data } = await import("@evolution-sdk/evolution");
  const { computeScriptHash } = await import("../dist/index.js");
  // A REAL script from the blueprint — the content gate refuses anything else,
  // which it did to this test's original placeholder.
  const real = computeScriptHash(FES_BP.validators.find((v) => v.compiledCode).compiledCode);
  const rec = buildCip171RecordFromPin(FES_BP, FES_PIN, [
    { rawScriptHash: real, params: [Data.bytearray("cafe"), Data.int(7n)] },
  ]);
  assert.equal(rec.scripts.length, 1);
  for (const p of rec.scripts[0].params) {
    assert.equal(typeof p, "string", "each parameter must be a hex STRING (CBOR bytes)");
    assert.match(p, /^[0-9a-f]+$/i);
  }
  // Inline PlutusData is not REJECTED by the registry — it reads `.bytes`, gets
  // nothing, and stores a record whose parameters silently vanished. So the
  // type is the guard, and this asserts it.
  assert.equal(rec.compilerType, 0, "constructor 0 = Aiken");
});

test("provenance: REFUSES a script that is not in the blueprint the pin describes", () => {
  // The identity checks pass (right blueprint, right pin) — this is the case
  // they cannot catch: a script parameterised from some OTHER artefact. A
  // record naming this commit alongside that hash would verify against source
  // that never produced it.
  assert.throws(
    () => buildCip171RecordFromPin(FES_BP, FES_PIN, [{ rawScriptHash: "ab".repeat(28), params: [] }]),
    (e) => {
      assert.match(e.message, /NOT in the blueprint/i);
      assert.match(e.message, /different artefact|never produced/i);
      return true;
    }
  );
});

test("provenance: ADMITS a script that IS in the blueprint — the gate is not blanket", async () => {
  const { computeScriptHash } = await import("../dist/index.js");
  const real = computeScriptHash(FES_BP.validators.find((v) => v.compiledCode).compiledCode);
  const rec = buildCip171RecordFromPin(FES_BP, FES_PIN, [{ rawScriptHash: real, params: [] }]);
  assert.equal(rec.scripts.length, 1);
  assert.equal(rec.scripts[0].rawScriptHash.toLowerCase(), real.toLowerCase());
});
