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
import { computeScriptHash } from "../dist/index.js";
import { createFESScripts, freezeAndSeizeSubstandard } from "../dist/substandards/freeze-and-seize/index.js";

const BP = JSON.parse(
  readFileSync(new URL("../blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json", import.meta.url), "utf8")
);
const H28 = "ab".repeat(28);

function driveRegisterPath(onParameterize) {
  const fes = createFESScripts(BP, onParameterize);
  fes.buildIssuerAdmin(H28, "4142");
  const bm = fes.buildBlacklistMint({ txHash: "cd".repeat(32), outputIndex: 0 }, H28);
  fes.buildTransfer("ef".repeat(28), bm.hash);
  fes.buildBlacklistSpend(bm.hash);
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
