/**
 * What `programmable_logic_global` was COMPILED AGAINST is a deployment CHOICE,
 * and it is not inferable from anything else in the record.
 *
 * ⛔ THE DEPLOYMENT THIS EXISTS FOR. A launch may ship unfracking FULLY
 * DEPLOYED — six registrations, seven reference scripts, `unfrackingRefInput`
 * present, `unfracking.scriptHash` real — while compiling the dispatcher
 * against a 28-byte zero sentinel so the dispatcher's unfracking arm can never
 * be satisfied. The record then carries TWO different 28-byte values that are
 * both correct: the real unfracking hash (what was deployed) and
 * `UNFRACKING_DISABLED` (what was hashed into the dispatcher). Nothing can
 * derive one from the other, which is why
 * `programmableLogicGlobal.unfrackingParameter` records the VALUE rather than a
 * flag, and why it is REQUIRED rather than defaulted.
 *
 * ⚠ AND THE DANGEROUS RECORD IS SELF-CONSISTENT. A bootstrap that compiled the
 * dispatcher against a typo'd, truncated or foreign hash and then recorded BOTH
 * produces a deployment where all ten hash checks reproduce — the assertion has
 * nothing to compare. Every negative below is therefore built self-consistently
 * on purpose: its `programmableLogicGlobal.scriptHash` is recomputed from the
 * bad parameter, so the ONLY thing left that can refuse it is the two-element
 * membership guard. A negative that merely tampers with one field would be
 * caught by the dispatcher-coherence check and would prove nothing about this
 * guard.
 *
 * ⛔ AND IT IS MEMBERSHIP IN A TWO-ELEMENT SET, NOT "didn't derive ⇒ sentinel".
 * `if (recorded !== derived) { assume sentinel }` accepts a typo, a truncation
 * and a stale hash from another deployment, and it would pass every test in
 * this file. The cases below exist to make that shape fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDeploymentScripts,
  buildDeploymentScripts,
  createStandardScripts,
  UNFRACKING_DISABLED,
} from "../dist/standard/scripts.js";
import * as barrel from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

const blueprint = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");

/**
 * The LIVE preview alpha.4 record, not a derived fixture.
 *
 * ⚑ DELIBERATELY NOT SELF-DERIVED. `deployment-assertion.test.mjs` already
 * documents that a fixture whose every hash the test itself derived asserts
 * against itself and passes no matter how wrong the parameterisation is. This
 * record's hashes came off a real bootstrap, so the pinned PLG hash below is an
 * INDEPENDENT source the parameterisation chain has to reproduce.
 */
const REAL = load("deployments/preview/alpha4-7e8a631.json");

/** The PLG hash the live preview instance actually deployed. */
const REAL_PLG = "d599d56f944d33a90b16f561ee61f183a4ba3c9185f2d779e0d356f4";
/** Its real, enabled unfracking delegate. */
const REAL_UNFRACKING = "09388537947cfb1eacb9f0b2e2799f6ae3ce298348f5130488fd1cec";

const builders = createStandardScripts(blueprint);

/** The dispatcher hash that results from compiling against `param`. */
const plgFor = (param) =>
  builders.programmableLogicGlobal(REAL.transfer.scriptHash, REAL.thirdParty.scriptHash, param)
    .hash;

/**
 * A SELF-CONSISTENT record that compiled the dispatcher against `param`.
 *
 * Both halves move together — the recorded parameter AND the recorded
 * dispatcher hash — which is what a bootstrap using that parameter would
 * genuinely have written. Everything else, `unfracking.scriptHash` included,
 * stays exactly as the live instance recorded it.
 */
function compiledAgainst(param) {
  const d = structuredClone(REAL);
  d.programmableLogicGlobal = { scriptHash: plgFor(param), unfrackingParameter: param };
  return d;
}

// ---------------------------------------------------------------------------
// The constant
// ---------------------------------------------------------------------------

test("UNFRACKING_DISABLED is 28 zero bytes, and nothing else", () => {
  assert.equal(typeof UNFRACKING_DISABLED, "string");
  assert.equal(UNFRACKING_DISABLED.length, 56, "28 bytes = 56 hex characters");
  assert.match(UNFRACKING_DISABLED, /^[0-9a-f]{56}$/, "lowercase hex, no 0x prefix");
  assert.equal(UNFRACKING_DISABLED, "0".repeat(56), "every byte zero");
  assert.equal(Buffer.from(UNFRACKING_DISABLED, "hex").length, 28);
  // ⚠ Structurally a script hash. `#""` is type-legal for a bare ScriptHash but
  // nobody here can read the compiled validator's body, so a length-shaped
  // value is the one that cannot reach code we cannot read.
  assert.equal(UNFRACKING_DISABLED.length, REAL_UNFRACKING.length);
});

test("UNFRACKING_DISABLED is exported from the barrel, and is the SAME value", () => {
  // ⛔ The platform must IMPORT it. A platform-side copy is a second place to
  // disagree about a value that determines a script hash — so the barrel has to
  // actually carry it, and carry the one definition rather than a re-typed twin.
  assert.equal(
    barrel.UNFRACKING_DISABLED,
    UNFRACKING_DISABLED,
    "the barrel must re-export the single definition in standard/scripts.ts",
  );
  assert.equal(barrel.UNFRACKING_DISABLED, "0".repeat(56));
});

// ---------------------------------------------------------------------------
// No behaviour change for a deployment that records the real hash
// ---------------------------------------------------------------------------

test("REAL hash recorded: the live preview instance still derives its deployed PLG hash", () => {
  // ⛔ THE NO-CHANGE-IN-BEHAVIOUR PROOF, pinned to an INDEPENDENT value. If the
  // parameterisation chain, the argument order, or the encoding of the three
  // dispatcher parameters ever moves, this reddens — and it reddens against a
  // hash that is on chain, not against one this file derived a moment ago.
  const checks = assertDeploymentScripts(blueprint, REAL);
  const plg = checks.find((c) => c.name === "programmable_logic_global (dispatcher coherence)");
  assert.ok(plg, "the dispatcher-coherence check must still exist under that name");
  assert.equal(plg.derived, REAL_PLG, "the derived dispatcher hash moved");
  assert.equal(plg.deployed, REAL_PLG, "the recorded dispatcher hash moved");

  // And the record genuinely has unfracking ENABLED: the parameter IS the real
  // delegate hash, so this arm of the guard is the one exercised here.
  assert.equal(REAL.programmableLogicGlobal.unfrackingParameter, REAL_UNFRACKING);
  assert.equal(REAL.unfracking.scriptHash, REAL_UNFRACKING);
  assert.notEqual(
    REAL.programmableLogicGlobal.unfrackingParameter,
    UNFRACKING_DISABLED,
    "if this ever equals the sentinel the enabled arm stops being tested here",
  );
});

// ---------------------------------------------------------------------------
// The sentinel is a DIFFERENT protocol
// ---------------------------------------------------------------------------

test("SENTINEL recorded: the dispatcher hash is DIFFERENT, and the record still verifies", () => {
  const disabled = compiledAgainst(UNFRACKING_DISABLED);

  // ⚠ The whole point: the choice is baked into the dispatcher's hash, so two
  // deployments differing ONLY here are different protocols.
  assert.notEqual(
    disabled.programmableLogicGlobal.scriptHash,
    REAL_PLG,
    "compiling against the sentinel MUST move the dispatcher hash — if these are " +
      "ever equal the parameter is not reaching the script and this file proves nothing",
  );

  // ⚑ And it verifies: nothing else in the record changed. Unfracking is still
  // deployed, still recorded, still published — only unreachable.
  const checks = assertDeploymentScripts(blueprint, disabled);
  assert.equal(checks.length, 10, "the sentinel must not shrink the check list");
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
  assert.equal(disabled.unfracking.scriptHash, REAL_UNFRACKING, "unfracking stays deployed");
  assert.deepEqual(
    disabled.unfrackingRefInput,
    REAL.unfrackingRefInput,
    "its reference script stays published",
  );

  // The resolved surface must be built from the sentinel too, not from the real
  // delegate hash sitting right beside it in the same record.
  const resolved = buildDeploymentScripts(blueprint, disabled);
  assert.equal(resolved.programmableLogicGlobal.hash, disabled.programmableLogicGlobal.scriptHash);
  assert.notEqual(resolved.programmableLogicGlobal.hash, REAL_PLG);
});

// ---------------------------------------------------------------------------
// The guard: membership in a TWO-element set, and nothing else
// ---------------------------------------------------------------------------

/**
 * Values that are neither the derived unfracking hash nor the sentinel.
 *
 * ⛔ A GUARD THAT ONLY REJECTS `""` IS NOT THIS GUARD. The cases that matter
 * are the ones a "didn't derive ⇒ must be the sentinel" fallback waves through:
 * a truncation, a single mistyped nibble, a hash lifted from a different
 * deployment of the same protocol, and the sentinel written in the wrong case.
 */
const ILLEGAL = [
  ["a TRUNCATED unfracking hash", REAL_UNFRACKING.slice(0, 54)],
  // Last nibble only: the FIRST character of this hash is already "0", so a
  // leading-nibble "typo" would silently reproduce the original.
  ["a one-nibble TYPO in the unfracking hash", REAL_UNFRACKING.slice(0, 55) + "d"],
  ["a hash from a DIFFERENT deployment (preview alpha.3)",
    "eb2131575dce4bfeee8054be6a58d1dcd06a12befbfbd5f6224a79a4"],
  ["a hash from a DIFFERENT deployment (preview alpha.2)",
    "042c367e45a36d7bdb295fbefab63427485e6f2cd9120a7505d58903"],
  // ⚠ The CANONICAL FORM is load-bearing. Every hash in a deployment record
  // is lowercase hex, and `Data.bytearray` accepts either case — so an
  // uppercase copy of the real hash derives the SAME dispatcher and a
  // "didn't derive ⇒ must be the sentinel" fallback would wave it through as
  // a disabled deployment. The guard is byte-exact on the canonical form.
  ["the real unfracking hash in UPPERCASE", REAL_UNFRACKING.toUpperCase()],
  ["an almost-sentinel with one bit set", "00".repeat(27) + "01"],
  ["the empty string", ""],
];

for (const [label, bad] of ILLEGAL) {
  test(`REFUSED: ${label}`, () => {
    // ⚑ FIXTURE INTEGRITY, per case. The bad value must actually differ from
    // both legal ones, or this case is vacuous.
    assert.notEqual(bad, REAL_UNFRACKING);
    assert.notEqual(bad, UNFRACKING_DISABLED);

    const d = compiledAgainst(bad);

    // ⛔ THE CONTROL. The record is self-consistent: every one of the ten hash
    // checks reproduces, so nothing in the existing assertion can refuse it.
    // Swap ONLY the parameter for a legal value, keeping the same construction,
    // and it passes — which is what makes the refusal below attributable to the
    // parameter rather than to a broken fixture.
    assert.doesNotThrow(
      () => assertDeploymentScripts(blueprint, compiledAgainst(REAL_UNFRACKING)),
      "control: the same record shape with a LEGAL parameter must pass",
    );

    assert.throws(
      () => assertDeploymentScripts(blueprint, d),
      (err) => {
        // Named refusal, and it must name the value it found…
        assert.match(
          err.message,
          new RegExp(`unfrackingParameter records "${bad}"`),
          `the message must quote the offending value; got: ${err.message}`,
        );
        // …and BOTH values it would have accepted. A message naming only one
        // leaves the reader to guess the other from a version of this SDK.
        assert.ok(
          err.message.includes(REAL_UNFRACKING),
          "must name the derived unfracking hash as a candidate",
        );
        assert.ok(
          err.message.includes(UNFRACKING_DISABLED),
          "must name UNFRACKING_DISABLED as a candidate",
        );
        assert.match(err.message, /UNFRACKING_DISABLED/, "must name the constant by name");
        return true;
      },
    );

    // The resolved surface must refuse identically — a rejected parameter must
    // never reach the object substandards build transactions from.
    assert.throws(
      () => buildDeploymentScripts(blueprint, d),
      new RegExp(`unfrackingParameter records "${bad}"`),
    );
  });
}

test("REFUSED: a legacy record with NO unfrackingParameter is never DEFAULTED", () => {
  // ⛔ THE FIELD IS REQUIRED, WITH NO DEFAULT. TypeScript catches an absent
  // field in every caller's build — loudly, at compile time, naming the field.
  // A legacy JSON record loaded at runtime carries no types, so the refusal has
  // to hold there too. `?? deployment.unfracking.scriptHash` would be CORRECT
  // for every record written before this field existed, and that is exactly
  // what makes it dangerous: the silent path would be right often enough that
  // nobody ever checks it. The whole point is that this value is not inferable.
  const legacy = structuredClone(REAL);
  delete legacy.programmableLogicGlobal.unfrackingParameter;

  assert.throws(
    () => assertDeploymentScripts(blueprint, legacy),
    "an absent parameter must be REFUSED, never defaulted to the real hash",
  );
  assert.throws(() => buildDeploymentScripts(blueprint, legacy));

  // ⚑ CONTROL, and it is what turns the two refusals above into evidence. The
  // same record with the field PRESENT passes, so the throw is attributable to
  // the missing field and not to some unrelated breakage in the fixture.
  assert.doesNotThrow(() => assertDeploymentScripts(blueprint, REAL));

  // ⚠ KNOWN LIMIT, stated rather than hidden: an ABSENT value fails inside
  // Evolution's `Data.bytearray` while the dispatcher is being derived, so the
  // message a runtime caller sees is an encoding error, not the named
  // membership refusal the illegal-VALUE cases above get. The refusal is real
  // either way; only the diagnosis is worse. A typed caller never reaches here.
});

// ---------------------------------------------------------------------------
// The reversible launch
// ---------------------------------------------------------------------------

test("THE UPGRADE PROPERTY: sentinel today, real hash after the upgrade, same deployment", () => {
  // ⛔ THE PROPERTY THE WHOLE TICKET EXISTS TO PROTECT. Enabling unfracking
  // later must reduce to: recompile PLG against the real hash, publish that ONE
  // new reference script, PROTOCOL_UPGRADE the params datum's `plg_cred`. No
  // new unfracking deployment, no re-registration, registry nodes untouched, no
  // token reissued. So a deployment recorded TODAY must still verify AFTER that
  // upgrade, with the recorded parameter then holding the real hash.
  const before = compiledAgainst(UNFRACKING_DISABLED);
  assertDeploymentScripts(blueprint, before);

  // The upgrade: two fields move, and only two.
  const after = structuredClone(before);
  after.programmableLogicGlobal.unfrackingParameter = REAL_UNFRACKING;
  after.programmableLogicGlobal.scriptHash = plgFor(REAL_UNFRACKING);

  const checks = assertDeploymentScripts(blueprint, after);
  assert.equal(checks.length, 10);
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} should reproduce`);
  assert.equal(after.programmableLogicGlobal.scriptHash, REAL_PLG, "back to the deployed PLG");

  // ⚑ AND NOTHING ELSE MOVED. Compared field by field against the record from
  // before the upgrade: if any other key differs, the "recompile one script"
  // story is false and the upgrade is not the cheap one described above.
  const moved = Object.keys(after).filter(
    (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]),
  );
  assert.deepEqual(
    moved,
    ["programmableLogicGlobal"],
    `enabling unfracking must move ONE record field, not ${moved.length}: ${moved.join(", ")}`,
  );
  assert.equal(after.unfracking.scriptHash, before.unfracking.scriptHash);
  assert.deepEqual(after.registry, before.registry);
  assert.deepEqual(after.protocolParams, before.protocolParams);
});
