/**
 * 0.5.0-alpha.5 -> 0.0.1: A RELABEL, MEASURED.
 *
 * ⛔ THE CLAIM THIS FILE EXISTS TO STOP BEING A CLAIM. Upstream cut its first
 * mainnet release candidate, `v0.0.1`, and says it is byte-identical to
 * `0.5.0-alpha.5`. The SDK release that follows rests entirely on that being
 * true: if it is, an operator's alpha.5 deployment keeps every credential and
 * needs nothing; if it is not, this is a protocol change wearing a version
 * number, and the migration note is a lie.
 *
 * ⚠ THIS IS THE EXACT INVERSE OF `hash-cascade.test.mjs`. That file asserts
 * that eight of twelve derived hashes MOVED across alpha.4 -> alpha.5. This one
 * asserts that NONE of them move across alpha.5 -> 0.0.1. Same derivation, same
 * fixed inputs, opposite expectation — and the two together are what let the
 * release notes say "redeploy" for one bump and "do nothing" for the other.
 *
 * ⛔ THE ONE DIFFERENCE THAT IS EXPECTED. `preamble.version` changes, and it is
 * the reason the two files are not identical on disk. That is asserted
 * POSITIVELY rather than tolerated: a test that merely ignored the version
 * field would also pass if upstream had changed nothing at all and the pin had
 * been vendored from the wrong tag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createStandardScripts } from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const ALPHA5 = load("blueprints/standard/v0.5.0-alpha.5/plutus.json");
const V001 = load("blueprints/standard/v0.0.1/plutus.json");
const REAL = load("deployments/preview/alpha4-7e8a631.json");
const PREVIEW_NONCE =
  "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

const codeByTitle = (bp) => new Map(bp.validators.map((v) => [v.title, v.compiledCode]));

test("the artefact delta: all 34 validators are BYTE-IDENTICAL", () => {
  assert.equal(ALPHA5.preamble.version, "0.5.0-alpha.5");
  assert.equal(V001.preamble.version, "0.0.1");
  // Same compiler, or a byte-identity claim would be about the toolchain
  // rather than about upstream's source.
  assert.deepEqual(V001.preamble.compiler, ALPHA5.preamble.compiler);
  assert.equal(ALPHA5.validators.length, 34);
  assert.equal(V001.validators.length, 34);

  const a5 = codeByTitle(ALPHA5);
  const v1 = codeByTitle(V001);
  assert.deepEqual([...v1.keys()].sort(), [...a5.keys()].sort(), "no title added or removed");

  const moved = [...a5.keys()].filter((t) => a5.get(t) !== v1.get(t)).sort();
  assert.deepEqual(
    moved,
    [],
    "NOTHING may differ. A non-empty list here means 0.0.1 is not a relabel, the release " +
      "note is wrong, and this is an escalation rather than a version bump"
  );
});

test("everything OUTSIDE compiledCode is identical too, except the version string", () => {
  // ⛔ A blueprint can change without any compiledCode changing: a redeemer's
  // declared type, a datum's field order, a validator's parameter list. Those
  // live in `definitions` and in the validators' metadata, and a relabel must
  // move none of them.
  assert.equal(
    JSON.stringify(V001.definitions, Object.keys(V001.definitions ?? {}).sort()),
    JSON.stringify(ALPHA5.definitions, Object.keys(ALPHA5.definitions ?? {}).sort()),
    "definitions must be identical — a datum or redeemer shape change is not a relabel"
  );
  const meta = (bp) =>
    bp.validators
      .map((v) => JSON.stringify({ ...v, compiledCode: undefined }))
      .sort()
      .join("\n");
  assert.equal(meta(V001), meta(ALPHA5), "validator metadata must be identical");

  // The ONE expected difference, asserted positively.
  const withoutVersion = (bp) => {
    const c = JSON.parse(JSON.stringify(bp));
    delete c.preamble.version;
    return createHash("sha256").update(JSON.stringify(c)).digest("hex");
  };
  assert.equal(
    withoutVersion(V001),
    withoutVersion(ALPHA5),
    "with the version string removed the two artefacts must hash the same"
  );
  assert.notEqual(
    createHash("sha256").update(JSON.stringify(V001)).digest("hex"),
    createHash("sha256").update(JSON.stringify(ALPHA5)).digest("hex"),
    "and WITH it they must differ — otherwise the 0.0.1 directory was vendored from the " +
      "wrong tag and every assertion above is comparing a file to itself"
  );
});

/** Both blueprints through the same chain at the same fixed inputs. */
function derive(blueprint) {
  const b = createStandardScripts(blueprint);
  const seeds = {
    protocolParams: REAL.protocolParams.txInput,
    issuance: REAL.issuance.txInput,
    upgradeMultisig: REAL.upgradeMultisig.txInput,
  };
  const max = BigInt(REAL.maxInlineDatumBytes);
  const alwaysFail = b.alwaysFail(PREVIEW_NONCE);
  const upgradeMultisig = b.upgradeMultisig(seeds.upgradeMultisig);
  const protocolParams = b.protocolParams(seeds.protocolParams);
  const programmableLogicBase = b.programmableLogicBase(protocolParams.hash);
  const issuanceCborHexMint = b.issuanceCborHexMint(seeds.issuance, alwaysFail.hash);
  const registry = b.registry(seeds.protocolParams, issuanceCborHexMint.hash);
  const transfer = b.transfer(programmableLogicBase.hash, registry.hash, max);
  const thirdParty = b.thirdParty(programmableLogicBase.hash, registry.hash, max);
  const unfracking = b.unfracking(programmableLogicBase.hash, registry.hash, max);
  const programmableLogicGlobal = b.programmableLogicGlobal(
    transfer.hash,
    thirdParty.hash,
    unfracking.hash
  );
  const issuanceLogic = b.issuanceLogic(
    programmableLogicBase.hash,
    registry.hash,
    protocolParams.hash,
    max
  );
  const issuanceMint = b.issuanceMint("11".repeat(28), protocolParams.hash);
  return {
    alwaysFail: alwaysFail.hash,
    upgradeMultisig: upgradeMultisig.hash,
    protocolParams: protocolParams.hash,
    programmableLogicBase: programmableLogicBase.hash,
    issuanceCborHexMint: issuanceCborHexMint.hash,
    registry: registry.hash,
    transfer: transfer.hash,
    thirdParty: thirdParty.hash,
    unfracking: unfracking.hash,
    programmableLogicGlobal: programmableLogicGlobal.hash,
    issuanceLogic: issuanceLogic.hash,
    issuanceMint: issuanceMint.hash,
  };
}

test("⭐ THE RELEASE'S ONE ASSERTION: every derived hash is IDENTICAL across the relabel", () => {
  const a5 = derive(ALPHA5);
  const v1 = derive(V001);
  assert.deepEqual(
    v1,
    a5,
    "an alpha.5 deployment must keep EVERY credential under 0.0.1 — if any hash differs, " +
      "the release note's 'no redeployment needed' is false"
  );
  // Twelve, named, so a `derive` that silently stopped returning some of them
  // could not make this pass by comparing two short objects.
  assert.equal(Object.keys(v1).length, 12);
});

test("the derivation is not vacuous: perturbing one input moves the hashes it should", () => {
  // ⛔ THE CONTROL. `deepEqual` on two identical objects is exactly what a
  // `derive` that ignored its blueprint would also produce. Feed the SAME
  // blueprint a different seed and the params-derived half must move, which
  // proves the function is reading its inputs at all.
  const base = derive(V001);
  const b = createStandardScripts(V001);
  const moved = b.protocolParams({
    ...REAL.protocolParams.txInput,
    outputIndex: REAL.protocolParams.txInput.outputIndex + 1,
  });
  assert.notEqual(moved.hash, base.protocolParams, "a different seed must move protocol_params");
  assert.notEqual(
    b.programmableLogicBase(moved.hash).hash,
    base.programmableLogicBase,
    "and it must cascade into programmable_logic_base"
  );
  // ...while the scripts that do NOT hang off the params policy stay put.
  assert.equal(b.alwaysFail(PREVIEW_NONCE).hash, base.alwaysFail);
});
