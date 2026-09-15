/**
 * `provenanceFromPin` aimed at the REAL shipped artefacts, not a fixture.
 *
 * ⛔ WHY THIS FILE EXISTS. `provenanceFromPin` already refuses a pin whose
 * `upstream.commit` is not a full 40-character sha — but until now nothing
 * ever called it against the pins this package actually SHIPS
 * (`blueprints/**`, inside the published tarball). `test/provenance.test.mjs`
 * only checks `sha256` and `declares` against the artefact; `test/
 * provenance-gate.test.mjs` exercises `provenanceFromPin` correctly but only
 * against an in-test freeze-and-seize fixture. Truncating a shipped pin's
 * commit to an abbreviation left the whole offline suite green — this file
 * closes that gap.
 *
 * DISCOVERY, NOT ENUMERATION. The pins are found by walking `blueprints/`
 * rather than naming them, so a directory added by a future migration is
 * covered without editing this test — a hard-coded list is the same rot this
 * ticket exists to close. The walk asserts a floor of at least 7 found pins
 * so that a broken walk (e.g. pointed at the wrong root) cannot pass by
 * silently finding nothing.
 *
 * THE GUARD IS CONDITIONAL ON THE PIN'S OWN CLAIM. Two shipped pins
 * (`standard/v0.3.0`, `substandards/dummy/v0.1.0`) legitimately carry
 * `provenance: "UNVERIFIED"` / `"UNKNOWN"` — honest records of unverifiable
 * provenance, not defects. Only a pin claiming VERIFIED must survive
 * `provenanceFromPin`; any other pin must be asserted to throw, and to throw
 * FOR THAT REASON (the message must name the claimed provenance value) — so
 * the pin's honesty is pinned rather than ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { provenanceFromPin } from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BLUEPRINTS_DIR = resolve(ROOT, "blueprints");

/**
 * Walk `dir` recursively and return the directory (absolute path) of every
 * `UPSTREAM_PIN.json` found beneath it. Discovery, never a hard-coded list —
 * see the file-level comment.
 */
function findPinDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPinDirs(full));
    } else if (entry.isFile() && entry.name === "UPSTREAM_PIN.json") {
      found.push(dir);
    }
  }
  return found;
}

// ⛔ `findPinDirs`'s `readdirSync` calls are the one read in this file that
// runs at MODULE SCOPE, before any `test()` is registered — an unreadable
// directory under `blueprints/` (e.g. permission denied, or a dangling
// symlink mid-walk) would throw here uncaught and crash node:test's
// registration of EVERY test in this file, collapsing the count to an
// ANONYMOUS failure with no test name at all (see T-D38-1: the same shape,
// at a different call site, produced "# tests 201" with nothing in the
// output naming which pin caused it).
//
// This wraps the WHOLE walk, not each recursive `readdirSync` individually.
// That is a stated limit, not an oversight: unlike the per-pin try/catch
// below — which knows every directory in advance from a walk that already
// finished — a walk that fails partway through cannot enumerate the
// directories it never reached, so there is no list to attribute the
// failure to per-entry. What this CAN do, and does: turn the crash into one
// NAMED test instead of a silent module-scope abort, and that name is not
// empty — Node's own ENOENT/EACCES error embeds the offending path in
// `.message`, so the failure still says which directory could not be read.
// The cost is real: a walk failure loses every per-pin test for that run —
// the count floor does NOT disappear; it is the thing that REPORTS the walk
// failure (see the `pinDirsError` → named `assert.fail` below), same as it
// would with per-call wrapping, because nothing downstream of a partial walk
// can be trusted either way.
let pinDirs;
let pinDirsError;
try {
  pinDirs = findPinDirs(BLUEPRINTS_DIR);
} catch (e) {
  pinDirs = [];
  pinDirsError = e;
}

// ⚑ COVERAGE-OF-SUBSTANCE (PLAN.md). Read-time guards above cover a per-pin
// test's SURVIVAL — they cannot see a test body gutted to `assert.ok(true);
// return;`, which still leaves every existing assertion in this file GREEN
// (T-D38 measured this at 208). `callProvenance` is the one substitute call
// site both per-pin branches route through; `calls` records which pin
// directories actually reached `provenanceFromPin`, and the final test below
// compares that against every pin that reached either branch, naming any
// directory whose test stopped calling it.
const calls = [];
const callProvenance = (blueprint, pin, rel) => {
  calls.push(rel);
  return provenanceFromPin(blueprint, pin);
};
const expectedRels = [];

test("provenance-artefact: the walk finds at least 7 shipped pins", () => {
  // ⛔ Not optional. Without this floor, a broken walk that finds nothing
  // would make every test below vacuously pass by iterating zero times.
  if (pinDirsError) {
    assert.fail(
      `walking ${BLUEPRINTS_DIR} for UPSTREAM_PIN.json failed before any pin could be ` +
        `checked: ${pinDirsError.message}`
    );
  }
  assert.ok(
    pinDirs.length >= 7,
    `expected the walk of ${BLUEPRINTS_DIR} to find at least 7 UPSTREAM_PIN.json ` +
      `directories, found ${pinDirs.length}: ${pinDirs.map((d) => relative(ROOT, d)).join(", ")}`
  );
});

for (const dir of pinDirs) {
  const rel = relative(ROOT, dir);

  // ⛔ Every per-pin read below (the pin's own JSON, and the blueprint file it
  // declares) can throw: a nonexistent declared artifact (ENOENT), malformed
  // JSON in either file (SyntaxError), or a directory instead of a file
  // (EISDIR, e.g. `artifact: ""` — see the empty-string guard just below). Any
  // of those, uncaught, would throw at MODULE scope and crash node:test's
  // registration of every test in this file, including the count floor above.
  // The try/catch confines the damage to ONE named failing test for THIS
  // directory and lets the loop continue to the rest. This covers every
  // PER-PIN read failure — it does NOT, and cannot, catch a per-pin assertion body that has
  // been gutted to a no-op; that failure mode is a silent gap in what this
  // file checks, not a crash, and is invisible to the test count. See T-D38-1.
  let pin, blueprint;
  try {
    pin = JSON.parse(readFileSync(join(dir, "UPSTREAM_PIN.json"), "utf8"));

    // The pin declares its own artifact filename; read the declaration rather
    // than assuming "plutus.json". A guard asserting the field is PRESENT
    // must also assert it is NON-EMPTY: `typeof pin.artifact !== "string"`
    // alone accepts `artifact: ""`, and `join(dir, "")` resolves to the
    // directory itself, which `readFileSync` refuses with EISDIR rather than
    // naming the real defect. A missing, non-string, or empty field is
    // refused by a NAMED assertion (never a `??`/`||` guess) so a bad pin
    // fails one test instead of crashing the module.
    if (typeof pin.artifact !== "string" || pin.artifact === "") {
      test(`provenance-artefact: ${rel} declares a non-empty string "artifact" field`, () => {
        assert.fail(
          `${rel}/UPSTREAM_PIN.json is missing a non-empty string "artifact" field naming its blueprint file`
        );
      });
      continue;
    }

    blueprint = JSON.parse(readFileSync(join(dir, pin.artifact), "utf8"));
  } catch (e) {
    test(`provenance-artefact: ${rel} has a readable pin and a readable declared artifact`, () => {
      assert.fail(
        `${rel}: failed to read or parse UPSTREAM_PIN.json or its declared artifact: ${e.message}`
      );
    });
    continue;
  }

  // ⛔ EMPTY-STRING GUARD, T-D39-1. `pin.provenance === "VERIFIED"` is false
  // for `""` (falls into the "refuses it" branch below). The refusal branch
  // now asserts `e.message.includes(pin.provenance)` (T-D41 — see below), and
  // `"".includes("")` is `true`, so an empty `provenance` would still make
  // that assertion vacuous — the test's own name ("...refuses it for that
  // reason") would pass GREEN whether or not the refusal actually named the
  // claimed provenance. Same for a missing `provenance` field: reading
  // `.includes(undefined)` would coerce to the literal string `"undefined"`,
  // not vacuous, but not naming anything real either. Refused by a NAMED
  // assertion before that branch is ever reached, same discipline as the
  // "artifact" field guard above.
  if (typeof pin.provenance !== "string" || pin.provenance === "") {
    test(`provenance-artefact: ${rel} declares a non-empty string "provenance" field`, () => {
      assert.fail(
        `${rel}/UPSTREAM_PIN.json is missing a non-empty string "provenance" field naming its claim`
      );
    });
    continue;
  }

  expectedRels.push(rel);

  if (pin.provenance === "VERIFIED") {
    test(`provenance-artefact: ${rel} claims VERIFIED and survives provenanceFromPin`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = callProvenance(blueprint, pin, rel);
      }, `${rel} is pinned VERIFIED but provenanceFromPin refused it`);
      assert.match(
        result.commitHash,
        /^[0-9a-f]{40}$/,
        `${rel}: commitHash "${result.commitHash}" is not a full 40-character sha`
      );
    });
  } else {
    test(`provenance-artefact: ${rel} claims "${pin.provenance}" and provenanceFromPin refuses it for that reason`, () => {
      assert.throws(
        () => callProvenance(blueprint, pin, rel),
        (e) => {
          assert.ok(
            e.message.includes(pin.provenance),
            `${rel}: expected the refusal to name its own provenance ` +
              `"${pin.provenance}", got: ${e.message}`
          );
          return true;
        },
        `${rel} is pinned "${pin.provenance}", not VERIFIED — provenanceFromPin must refuse it`
      );
    });
  }
}

// ⚑ COVERAGE-OF-SUBSTANCE's own assertion — see the module-scope comment
// above `calls`/`callProvenance`. `expectedRels` is every pin that reached
// either per-pin branch (a pin that `continue`d on a bad `artifact` or
// `provenance` field has no per-pin provenance test to gut, so it is
// correctly excluded from both sides of this comparison). If a per-pin test
// body were gutted to `assert.ok(true); return;`, its branch would stop
// calling `callProvenance` while its `test()` still registers and passes —
// invisible to every guard above, and to the test count — but this
// assertion would go red and name exactly which directory's test stopped
// calling `provenanceFromPin`.
test("provenance-artefact: every per-pin test that ran actually called provenanceFromPin", () => {
  const calledSet = new Set(calls);
  const expectedSet = new Set(expectedRels);
  const missing = expectedRels.filter((rel) => !calledSet.has(rel));
  const unexpected = [...calledSet].filter((rel) => !expectedSet.has(rel));
  assert.deepEqual(
    missing,
    [],
    `the following pin directories have a per-pin provenance test registered but it never ` +
      `called provenanceFromPin (a gutted test body): ${missing.join(", ")}`
  );
  assert.deepEqual(
    unexpected,
    [],
    `provenanceFromPin was called for directories with no expected per-pin test: ${unexpected.join(", ")}`
  );
});
