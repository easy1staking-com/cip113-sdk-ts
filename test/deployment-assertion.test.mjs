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
 * alpha.3 supplied a sharper instance: `max_inline_datum_bytes` is an Int the
 * DEPLOYER CHOOSES, baked into the delegates and recoverable from no hash.
 * alpha.4 adds a FOURTH consumer of it (`issuance_logic`) and a hazard of its
 * own: `issuance_logic` takes TWO ADJACENT PolicyId parameters,
 * `registry_node_cs` then `params_policy`, the same type, the same length, and
 * both `string` at the call site. The negative cases below are the proof the
 * check has teeth — a wrong value of the correct type, two same-signature
 * delegates swapped, two same-typed policies swapped, and a one-shot outref
 * taken from the wrong field. Without them a passing positive case proves only
 * that nothing was checked.
 *
 * ⛔ AND ONE CHECK EXISTS BECAUSE THE LEDGER CANNOT DO IT. `programmable_logic_global`
 * is compiled against the three delegate hashes, and no script can read another
 * script's parameters — so nothing on chain verifies the dispatcher was built
 * for the delegates actually deployed. A stale dispatcher fails at withdrawal
 * time with an index error that names neither cause.
 *
 * TARGET: CIP-113 0.5.0-alpha.4 (upstream d37ca8d).
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

const blueprint = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");

/** Arbitrary but fixed inputs — nothing here needs to be a real deployment. */
const PP_TX = { txHash: "aa".repeat(32), outputIndex: 0 };
const ISS_TX = { txHash: "cc".repeat(32), outputIndex: 1 };
const REG_TX = { txHash: "bb".repeat(32), outputIndex: 0 };
/**
 * ⛔ A FOURTH ONE-SHOT, DISTINCT FROM ALL THREE ABOVE, AND THE DISTINCTNESS IS
 * ITSELF UNDER TEST. alpha.4 parameterises `upgrade_multisig` by an outref
 * instead of by a signer set, so `DeploymentParams` now carries TWO same-typed
 * one-shot `TxInput`s — `protocolParams.txInput` and `upgradeMultisig.txInput`.
 * Nothing in the type system separates them.
 *
 * ⚠ THIS IS THE S-11 VACUITY TRAP IN A NEW SHAPE. That fixture used ONE value
 * for two fields, so a derivation reading the wrong one reproduced perfectly
 * and the check passed vacuously; only a live devnet exposed it. If `UM_TX`
 * ever equals `PP_TX`, every assertion below about `upgrade_multisig` silently
 * stops discriminating.
 */
const UM_TX = { txHash: "77".repeat(32), outputIndex: 3 };
const ALWAYS_FAIL = "dd".repeat(28);
/**
 * The upgrade authority named in the params datum, and NOTHING ELSE.
 *
 * ⚑ THE PAYMENT-VS-STAKE CONFLATION RETIRES WITH THE SIGNER PARAMETERS.
 * `upgrade_multisig` no longer takes a payment key hash at all, so there is no
 * second same-shaped key here for a derivation to reach for — which is why the
 * `PAYMENT_SIGNER` constant this file used to carry is gone. What survives is
 * the rule: `upgradeAuthority` is a deployment CHOICE unrelated to every other
 * field in the record, kept as a KEY credential so that any derivation reaching
 * for it stands out.
 */
const STAKE_AUTHORITY = "22".repeat(28);
const MAX_INLINE_DATUM_BYTES = 512;

/**
 * A self-consistent 0.5.0-alpha.4 deployment, derived from the blueprint.
 *
 * DERIVED, not observed: no protocol instance with these hashes has ever been
 * deployed. It is sufficient for these tests, which are about whether the
 * assertion MECHANISM works — not about any particular chain state.
 *
 * ⚑ Note what is NOT here any more: no nonce, and no separate registry-spend or
 * params-address hash. alpha.3 merged each pair into one validator whose single
 * hash is both the policy id and the address's payment credential.
 *
 * ⚑ And what is NEW in alpha.4: `issuanceLogic` (a fourth consumer of
 * `max_inline_datum_bytes`) and an `upgradeMultisig` derived from its OWN
 * one-shot outref rather than from a signer set.
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
  // ⚠ THE FOURTH consumer of MAX_INLINE_DATUM_BYTES, and the only one that also
  // takes params_policy. Argument order is (plb, registry_node_cs,
  // params_policy, max_inline) — the middle two are both bare PolicyIds.
  const issuanceLogic = b.issuanceLogic(plb, registry, paramsPolicy, MAX_INLINE_DATUM_BYTES).hash;
  // Built LAST: it names the three delegates at compile time.
  const plg = b.programmableLogicGlobal(transfer, thirdParty, unfracking).hash;
  // From its OWN one-shot — not PP_TX, and not derived from upgradeAuthority.
  const upgradeMultisig = b.upgradeMultisig(UM_TX).hash;

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
    upgradeMultisig: { scriptHash: upgradeMultisig, txInput: UM_TX, utxo: ref(6) },
    upgradeMultisigRefInput: ref(7),
    upgradeAuthority: { type: "key", hash: STAKE_AUTHORITY },
    issuanceLogic: { scriptHash: issuanceLogic },
    issuanceLogicRefInput: ref(8),
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

test("⛔ FIXTURE INTEGRITY: the two one-shot outrefs are DIFFERENT", () => {
  // TWO SAME-TYPED ONE-SHOT OUTREFS ARE TWO CHANCES FOR A VACUOUS CHECK.
  // `protocol_params` and `upgrade_multisig` are each parameterised by an
  // already-spent UTxO, of identical type and indistinguishable shape. A
  // fixture reusing one for both makes the `upgrade_multisig` assertion pass no
  // matter which field the derivation reads — which is exactly how the S-11
  // defect survived every offline slice until a devnet found it.
  assert.notDeepEqual(
    UM_TX,
    PP_TX,
    "if these are ever equal, the upgrade_multisig checks below stop discriminating",
  );
});

/** Every check the assertion performs, so a silent shrink is caught. */
const EXPECTED_CHECKS = [
  // ⚑ TEN in alpha.4, up from eight. `issuance_logic` is new; `upgrade_multisig`
  // COMES BACK, because it is now parameterised by a recordable `utxo_ref`
  // instead of by an unrecorded signer set. See the blocks beside both checks
  // in src/standard/scripts.ts.
  "protocol_params (policy == address)",
  "programmable_logic_base",
  "transfer",
  "third_party",
  "unfracking",
  "programmable_logic_global (dispatcher coherence)",
  "issuance_cbor_hex_mint",
  "registry (policy == address)",
  "issuance_logic",
  "upgrade_multisig",
];

test("POSITIVE: every derivable 0.5.0-alpha.4 script is checked and reproduces", () => {
  const checks = assertDeploymentScripts(blueprint, DEPLOYMENT);
  assert.deepEqual(
    checks.map((c) => c.name).sort(),
    [...EXPECTED_CHECKS].sort(),
    "the set of asserted scripts changed — a check was added or silently dropped"
  );
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
});

test("NEGATIVE (fail-first): a wrong value of the CORRECT type is caught", () => {
  // `max_inline_datum_bytes` is an Int the DEPLOYER CHOOSES — it cannot be
  // derived from anything and cannot be recovered from any hash. A wrong value
  // is a perfectly well-typed number that silently produces different scripts.
  //
  // ⚑ FOUR NAMES, NOT THREE, AND THE COUNT IS THE MECHANISM. alpha.4 adds
  // `issuance_logic` as a fourth consumer of this field. The fourth name IS the
  // proof that `issuance_logic` reads the same field the delegates do — a
  // comment cannot prove a call site exists, a count can. If this ever drops
  // back to three, the issuance_logic derivation stopped reading
  // `maxInlineDatumBytes` and nothing else would say so.
  //
  // ⚠ The dispatcher does NOT appear: it is parameterised by the delegate
  // hashes recorded in the deployment, which this mutation does not touch.
  const wrong = structuredClone(DEPLOYMENT);
  wrong.maxInlineDatumBytes = MAX_INLINE_DATUM_BYTES + 1;

  assert.throws(
    () => assertDeploymentScripts(blueprint, wrong),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError, "should be a DeploymentMismatchError");
      const names = err.mismatches.map((m) => m.name).sort();
      assert.deepEqual(
        names,
        ["issuance_logic", "third_party", "transfer", "unfracking"],
        `off-by-one on a chosen Int must break all FOUR consumers, got: ${names.join(", ")}`
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
      // ⚠ AND `issuance_logic` MUST NOT APPEAR. It is parameterised by
      // (plb, registry, params_policy, max_inline) — none of which is a
      // delegate hash — so a delegate swap cannot move it. Its presence here
      // would mean the derivation reads something it should not.
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
      // no longer a retired-symbol hint, and alpha.4 retires nothing further.
      // v0.3.0's retired symbols are the pre-merge registry and params pair.
      assert.match(err.message, /registry_mint|registry_spend|protocol_params_mint/,
        "must name what it found");
      assert.match(err.message, /merged/, "must say what replaced it");
      assert.match(err.message, /v0\.5\.0-alpha\.4/, "must name where to go");
      return true;
    },
    "loading old contracts must explain the version gap, not report a missing validator"
  );
});

test("the shipped 0.5.0-alpha.4 blueprint validates", () => {
  // ⚑ The §7f control for this file: the gate got STRICTER (the preamble
  // verdict now runs before the missing-title check), and a guard that refuses
  // everything is not a fixed guard. This must stay green.
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
  // registry_spend was merged into `registry` in alpha.3, so the donor pair
  // moved with it then and is unchanged in alpha.4. The mechanism under test is
  // unchanged.
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

test("⛔ THE RESOLVED SURFACE reproduces the deployment — every script, not just the checked ones", () => {
  // ⛔ THE DEFECT THIS EXISTS FOR, and it is S-11's shape at a different call
  // site. `assertDeploymentScripts` derived ten scripts and compared them to the
  // record. `buildDeploymentScripts` then derived the SAME ten AGAIN, from its
  // own argument expressions, and returned THOSE. Nothing compared the second
  // set to anything.
  //
  // ⚠ So a wrong argument at the RESOLUTION site was invisible: swapping
  // issuance_logic's two PolicyIds there, or reading protocolParams.txInput for
  // upgrade_multisig there, left the assertion green and the whole suite at
  // 151/151 — while the object CIP113.init hands to every substandard was the
  // wrong script. The assertion site was the one under test; the resolution
  // site was the one that builds transactions.
  //
  // ⇒ Two derivations of one fact are two chances to disagree, and only one of
  // them was guarded. This test guards the other one; the collapse in
  // scripts.ts is what makes them the same object rather than merely equal.
  const resolved = scriptsModule.buildDeploymentScripts(blueprint, DEPLOYMENT);

  const expected = [
    ["protocolParams", DEPLOYMENT.protocolParams.policyId],
    ["programmableLogicBase", DEPLOYMENT.programmableLogicBase.scriptHash],
    ["transfer", DEPLOYMENT.transfer.scriptHash],
    ["thirdParty", DEPLOYMENT.thirdParty.scriptHash],
    ["unfracking", DEPLOYMENT.unfracking.scriptHash],
    ["programmableLogicGlobal", DEPLOYMENT.programmableLogicGlobal.scriptHash],
    ["issuanceCborHexMint", DEPLOYMENT.issuance.policyId],
    ["registry", DEPLOYMENT.registry.scriptHash],
    ["issuanceLogic", DEPLOYMENT.issuanceLogic.scriptHash],
    ["upgradeMultisig", DEPLOYMENT.upgradeMultisig.scriptHash],
  ];

  // ⚑ TEN, asserted as a COUNT as well as by member. A list of "these must
  // match" only ever detects a changed hash; it stops noticing the NEWEST
  // member, which is the one least likely to be covered anywhere else.
  assert.equal(
    expected.length,
    EXPECTED_CHECKS.length,
    "every script the assertion checks must also be asserted on the resolved surface",
  );

  for (const [name, deployed] of expected) {
    assert.ok(resolved[name], `the resolved surface must expose ${name}`);
    assert.equal(
      resolved[name].hash,
      deployed,
      `resolved.${name} does not reproduce the deployment — the resolution site and the ` +
        `assertion site disagree, and only the assertion site is checked`,
    );
  }
});

test("NEGATIVE: the WRONG one-shot outref for upgrade_multisig is caught", () => {
  // ⛔ THE ALPHA.4 SUCCESSOR TO THE S-11 TEST, AND ITS HISTORY IS THE REASON IT
  // LOOKS LIKE THIS.
  //
  // S-4 added a check deriving `upgrade_multisig` from `upgradeAuthority.hash`.
  // That relationship never existed: `upgrade_multisig`'s signers were matched
  // against `extra_signatories` (a PAYMENT key hash) while `upgradeAuthority`
  // must appear in the withdrawals map (a STAKE credential). Same shape, same
  // length, different keys. ⚠ AND THE FIXTURE USED ONE VALUE FOR BOTH FIELDS,
  // so the wrong derivation reproduced perfectly and the check passed
  // vacuously through every offline slice. Only a live devnet exposed it, and
  // S-11 REMOVED the check rather than correcting it, because alpha.3 recorded
  // no signer set to derive from.
  //
  // alpha.4 parameterises the validator by a `utxo_ref` that IS recorded, so
  // the check returns — and the vacuity trap returns with it in a new shape:
  // `protocolParams.txInput` and `upgradeMultisig.txInput` are two same-typed
  // one-shot outrefs in one record. ONE-VALUE-FOR-TWO-FIELDS IS WHAT HID IT
  // LAST TIME. This test is the instrument that says the derivation reads the
  // right one.
  const wrong = structuredClone(DEPLOYMENT);
  wrong.upgradeMultisig.txInput = DEPLOYMENT.protocolParams.txInput;

  assert.throws(
    () => assertDeploymentScripts(blueprint, wrong),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError);
      const names = err.mismatches.map((m) => m.name).sort();
      assert.deepEqual(
        names,
        ["upgrade_multisig"],
        `exactly one check reads this field, got: ${names.join(", ")}`
      );
      return true;
    },
    "reading protocolParams.txInput where upgradeMultisig.txInput belongs MUST be caught"
  );

  // ⛔ AND THE ASSERTION ABOVE CANNOT, ON ITS OWN, TELL YOU WHICH FIELD THE CODE
  // READ. MEASURED: with the derivation mutated to read
  // `deployment.protocolParams.txInput`, this test STAYS GREEN — because the
  // mutated record sets the two fields EQUAL, so the mutant derives from
  // `PP_TX` while the record still holds a hash derived from `UM_TX`, and that
  // is still exactly one mismatch named `upgrade_multisig`. The count is right
  // for the wrong reason.
  //
  // ⇒ Same rule as `issuance_logic`'s two PolicyIds, and this is its second
  // occurrence in one slice: WHEN BOTH OPERANDS OF A COMPARISON COME FROM THE
  // SAME BUILDER, ASSERT THE APPLIED PARAMETER, NOT THE RESULTING HASH. The
  // recorder reports what was actually applied; `UM_TX.txHash` is a value fixed
  // outside the builder.
  // ⚠ AND IT TAKES TWO ASSERTIONS, NOT ONE, BECAUSE THERE ARE TWO PLACES THE
  // FIELD CAN BE READ WRONGLY — the BUILDER (does it apply the outref it was
  // handed?) and the SEAM (is it handed the right field of the record?). A
  // first draft asserted only the builder, by driving it with an explicit
  // UM_TX, and the derivation-site mutation walked straight past it: the
  // assertion never travelled through the code under test. Testing the
  // mechanism is not testing the wiring.
  const applied = [];
  const recording = scriptsModule.createStandardScripts(blueprint, (e) => applied.push(e));
  const fromUmTx = recording.upgradeMultisig(UM_TX);

  // (i) THE BUILDER — assert the APPLIED PARAMETER, by index, against a value
  // fixed outside the builder. Same rule as `issuance_logic`'s two PolicyIds,
  // and this is its second occurrence in one slice.
  assert.equal(applied.length, 1, "exactly one parameterisation should have been recorded");
  assert.equal(applied[0].title, "upgrade_multisig.upgrade_multisig.withdraw");
  const outRef = applied[0].params[0];
  assert.equal(
    Buffer.from(outRef.fields[0]).toString("hex"),
    UM_TX.txHash,
    "upgrade_multisig must be parameterised by the outref it was handed",
  );
  assert.equal(outRef.fields[1], BigInt(UM_TX.outputIndex), "and by its output index");

  // (ii) THE SEAM — assert that the DERIVATION reads `upgradeMultisig.txInput`
  // and not `protocolParams.txInput`. The check's own `derived` hash is what
  // the production path produced; both comparands here are parameterised by an
  // outref this test names explicitly, so the field selection is what is under
  // test rather than the builder.
  const derived = assertDeploymentScripts(blueprint, DEPLOYMENT).find(
    (c) => c.name === "upgrade_multisig",
  );
  assert.ok(derived, "the assertion must still perform an upgrade_multisig check");
  assert.equal(
    derived.derived,
    fromUmTx.hash,
    "the derivation must read upgradeMultisig.txInput — its OWN one-shot",
  );
  assert.notEqual(
    derived.derived,
    recording.upgradeMultisig(PP_TX).hash,
    "reading protocolParams.txInput here is the S-11 conflation in a new shape",
  );
});

test("NEGATIVE: issuance_logic's two ADJACENT PolicyIds are not interchangeable", () => {
  // `registry_node_cs` and `params_policy` sit side by side in
  // `issuance_logic`'s parameter list. Both are `cardano/assets/PolicyId` in
  // the blueprint, both are 28 bytes, and both are `string` here — NO TYPE CAN
  // TELL THEM APART. Swapping them produces a script that builds, hashes and
  // deploys, and the first thing that would notice is the ledger.
  const b = scriptsModule.createStandardScripts(blueprint);
  const plb = DEPLOYMENT.programmableLogicBase.scriptHash;
  const registry = DEPLOYMENT.registry.scriptHash;
  const params = DEPLOYMENT.protocolParams.policyId;

  assert.notEqual(registry, params, "the fixture must keep these distinct or it proves nothing");
  assert.notEqual(
    b.issuanceLogic(plb, registry, params, MAX_INLINE_DATUM_BYTES).hash,
    b.issuanceLogic(plb, params, registry, MAX_INLINE_DATUM_BYTES).hash,
    "swapping the two same-typed PolicyIds must change the hash — if it ever does not, " +
      "the builder is not applying them in blueprint order",
  );

  // ⛔ AND THE HASH COMPARISONS ABOVE ARE NOT ENOUGH ON THEIR OWN, MEASURED.
  // Every hash in this file — both operands of every comparison — is produced
  // by this same builder, so a mutation inside it moves both sides together and
  // survives. Substituting `registryPolicy` for `paramsPolicy` in the builder
  // was applied here and killed NOTHING: `DEPLOYMENT.issuanceLogic.scriptHash`
  // is derived by the mutant too, and the swapped pair still differs
  // ([reg, reg] vs [params, params]).
  //
  // ⇒ So assert BY INDEX against values fixed OUTSIDE the builder. The
  // parameterisation recorder reports what was actually applied, in application
  // order — an observation of the call, not a second derivation of its result.
  const applied = [];
  scriptsModule
    .createStandardScripts(blueprint, (e) => applied.push(e))
    .issuanceLogic(plb, registry, params, MAX_INLINE_DATUM_BYTES);

  assert.equal(applied.length, 1, "exactly one parameterisation should have been recorded");
  assert.equal(applied[0].title, "issuance_logic.issuance_logic.withdraw");

  const hexAt = (i) => Buffer.from(applied[0].params[i]).toString("hex");
  assert.equal(hexAt(1), registry, "param 1 is registry_node_cs");
  assert.equal(hexAt(2), params, "param 2 is params_policy — NOT registry_node_cs again");
  assert.equal(applied[0].params[3], BigInt(MAX_INLINE_DATUM_BYTES), "param 3 is max_inline_datum_bytes");

  // And the correct order is the one the deployment records. (Self-consistent
  // by construction — see the VACUOUS test above — so it is the by-index
  // assertions, not this one, that carry the weight.)
  assert.equal(
    b.issuanceLogic(plb, registry, params, MAX_INLINE_DATUM_BYTES).hash,
    DEPLOYMENT.issuanceLogic.scriptHash,
  );
});

test("⛔ upgradeAuthority is NOT an input to any derivation", () => {
  // Stated positively, because the property is that nothing reads it.
  //
  // A deployment may legitimately name a key credential, a different script, or
  // the multisig itself as its upgrade authority — the validator only requires
  // the credential to appear in `tx.withdrawals` and never inspects it. So a
  // deployment whose `upgradeAuthority` is an unrelated KEY credential must
  // PASS, and no check may relate `upgradeAuthority` to `upgradeMultisig`.
  // Adding one would reject valid deployments; it is the S-11 defect returning
  // under a new name.
  assert.equal(DEPLOYMENT.upgradeAuthority.type, "key");
  assert.notEqual(DEPLOYMENT.upgradeAuthority.hash, DEPLOYMENT.upgradeMultisig.scriptHash);

  const checks = assertDeploymentScripts(blueprint, DEPLOYMENT);
  assert.equal(checks.length, EXPECTED_CHECKS.length);

  // Move it to a completely unrelated key: still ten checks, still all green.
  const rotated = structuredClone(DEPLOYMENT);
  rotated.upgradeAuthority = { type: "key", hash: "99".repeat(28) };
  const after = assertDeploymentScripts(blueprint, rotated);
  assert.deepEqual(
    after.map((c) => c.name).sort(),
    checks.map((c) => c.name).sort(),
    "changing upgradeAuthority must change nothing — no derivation reads it",
  );
  for (const c of after) assert.equal(c.derived, c.deployed);
});
