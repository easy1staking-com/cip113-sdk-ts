/**
 * alpha.4 -> alpha.5, MEASURED: what upstream moved, and what that costs.
 *
 * ⛔ THE CLAIM THIS FILE EXISTS TO STOP BEING A CLAIM. The 0.12.0 release note
 * says "every script hash changes; an alpha.4 instance needs full redeployment,
 * not an upgrade." That sentence is load-bearing — an operator who believes the
 * cheaper reading tries an in-place upgrade against a protocol whose every
 * downstream credential has moved — and until now it was asserted rather than
 * shown. Here it is a measurement, run against both shipped artefacts.
 *
 * Three things are measured, and they are three different facts:
 *
 *   1. THE ARTEFACT DELTA. 34 validators either side; 31 compile to
 *      byte-identical code. Only `protocol_params` moved, and its three
 *      handlers share one compiledCode because every handler of an Aiken
 *      `validator` block does. ⛔ If any OTHER validator differs, the pin's
 *      account of upstream is wrong and this is an escalation, not a rebase.
 *
 *   2. THE CASCADE. `protocol_params`'s hash IS the params-NFT policy id, and
 *      that policy is the root of the parameterisation graph. Both blueprints
 *      are driven through the SAME chain with the SAME fixed inputs — the live
 *      preview deployment's own seeds, nonce and `maxInlineDatumBytes` — so
 *      the only variable is the blueprint. Exactly four scripts may keep their
 *      hash; every other one must move.
 *
 *   3. THE DATUM LAYOUTS DID NOT MOVE. alpha.3 -> alpha.4 inserted a field
 *      MID-RECORD in `ProtocolParams` and a positional reader decoded the
 *      wrong credential without erroring (see `test/datum-layout.test.mjs`).
 *      That hazard does not recur here, and "does not recur" is worth a check
 *      rather than a sentence: the definitions are compared field by field.
 *
 * ⚠ WHAT THIS FILE IS NOT. It is not a check that the parameterisation chain is
 * CORRECT — both sides run through the same `createStandardScripts`, so a
 * defect in the chain moves both operands together. Correctness against a real
 * chain lives in `test/bootstrap-export.test.mjs`, which still pins the four
 * unmoved scripts to a live preview deployment. This file measures a DELTA
 * between two artefacts, which is exactly what a migration note asserts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createStandardScripts, UNFRACKING_DISABLED } from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const ALPHA4 = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
const ALPHA5 = load("blueprints/standard/v0.5.0-alpha.5/plutus.json");

/**
 * The live preview alpha.4 deployment — used HERE only as a source of fixed
 * INPUTS (seeds, nonce, security parameter). Its recorded hashes are the
 * second operand in `bootstrap-export.test.mjs`, not here.
 */
const REAL = load("deployments/preview/alpha4-7e8a631.json");
const PREVIEW_NONCE =
  "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

// ---------------------------------------------------------------------------
// 1 — the artefact delta
// ---------------------------------------------------------------------------

const codeByTitle = (bp) => new Map(bp.validators.map((v) => [v.title, v.compiledCode]));

test("the artefact delta: 34 validators either side, 31 byte-identical", () => {
  assert.equal(ALPHA4.preamble.version, "0.5.0-alpha.4");
  assert.equal(ALPHA5.preamble.version, "0.5.0-alpha.5");
  // Same compiler either side — otherwise a byte difference could be the
  // toolchain's rather than upstream's, and the whole delta means nothing.
  assert.deepEqual(ALPHA5.preamble.compiler, ALPHA4.preamble.compiler);
  assert.equal(ALPHA4.validators.length, 34);
  assert.equal(ALPHA5.validators.length, 34);

  const a4 = codeByTitle(ALPHA4);
  const a5 = codeByTitle(ALPHA5);
  assert.deepEqual([...a5.keys()].sort(), [...a4.keys()].sort(), "no title added or removed");

  const moved = [...a4.keys()].filter((t) => a4.get(t) !== a5.get(t)).sort();
  assert.deepEqual(
    moved,
    [
      "protocol_params.protocol_params.else",
      "protocol_params.protocol_params.mint",
      "protocol_params.protocol_params.spend",
    ],
    "ONLY protocol_params may differ — anything else means upstream moved something the pin " +
      "does not account for, and that is an escalation rather than a rebase"
  );
  assert.equal(34 - moved.length, 31, "31 byte-identical");

  // ⛔ ONE SCRIPT, THREE HANDLERS. If these three ever carried different code
  // the "one hash for policy AND address" invariant would be gone, and the
  // params-NFT policy id would stop being the params address's credential.
  assert.equal(new Set(moved.map((t) => a5.get(t))).size, 1);
});

test("the artefact delta is not vacuous: the two blueprints really are different files", () => {
  // ⛔ THE CONTROL. Every assertion above would pass, cheerfully, if this file
  // had been pointed at the same artefact twice — 34 = 34, no titles differ,
  // and `moved` would be empty rather than wrong only because the deepEqual
  // above names three titles. Checked explicitly so a copy-paste of the path
  // cannot turn this file green and silent.
  const sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
  assert.notEqual(sha(ALPHA4), sha(ALPHA5));
  const a4 = codeByTitle(ALPHA4);
  const a5 = codeByTitle(ALPHA5);
  assert.notEqual(
    a4.get("protocol_params.protocol_params.mint"),
    a5.get("protocol_params.protocol_params.mint")
  );
});

// ---------------------------------------------------------------------------
// 2 — the cascade
// ---------------------------------------------------------------------------

/**
 * The full parameterisation chain, for one blueprint, at FIXED inputs.
 *
 * ⚠ Written out rather than taken from `planBootstrap`, because planBootstrap
 * refuses an alpha.4 blueprint outright: `validateStandardBlueprint` is a
 * version-EQUALITY gate. That refusal is the feature; it is also why this
 * measurement has to reach one level lower.
 */
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
  // ⚠ `issuance_mint` is parameterised per MINTING LOGIC, so it needs one more
  // input than the rest. A fixed placeholder is enough: the question is whether
  // the OTHER parameter — the params policy — moved it, and it is the same
  // placeholder either side.
  const issuanceMint = b.issuanceMint("11".repeat(28), protocolParams.hash);

  return {
    alwaysFail,
    upgradeMultisig,
    issuanceCborHexMint,
    registry,
    protocolParams,
    programmableLogicBase,
    transfer,
    thirdParty,
    unfracking,
    programmableLogicGlobal,
    issuanceLogic,
    issuanceMint,
  };
}

/**
 * The four that hang off seeds and nonces, never off the params policy — and
 * so the four an alpha.5 deployment may legitimately share with an alpha.4 one.
 */
const KEEP = ["alwaysFail", "upgradeMultisig", "issuanceCborHexMint", "registry"];

/** Everything whose ancestry runs through `protocol_params`. */
const MOVE = [
  "protocolParams",
  "programmableLogicBase",
  "transfer",
  "thirdParty",
  "unfracking",
  "programmableLogicGlobal",
  "issuanceLogic",
  "issuanceMint",
];

test("THE CASCADE: for one fixed DeploymentParams, no params-derived hash survives the bump", () => {
  const a4 = derive(ALPHA4);
  const a5 = derive(ALPHA5);

  assert.deepEqual([...KEEP, ...MOVE].sort(), Object.keys(a4).sort(), "every script accounted for");

  for (const name of MOVE) {
    assert.match(a4[name].hash, /^[0-9a-f]{56}$/);
    assert.notEqual(
      a5[name].hash,
      a4[name].hash,
      `${name} kept its alpha.4 hash — the params policy is its ancestor, so it cannot`
    );
  }

  // ⛔ AND THE PARTITION IS EXACT IN BOTH DIRECTIONS. Asserting only that eight
  // moved would stay green if all twelve had — which is a different and much
  // larger change, and one that would mean the chain itself drifted rather than
  // upstream's one line.
  for (const name of KEEP) {
    assert.equal(
      a5[name].hash,
      a4[name].hash,
      `${name} moved, and nothing in its ancestry did — the chain itself has drifted`
    );
  }

  const moved = Object.keys(a4).filter((n) => a4[n].hash !== a5[n].hash);
  assert.equal(moved.length, 8, "eight of twelve move; four are rooted elsewhere");
});

test("THE CASCADE: the four survivors are survivors of THIS chain, not of a shared input", () => {
  // ⛔ THE CONTROL FOR THE `KEEP` HALF. Four hashes matching across two
  // blueprints proves nothing if those four were going to match whatever was
  // fed in. Perturbing an input they DO depend on must move them — otherwise
  // `derive` is not reaching them and the equality above is an artefact.
  const a5 = derive(ALPHA5);
  const b = createStandardScripts(ALPHA5);
  const otherNonce = "00".repeat(32);
  assert.notEqual(otherNonce, PREVIEW_NONCE);
  const movedAlwaysFail = b.alwaysFail(otherNonce);
  assert.notEqual(movedAlwaysFail.hash, a5.alwaysFail.hash, "always_fail must track its nonce");
  const movedCbor = b.issuanceCborHexMint(REAL.issuance.txInput, movedAlwaysFail.hash);
  assert.notEqual(
    movedCbor.hash,
    a5.issuanceCborHexMint.hash,
    "issuance_cbor_hex_mint must track always_fail"
  );
  assert.notEqual(
    b.registry(REAL.protocolParams.txInput, movedCbor.hash).hash,
    a5.registry.hash,
    "registry must track issuance_cbor_hex_mint"
  );
  assert.notEqual(
    b.upgradeMultisig(REAL.issuance.txInput).hash,
    a5.upgradeMultisig.hash,
    "upgrade_multisig must track its own seed"
  );
  // The dispatcher's sentinel is a real value, not an accidental empty string.
  assert.match(UNFRACKING_DISABLED, /^[0-9a-f]{56}$/);
});

// ---------------------------------------------------------------------------
// 3 — the datum layouts did not move
// ---------------------------------------------------------------------------

/** Field titles of a blueprint `definitions` entry, in declared order. */
function fieldsOf(bp, key) {
  const def = bp.definitions[key];
  assert.ok(def, `${bp.preamble.version} must define ${key}`);
  const ctors = def.anyOf ?? [];
  assert.equal(ctors.length, 1, `${key} must be a single-constructor record`);
  return (ctors[0].fields ?? []).map((f) => f.title ?? f.$ref);
}

test("the datum layouts are IDENTICAL across the bump — the alpha.3 -> alpha.4 hazard does not recur", () => {
  // alpha.3 -> alpha.4 inserted `issuance_logic_cred` at index 1 and displaced
  // `transfer_cred` to 2. Both are `Credential`, so a positional reader built
  // against the old shape decoded without error and named the wrong authority.
  // alpha.5 changes the TRANSACTION shape at genesis, not the datum — and that
  // is the difference between "rebuild your transactions" and "your stored
  // decoders are silently wrong".
  for (const key of ["programmable_logic/params/ProtocolParams", "registry_node/RegistryNode"]) {
    assert.deepEqual(
      fieldsOf(ALPHA5, key),
      fieldsOf(ALPHA4, key),
      `${key} moved between alpha.4 and alpha.5 — a positional reader is now wrong`
    );
  }

  // Spelled out, so the check above cannot pass by comparing two empty lists.
  assert.deepEqual(fieldsOf(ALPHA5, "programmable_logic/params/ProtocolParams"), [
    "programmable_logic_global_cred",
    "issuance_logic_cred",
    "transfer_cred",
    "third_party_cred",
    "upgrade_cred",
    "pending_upgrade_cred",
  ]);
  assert.equal(fieldsOf(ALPHA5, "registry_node/RegistryNode").length, 7);
});
