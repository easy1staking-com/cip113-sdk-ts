/**
 * The FES recorder must yield a COMPLETE manifest, not merely a non-empty one.
 *
 * ⚠ WHY COMPLETENESS IS THE PROPERTY. A partial manifest does not fail: a
 * record built from a subset encodes cleanly, publishes, and comes back
 * VERIFIED, while the omitted scripts have had their parameters silently never
 * stated. The registry marks those PARTIAL with a null final hash INSIDE a
 * verified record, so nothing upstream errors and nothing downstream notices.
 *
 * This repo has already shipped that mistake once at 3-of-4. A consumer driving
 * one parameterisation by hand would ship it at 1-of-4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeScriptHash, parameterizeScript } from "../dist/index.js";
import { createFESScripts, freezeAndSeizeSubstandard } from "../dist/substandards/freeze-and-seize/index.js";

const BP = JSON.parse(
  readFileSync(new URL("../blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json", import.meta.url), "utf8")
);
const H28 = "ab".repeat(28);

/** Returns the built scripts in CALL order, so events can be paired with them. */
function driveRegisterPath(onParameterize) {
  const fes = createFESScripts(BP, onParameterize);
  const admin = fes.buildIssuerAdmin(H28, "4142");
  const bm = fes.buildBlacklistMint({ txHash: "cd".repeat(32), outputIndex: 0 }, H28);
  const transfer = fes.buildTransfer("ef".repeat(28), bm.hash);
  const bs = fes.buildBlacklistSpend(bm.hash);
  return [admin, bm, transfer, bs];
}

test("FES recorder: captures EVERY distinct script in the blueprint, not a subset", () => {
  const events = [];
  driveRegisterPath((e) => events.push(e));

  const recorded = new Set(events.map((e) => e.rawScriptHash.toLowerCase()));
  const inBlueprint = new Set(
    (BP.validators ?? []).filter((v) => v.compiledCode).map((v) => computeScriptHash(v.compiledCode).toLowerCase())
  );

  // Pinned deliberately. A structural absence and a forgotten entry both look
  // like "one fewer than the blueprint holds", so the number is a decision a
  // human makes, not one a test infers.
  assert.equal(inBlueprint.size, 4, "FES's blueprint holds 4 distinct scripts");
  assert.equal(
    recorded.size,
    4,
    "the recorder must capture all 4. A subset yields a record that verifies " +
      "while the omitted scripts' parameters were never stated."
  );
  assert.deepEqual(
    [...recorded].filter((h) => !inBlueprint.has(h)),
    [],
    "every recorded script must belong to the blueprint the pin describes"
  );
});

test("FES recorder: reports application-order params and the UNAPPLIED hash", () => {
  const events = [];
  driveRegisterPath((e) => events.push(e));
  const admin = events.find((e) => e.title.startsWith("example_transfer_logic"));
  assert.ok(admin, "issuer_admin is parameterised");
  assert.match(admin.rawScriptHash, /^[0-9a-f]{56}$/i, "28-byte UNAPPLIED hash");
  assert.ok(admin.params.length > 0, "its arguments, in application order");
});

test("FES plugin: accepts an onParameterize and does not require it", () => {
  const deployment = { adminPkh: H28, assetName: "4142", blacklistNodePolicyId: H28,
    blacklistInitTxInput: { txHash: "cd".repeat(32), outputIndex: 0 } };
  // Both shapes must construct: the recorder is OPTIONAL, so adding it cannot
  // break a caller that never passes one.
  assert.ok(freezeAndSeizeSubstandard({ blueprint: BP, deployment }));
  assert.ok(freezeAndSeizeSubstandard({ blueprint: BP, deployment, onParameterize: () => {} }));
});

test("FES recorder: fires per parameterisation, so a second pass appends", () => {
  // Documented contract, asserted so it cannot drift into a surprise. A
  // consumer that pins its expected count against the RAW EVENT COUNT will
  // refuse a correct record the second time the plugin initialises — and the
  // failure reads as a coverage bug rather than a lifecycle one.
  const events = [];
  driveRegisterPath((e) => events.push(e));
  driveRegisterPath((e) => events.push(e));
  assert.equal(events.length, 8, "append-only: one event per parameterisation");
  assert.equal(
    new Set(events.map((e) => e.rawScriptHash.toLowerCase())).size,
    4,
    "still 4 DISTINCT scripts — dedupe by rawScriptHash before counting"
  );
});

// ---------------------------------------------------------------------------
// appliedScriptHash — the second operand
// ---------------------------------------------------------------------------

/**
 * ⚠ WHAT THESE PROVE, AND WHAT THEY CANNOT.
 *
 * `appliedScriptHash` exists so that a consumer's recomputation has something
 * to compare AGAINST. Nothing offline can supply that something: any hash this
 * suite produces comes from this package, so a comparison here is a comparison
 * of the package to itself. These tests therefore make the narrower claims
 * that are actually falsifiable — that the field is wired to the applied
 * script rather than the raw one, and that it is paired with the RIGHT call.
 *
 * The real check is the one `docs/provenance.md` describes and only a consumer
 * can run: this hash against a hash obtained from the deployment or the chain.
 */

test("recorder: appliedScriptHash is the caller-visible hash of the SAME call", () => {
  const events = [];
  const built = driveRegisterPath((e) => events.push(e));

  assert.equal(events.length, built.length, "one event per parameterisation");
  // Pairing by INDEX, not by title: an off-by-one — the commonest way a
  // recorder placed next to the work goes wrong — survives a title lookup.
  for (const [i, e] of events.entries()) {
    assert.equal(
      e.appliedScriptHash,
      built[i].hash,
      `event ${i} (${e.title}) must carry the hash of the script that call returned`
    );
  }
});

test("recorder: appliedScriptHash is NOT the unapplied hash", () => {
  const events = [];
  driveRegisterPath((e) => events.push(e));

  // The failure this catches is a copy-paste: `appliedScriptHash:
  // computeScriptHash(code)`. It typechecks, it is a valid 28-byte hash, and
  // it makes every consumer's recomputation compare raw against raw — which
  // passes, and means nothing. All four FES scripts take parameters, so all
  // four must move.
  for (const e of events) {
    assert.match(e.appliedScriptHash, /^[0-9a-f]{56}$/i, `${e.title}: 28-byte hash`);
    assert.notEqual(
      e.appliedScriptHash.toLowerCase(),
      e.rawScriptHash.toLowerCase(),
      `${e.title}: applying parameters must change the hash`
    );
  }
});

test("recorder: recomputing from rawScriptHash + params reproduces appliedScriptHash", () => {
  const events = [];
  driveRegisterPath((e) => events.push(e));

  const byRaw = new Map(
    (BP.validators ?? [])
      .filter((v) => v.compiledCode)
      .map((v) => [computeScriptHash(v.compiledCode).toLowerCase(), v.compiledCode])
  );

  for (const e of events) {
    const code = byRaw.get(e.rawScriptHash.toLowerCase());
    assert.ok(code, `${e.title}: rawScriptHash must resolve inside the blueprint`);
    // Not independent — same applyParamsToScript both sides. What it does
    // catch is a recorder that reports a params list OTHER than the one it
    // applied, which is the one way these two fields can drift apart.
    assert.equal(
      parameterizeScript(code, e.params).hash,
      e.appliedScriptHash,
      `${e.title}: the recorded params must be the params that were applied`
    );
  }
});
