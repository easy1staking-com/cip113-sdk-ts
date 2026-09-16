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
  DeploymentMismatchError,
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
// THREE refusals, three messages — and which one fired is the actionable part
// ---------------------------------------------------------------------------

/**
 * ⚠ THE THREE ANSWER DIFFERENT QUESTIONS, so they are asserted separately:
 *   1. ABSENT      — is the field there at all, as an OWN property?
 *   2. MALFORMED   — is it a well-formed 56-lowercase-hex script hash?
 *   3. NOT A CHOICE— is it one of the two values THIS deployment may record?
 * A deployer told only "refused" cannot act. A deployer told "this is a case
 * problem" fixes it in one edit; told "this is not one of the two legal values"
 * goes and looks at what the bootstrap actually compiled.
 *
 * ⛔ EVERY ONE OF THEM MUST BE A `DeploymentMismatchError`. The documented
 * consumer shape is `catch (e) { if (e instanceof DeploymentMismatchError) … }`,
 * so a bare `Error` here is a refusal that names a field being reported to the
 * user as "something went wrong".
 */

/** Set the recorded parameter to `param` WITHOUT touching anything else. */
function recordedAs(param) {
  const d = structuredClone(REAL);
  d.programmableLogicGlobal = { scriptHash: REAL_PLG, unfrackingParameter: param };
  return d;
}

/** Assert both public entry points refuse `d`, and hand back the message. */
function refusal(d, why) {
  let message;
  assert.throws(
    () => assertDeploymentScripts(blueprint, d),
    (err) => {
      assert.ok(
        err instanceof DeploymentMismatchError,
        `${why}: refusals must be DeploymentMismatchError, got ${err.name}: a bare Error ` +
          `falls into the consumer's generic handler`,
      );
      message = err.message;
      return true;
    },
    why,
  );
  // The resolved surface must refuse identically — a rejected parameter must
  // never reach the object substandards build transactions from.
  assert.throws(() => buildDeploymentScripts(blueprint, d), DeploymentMismatchError, why);
  return message;
}

// ---------------------------------------------------------------------------
// 1. ABSENT — including the inherited-property hole
// ---------------------------------------------------------------------------

test("REFUSED as ABSENT: no own unfrackingParameter, and it is never DEFAULTED", () => {
  // ⛔ REQUIRED, WITH NO DEFAULT. TypeScript catches this in every caller's
  // build. A legacy JSON record loaded at runtime carries no types, so the
  // refusal has to hold there too. `?? deployment.unfracking.scriptHash` would
  // be CORRECT for every record written before this field existed, and that is
  // exactly what makes it dangerous: the silent path is right often enough that
  // nobody ever checks it.
  const legacy = structuredClone(REAL);
  delete legacy.programmableLogicGlobal.unfrackingParameter;

  const msg = refusal(legacy, "an absent parameter must be refused, never defaulted");
  assert.match(msg, /unfrackingParameter is ABSENT/, "must say WHICH failure this is");
  assert.match(msg, /REQUIRED/, "must say it is required");
  assert.match(msg, /no default/i, "must say it is not defaulted");
  assert.ok(msg.includes(UNFRACKING_DISABLED), "must name the sentinel as one of the two");
  assert.match(msg, /unfracking\.scriptHash is not it/, "must say why the obvious default is wrong");

  // ⚑ CONTROL. The same record with the field present passes, so the refusal is
  // attributable to the missing field and not to a broken fixture.
  assert.doesNotThrow(() => assertDeploymentScripts(blueprint, REAL));
});

test("⛔ REFUSED as ABSENT: an INHERITED Object.prototype key does not satisfy the field", () => {
  // ⛔ MEASURED, NOT FEARED. Before the own-property check, a record with the
  // field genuinely absent read the polluted prototype value back, passed ALL
  // TEN hash checks, and built the dispatcher from a value nobody recorded —
  // the one outcome this whole ticket exists to make impossible. `in` and a
  // truthiness test both walk the prototype chain; only `hasOwnProperty` does
  // not. Twin of test/ledger-order.test.mjs's "refuses an inherited
  // Object.prototype key"; the house standard already existed, this call site
  // did not meet it.
  const polluted = structuredClone(REAL);
  delete polluted.programmableLogicGlobal.unfrackingParameter;

  Object.defineProperty(Object.prototype, "unfrackingParameter", {
    value: REAL_UNFRACKING,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  try {
    // Precondition: the hole is genuinely open — a plain read DOES find a value.
    assert.equal(
      polluted.programmableLogicGlobal.unfrackingParameter,
      REAL_UNFRACKING,
      "fixture: the prototype must actually be visible, or this test proves nothing",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(
        polluted.programmableLogicGlobal,
        "unfrackingParameter",
      ),
      "fixture: the OWN property must genuinely be gone",
    );

    const msg = refusal(polluted, "an inherited value must never satisfy a required field");
    assert.match(msg, /no OWN property/, "must say the property is not an own property");
    assert.match(msg, /Object\.prototype/, "must name the hole so the reader can find it");
  } finally {
    delete Object.prototype.unfrackingParameter;
  }
  assert.ok(!("unfrackingParameter" in {}), "the prototype must be restored");
});

// ---------------------------------------------------------------------------
// 2. MALFORMED — refused BEFORE any derivation, and never normalised
// ---------------------------------------------------------------------------

/**
 * Values that are not a well-formed 56-lowercase-hex script hash.
 *
 * ⛔ WITHOUT THIS REFUSAL EVERY ONE OF THESE REACHED EVOLUTION'S CBOR ENCODER
 * and died as `ParseError: Data.ByteArray … Expected string`, naming no field,
 * no record and no file — in front of an artefact `deployments/README.md` says
 * cannot be regenerated. Fails closed either way; the entire difference is
 * whether the deployer can act on it.
 */
const MALFORMED = [
  ["a leading space", " " + REAL_UNFRACKING],
  ["a trailing space", REAL_UNFRACKING + " "],
  ["an embedded space", REAL_UNFRACKING.slice(0, 28) + " " + REAL_UNFRACKING.slice(28)],
  ["a trailing newline", REAL_UNFRACKING + "\n"],
  ["a 0x prefix on the real hash", "0x" + REAL_UNFRACKING],
  ["a 0x prefix on the sentinel", "0x" + UNFRACKING_DISABLED],
  ["a TRUNCATED unfracking hash", REAL_UNFRACKING.slice(0, 54)],
  ["the empty string", ""],
  ["undefined", undefined],
  ["null", null],
  ["the number 0", 0],
  ["a Uint8Array of the right length", new Uint8Array(28)],
  // eslint-disable-next-line no-new-wrappers
  ["a boxed String wrapper", new String(REAL_UNFRACKING)],
  ["the hash inside an array", [REAL_UNFRACKING]],
];

for (const [label, bad] of MALFORMED) {
  test(`REFUSED as MALFORMED: ${label}`, () => {
    const msg = refusal(recordedAs(bad), `${label} is not a well-formed script hash`);

    assert.match(msg, /unfrackingParameter records /, "must name the field");
    assert.match(msg, /not a well-formed script hash/, "must say WHICH refusal this is");
    assert.match(msg, /56 LOWERCASE HEX CHARACTERS/, "must state the required shape");
    // ⛔ And it must NOT claim membership failure. Saying a malformed value "is
    // neither value a deployment may record" is true byte-wise and useless to
    // read: it sends a deployer to compare hashes when the fix is a stray space.
    assert.ok(
      !/neither\s+value a deployment may record/.test(msg),
      `a malformed value must not be diagnosed as a membership failure: ${msg}`,
    );
    // It is refused BEFORE derivation, so Evolution never sees it.
    assert.ok(
      !/ParseError|Data\.ByteArray/.test(msg),
      `must not surface Evolution's encoder error: ${msg}`,
    );
  });
}

test("REFUSED as MALFORMED: the real hash in UPPERCASE, and the message says it is a CASE problem", () => {
  // ⛔ BYTE-EXACT, DELIBERATELY NOT NORMALISED. Lowercased, this IS a legal
  // value — which is precisely why it must be refused rather than fixed for the
  // caller: this field records what the dispatcher was COMPILED AGAINST, and
  // accepting a spelling that differs from the bytes that were hashed re-opens
  // the ambiguity the field exists to remove. A "didn't derive ⇒ must be the
  // sentinel" fallback would have waved it through as a DISABLED deployment.
  const upper = REAL_UNFRACKING.toUpperCase();
  assert.notEqual(upper, REAL_UNFRACKING, "fixture: the hash must contain letters to upcase");

  const msg = refusal(recordedAs(upper), "an uppercase spelling must be refused");
  assert.ok(msg.includes(upper), `must quote the value as written: ${msg}`);
  assert.match(msg, /CASE PROBLEM/, "must diagnose it as a case problem, not a wrong value");
  assert.match(msg, /lowercase/i, "must say what to do about it");

  // …and the SDK must not have silently accepted the lowercased form instead.
  assert.throws(() => buildDeploymentScripts(blueprint, recordedAs(upper)));
});

// ---------------------------------------------------------------------------
// 3. NOT A CHOICE — well-formed, and still not one of the two
// ---------------------------------------------------------------------------

/**
 * ⛔ A GUARD THAT ONLY REJECTS `""` IS NOT THIS GUARD. These are all perfectly
 * well-formed 56-lowercase-hex script hashes — they pass every shape test — and
 * they are exactly what a "didn't derive ⇒ must be the sentinel" fallback waves
 * through: a typo, and a hash lifted from a different deployment of the same
 * protocol.
 */
const NOT_A_CHOICE = [
  // Last nibble only: the FIRST character of this hash is already "0", so a
  // leading-nibble "typo" would silently reproduce the original.
  ["a one-nibble TYPO in the unfracking hash", REAL_UNFRACKING.slice(0, 55) + "d"],
  ["a hash from a DIFFERENT deployment (preview alpha.3)",
    "eb2131575dce4bfeee8054be6a58d1dcd06a12befbfbd5f6224a79a4"],
  ["a hash from a DIFFERENT deployment (preview alpha.2)",
    "042c367e45a36d7bdb295fbefab63427485e6f2cd9120a7505d58903"],
  ["an almost-sentinel with one bit set", "00".repeat(27) + "01"],
];

for (const [label, bad] of NOT_A_CHOICE) {
  test(`REFUSED as NOT A CHOICE: ${label}`, () => {
    // ⚑ FIXTURE INTEGRITY, per case. It must be well-formed (or this is a shape
    // test in disguise) and differ from both legal values (or it is vacuous).
    assert.match(bad, /^[0-9a-f]{56}$/, "must be a WELL-FORMED hash — shape is not the point here");
    assert.notEqual(bad, REAL_UNFRACKING);
    assert.notEqual(bad, UNFRACKING_DISABLED);

    // ⛔ THE FIXTURE IS SELF-CONSISTENT ON PURPOSE. Its recorded dispatcher hash
    // is recomputed FROM the bad parameter, which is what a bootstrap that used
    // that parameter would genuinely have written — so all ten hash checks
    // reproduce and nothing in the existing assertion can refuse it. The
    // membership test is the only thing left.
    const d = compiledAgainst(bad);

    // ⛔ THE CONTROL. Same construction, a LEGAL parameter: it passes. That is
    // what makes the refusal attributable to the parameter rather than to the
    // fixture.
    assert.doesNotThrow(
      () => assertDeploymentScripts(blueprint, compiledAgainst(REAL_UNFRACKING)),
      "control: the same record shape with a LEGAL parameter must pass",
    );

    const msg = refusal(d, `${label} is well-formed but not a legal choice`);
    assert.ok(
      msg.includes(`unfrackingParameter records "${bad}"`),
      `the message must quote the offending value; got: ${msg}`,
    );
    assert.match(msg, /neither\s+value a deployment may record/, "must say WHICH refusal this is");
    assert.ok(msg.includes(REAL_UNFRACKING), "must name the derived unfracking hash as a candidate");
    assert.ok(msg.includes(UNFRACKING_DISABLED), "must name UNFRACKING_DISABLED as a candidate");
    assert.match(msg, /UNFRACKING_DISABLED/, "must name the constant by name");
    // …and NOT mis-diagnose a well-formed value as malformed.
    assert.ok(
      !/not a well-formed script hash/.test(msg),
      `a well-formed value must not be diagnosed as malformed: ${msg}`,
    );
  });
}

// ---------------------------------------------------------------------------
// The dispatcher-coherence mismatch now has THREE causes, and must name them
// ---------------------------------------------------------------------------

test("a PLG mismatch names unfrackingParameter as a candidate cause", () => {
  // ⚠ The check is called "dispatcher coherence" and its name trains the reader
  // to hunt for a stale delegate. A record that compiled against the sentinel
  // and then wrote the ENABLED dispatcher's hash fails here with transfer and
  // thirdParty both perfectly correct. The parameter is also the only one of
  // the three derivation inputs that cannot be cross-checked against anything
  // else in the record — so it is the one the message has to name.
  const incoherent = structuredClone(REAL);
  incoherent.programmableLogicGlobal.unfrackingParameter = UNFRACKING_DISABLED;
  // scriptHash left at REAL_PLG — the enabled dispatcher.

  assert.throws(
    () => assertDeploymentScripts(blueprint, incoherent),
    (err) => {
      assert.ok(err instanceof DeploymentMismatchError);
      const names = err.mismatches.map((m) => m.name);
      assert.deepEqual(names, ["programmable_logic_global (dispatcher coherence)"],
        `exactly one check must fail, got: ${names.join(", ")}`);
      assert.match(err.message, /unfrackingParameter/, "must name the third cause");
      assert.match(err.message, /transfer\.scriptHash/, "must name the delegate causes too");
      assert.match(err.message, /thirdParty\.scriptHash/);
      assert.match(err.message, /COMPILED AGAINST/, "must say what the parameter means");
      return true;
    },
  );
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
