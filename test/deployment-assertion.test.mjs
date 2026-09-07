/**
 * The fail-first for the contract upgrade (milestone acceptance criterion #4).
 *
 * assertDeploymentScripts derives every parameterizable standard script hash
 * from the blueprint and checks it against DeploymentParams. It exists because
 * a parameter can change MEANING without changing arity or type — upstream once
 * changed protocol_params_mint's second parameter from `always_fail_hash` to
 * `coordination_addr_hash`, same ByteArray either way. TypeScript cannot see
 * that. Neither can `tsc`.
 *
 * alpha.3 supplies a sharper instance: `max_inline_datum_bytes` is an Int the
 * DEPLOYER CHOOSES, baked into all three delegates and recoverable from no
 * hash. The negative cases below are the proof the check has teeth — a wrong
 * value of the correct type, and two same-signature delegates swapped. Without
 * them a passing positive case proves only that nothing was checked.
 *
 * ⛔ AND ONE CHECK EXISTS BECAUSE THE LEDGER CANNOT DO IT. `programmable_logic_global`
 * is compiled against the three delegate hashes, and no script can read another
 * script's parameters — so nothing on chain verifies the dispatcher was built
 * for the delegates actually deployed. A stale dispatcher fails at withdrawal
 * time with an index error that names neither cause.
 *
 * TARGET: CIP-113 0.5.0-alpha.3 (upstream f14b359).
 *
 * The preprod deployment this repo used to assert against was a 0.3.x protocol
 * instance and is no longer REPRESENTABLE — programmable_logic_global does not
 * exist in 0.5.x, so there is no field to put its hash in. That fixture was not
 * "updated"; it described a different protocol. It is replaced by a derived
 * instance below, plus an explicit test that an old blueprint is DIAGNOSED
 * rather than silently half-resolved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDeploymentScripts,
  DeploymentMismatchError,
} from "../dist/standard/scripts.js";
import * as scriptsModule from "../dist/standard/scripts.js";
import { validateStandardBlueprint } from "../dist/standard/blueprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const blueprint = load("blueprints/standard/v0.5.0-alpha.3/plutus.json");

/** Arbitrary but fixed inputs — nothing here needs to be a real deployment. */
const PP_TX = { txHash: "aa".repeat(32), outputIndex: 0 };
const ISS_TX = { txHash: "cc".repeat(32), outputIndex: 1 };
const REG_TX = { txHash: "bb".repeat(32), outputIndex: 0 };
const ALWAYS_FAIL = "dd".repeat(28);
const SIGNER = "11".repeat(28);
const MAX_INLINE_DATUM_BYTES = 512;

/**
 * A self-consistent 0.5.0-alpha.3 deployment, derived from the blueprint.
 *
 * DERIVED, not observed: no protocol instance with these hashes has ever been
 * deployed. It is sufficient for these tests, which are about whether the
 * assertion MECHANISM works — not about any particular chain state.
 *
 * ⚑ Note what is NOT here any more: no nonce, and no separate registry-spend or
 * params-address hash. alpha.3 merged each pair into one validator whose single
 * hash is both the policy id and the address's payment credential.
 */
function deriveDeployment(bp) {
  const b = scriptsModule.createStandardScripts(bp);

  const paramsPolicy = b.protocolParams(PP_TX).hash;
  const plb = b.programmableLogicBase(paramsPolicy).hash;
  const issuanceCborHex = b.issuanceCborHexMint(ISS_TX, ALWAYS_FAIL).hash;
  // The registry no longer depends on the params chain at all — it can be built
  // straight after issuance_cbor_hex_mint.
  const registry = b.registry(REG_TX, issuanceCborHex).hash;

  const transfer = b.transfer(plb, registry, MAX_INLINE_DATUM_BYTES).hash;
  const thirdParty = b.thirdParty(plb, registry, MAX_INLINE_DATUM_BYTES).hash;
  const unfracking = b.unfracking(plb, registry, MAX_INLINE_DATUM_BYTES).hash;
  // Built LAST: it names the three delegates at compile time.
  const plg = b.programmableLogicGlobal(transfer, thirdParty, unfracking).hash;
  const upgradeMultisig = b.upgradeMultisig([SIGNER], 1).hash;

  const ref = (i) => ({ txHash: "ee".repeat(32), outputIndex: i });

  return {
    txHash: "ee".repeat(32),
    protocolParams: { txInput: PP_TX, policyId: paramsPolicy, utxo: ref(0) },
    programmableLogicBase: { scriptHash: plb },
    transfer: { scriptHash: transfer },
    thirdParty: { scriptHash: thirdParty },
    unfracking: { scriptHash: unfracking },
    programmableLogicGlobal: { scriptHash: plg },
    maxInlineDatumBytes: MAX_INLINE_DATUM_BYTES,
    upgradeMultisig: { scriptHash: upgradeMultisig },
    upgradeAuthority: { type: "key", hash: SIGNER },
    issuance: { txInput: ISS_TX, policyId: issuanceCborHex, alwaysFailScriptHash: ALWAYS_FAIL },
    registry: { txInput: REG_TX, issuanceScriptHash: issuanceCborHex, scriptHash: registry },
    programmableBaseRefInput: ref(1),
    programmableLogicGlobalRefInput: ref(2),
    transferRefInput: ref(3),
    thirdPartyRefInput: ref(4),
    unfrackingRefInput: ref(5),
  };
}

const DEPLOYMENT = deriveDeployment(blueprint);

/** Every check the assertion performs, so a silent shrink is caught. */
const EXPECTED_CHECKS = [
  "protocol_params (policy == address)",
  "programmable_logic_base",
  "transfer",
  "third_party",
  "unfracking",
  "programmable_logic_global (dispatcher coherence)",
  "issuance_cbor_hex_mint",
  "registry (policy == address)",
  "upgrade_multisig",
];

test("POSITIVE: every derivable 0.5.0-alpha.3 script is checked and reproduces", () => {
  const checks = assertDeploymentScripts(blueprint, DEPLOYMENT);
  assert.deepEqual(
    checks.map((c) => c.name).sort(),
    [...EXPECTED_CHECKS].sort(),
    "the set of asserted scripts changed — a check was added or silently dropped"
  );
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
});

test("NEGATIVE (fail-first): a wrong value of the CORRECT type is caught", () => {
  // alpha.3's version of the hazard, and it is sharper than alpha.2's.
  // `max_inline_datum_bytes` is an Int the DEPLOYER CHOOSES — it cannot be
  // derived from anything, cannot be recovered from any hash, and is baked into
  // all THREE delegates. A wrong value is a perfectly well-typed number that
  // silently produces three different scripts, and then a fourth: the
  // dispatcher named them.
  const wrong = structuredClone(DEPLOYMENT);
  wrong.maxInlineDatumBytes = MAX_INLINE_DATUM_BYTES + 1;

  assert.throws(
    () => assertDeploymentScripts(blueprint, wrong),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError, "should be a DeploymentMismatchError");
      const names = err.mismatches.map((m) => m.name).sort();
      assert.deepEqual(
        names,
        ["third_party", "transfer", "unfracking"],
        `off-by-one on a chosen Int must break all three delegates, got: ${names.join(", ")}`
      );
      return true;
    },
    "a same-type wrong value MUST be rejected — typecheck and build both accept it"
  );
});

test("NEGATIVE (fail-first): the three delegates are distinguished from each other", () => {
  // transfer, third_party and unfracking take the SAME parameter and differ
  // only in their compiled code. Swapping two would be invisible to arity or
  // type checking, and produces a protocol whose PLB dispatch is wired to the
  // wrong validator.
  const swapped = structuredClone(DEPLOYMENT);
  swapped.transfer.scriptHash = DEPLOYMENT.thirdParty.scriptHash;
  swapped.thirdParty.scriptHash = DEPLOYMENT.transfer.scriptHash;

  assert.throws(
    () => assertDeploymentScripts(blueprint, swapped),
    (err) => {
      const names = err.mismatches.map((m) => m.name).sort();
      // ⚑ THREE, not two. The dispatcher is derived FROM the delegate hashes,
      // so swapping two delegates also makes the deployment's recorded
      // dispatcher unreproducible. That third mismatch is the coherence check
      // upstream cannot enforce on chain doing its job.
      assert.deepEqual(
        names,
        ["programmable_logic_global (dispatcher coherence)", "third_party", "transfer"],
        `got: ${names.join(", ")}`
      );
      return true;
    },
    "swapping two same-signature delegates MUST be caught"
  );
});

test("NEGATIVE: a mismatched blueprint is rejected wholesale", () => {
  assert.throws(() =>
    assertDeploymentScripts(
      load("blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json"),
      DEPLOYMENT
    )
  );
});

// ---------------------------------------------------------------------------
// The retired protocol version must be DIAGNOSED, not merely rejected
// ---------------------------------------------------------------------------

test("a 0.3.x blueprint is diagnosed by protocol version, not as a corrupt file", () => {
  const old = load("blueprints/standard/v0.3.0/plutus.json");
  assert.throws(
    () => validateStandardBlueprint(old),
    (err) => {
      // Casing changed when the verdict moved from symbol-presence to the
      // preamble version (see blueprint-version-guard.test.mjs); the assertion
      // itself is unchanged — an older blueprint must still be named as older.
      assert.match(err.message, /EARLIER CIP-113 protocol version/);
      // ⚠ The named symbol MOVED with the target. Until S-4 this asserted
      // `programmable_logic_global`; alpha.3 REQUIRES that validator, so it is
      // no longer a retired-symbol hint. v0.3.0's retired symbols are now the
      // pre-merge registry and params pair.
      assert.match(err.message, /registry_mint|registry_spend|protocol_params_mint/,
        "must name what it found");
      assert.match(err.message, /merged/, "must say what replaced it");
      assert.match(err.message, /v0\.5\.0-alpha\.3/, "must name where to go");
      return true;
    },
    "loading old contracts must explain the version gap, not report a missing validator"
  );
});

test("the shipped 0.5.0-alpha.3 blueprint validates", () => {
  validateStandardBlueprint(blueprint);
});

// ---------------------------------------------------------------------------
// Where the assertion has value, and where it does not
// ---------------------------------------------------------------------------

test("VACUOUS at bootstrap: a fully self-derived deployment always passes", () => {
  // Not a feature — the LIMIT of the check, locked in so nobody mistakes a
  // green bootstrap self-check for verification.
  //
  // DEPLOYMENT is exactly this shape: every hash derived, then asserted against
  // itself. Both sides of every comparison share one origin, so it passes no
  // matter how wrong the parameterization is.
  const checks = assertDeploymentScripts(blueprint, deriveDeployment(blueprint));
  assert.equal(checks.length, EXPECTED_CHECKS.length);
  for (const c of checks) assert.equal(c.derived, c.deployed);
  // Passing here proves only self-consistency — never that the deployment is
  // correct against the protocol actually on chain.
});

test("VALUABLE on load: a stale deployment against a changed blueprint is caught", () => {
  // The real defect this exists for: a blueprint replaced in place while the
  // deployment stays put. This repo shipped exactly that — same v0.3.0
  // directory name, 4 of 8 validator hashes moved.
  const changed = structuredClone(blueprint);
  // registry_spend is gone in alpha.3 (merged into `registry`), so the donor
  // pair moved with it. The mechanism under test is unchanged.
  const v = changed.validators.find((x) => x.title === "registry.registry.mint");
  const donor = changed.validators.find((x) => x.title === "unfracking.unfracking.withdraw");
  assert.ok(v && donor, "fixture must contain registry and unfracking");

  // Substitute a DIFFERENT validator's program — the real-world defect being
  // modelled (a blueprint replaced in place under an unchanged directory name).
  //
  // ⚠ Do NOT go back to flipping the last byte of compiledCode. That was this
  // test's original mutation and it is UNSOUND: UPLC is flat-encoded and
  // padded to a byte boundary, so the trailing bits are often padding that the
  // decode -> apply-params -> re-encode round trip simply regenerates.
  // MEASURED on the alpha.2 artifact: flipping registry_spend's final byte
  // (…400801 -> …400800) leaves the parameterised hash BIT-IDENTICAL at
  // 95c6f275…1147c7, so the assertion had nothing to catch and the test passed
  // by throwing nothing. It only ever worked because v0.3.0's tail happened to
  // be significant. A mutation that depends on which byte the padding lands on
  // is a coin flip, not a proof.
  assert.notEqual(v.compiledCode, donor.compiledCode);
  v.compiledCode = donor.compiledCode;

  assert.throws(
    () => assertDeploymentScripts(changed, DEPLOYMENT),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError);
      assert.ok(
        err.mismatches.some((m) => m.name === "registry (policy == address)"),
        `expected registry to mismatch, got: ${err.mismatches.map((m) => m.name).join(", ")}`
      );
      return true;
    },
    "a deployment paired with a different blueprint MUST be rejected"
  );
});

// ---------------------------------------------------------------------------
// ⚑ The two dual-hash collapses — one value, two roles
// ---------------------------------------------------------------------------

test("registry and protocol_params each expose ONE hash, not a pair", () => {
  // alpha.3 merged registry_mint+registry_spend and protocol_params_mint+
  // protocol_params_spend. In each the NFT policy id and the address's payment
  // credential became the same value — the minting policy naming itself.
  //
  // ⛔ WHY THIS IS PINNED. The SDK used to derive those two independently and
  // BOTH derivations were correct. Re-introducing a second field is not a
  // rounding error: two derivations of one fact is two chances to disagree, and
  // the disagreement presents as a valid-looking address that holds nothing —
  // no error, no mismatch, just a UTxO nobody can find.
  const resolved = scriptsModule.buildDeploymentScripts(blueprint, DEPLOYMENT);

  assert.equal(
    resolved.registry.hash,
    DEPLOYMENT.registry.scriptHash,
    "the registry script's hash IS the recorded node policy",
  );
  assert.equal(
    resolved.protocolParams.hash,
    DEPLOYMENT.protocolParams.policyId,
    "the protocol_params script's hash IS the recorded params policy",
  );

  // And the resolved surface must not offer a second, separately-derived hash
  // for either — the shape of the old bug.
  for (const gone of ["registryMint", "registrySpend", "protocolParamsMint", "coordinationSpend"]) {
    assert.equal(
      resolved[gone],
      undefined,
      `${gone} is a pre-alpha.3 name; its return would re-open the split-derivation bug`,
    );
  }
});
