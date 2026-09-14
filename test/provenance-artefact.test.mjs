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

const pinDirs = findPinDirs(BLUEPRINTS_DIR);

test("provenance-artefact: the walk finds at least 7 shipped pins", () => {
  // ⛔ Not optional. Without this floor, a broken walk that finds nothing
  // would make every test below vacuously pass by iterating zero times.
  assert.ok(
    pinDirs.length >= 7,
    `expected the walk of ${BLUEPRINTS_DIR} to find at least 7 UPSTREAM_PIN.json ` +
      `directories, found ${pinDirs.length}: ${pinDirs.map((d) => relative(ROOT, d)).join(", ")}`
  );
});

for (const dir of pinDirs) {
  const rel = relative(ROOT, dir);
  const blueprint = JSON.parse(readFileSync(join(dir, "plutus.json"), "utf8"));
  const pin = JSON.parse(readFileSync(join(dir, "UPSTREAM_PIN.json"), "utf8"));

  if (pin.provenance === "VERIFIED") {
    test(`provenance-artefact: ${rel} claims VERIFIED and survives provenanceFromPin`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = provenanceFromPin(blueprint, pin);
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
        () => provenanceFromPin(blueprint, pin),
        (e) => {
          assert.match(
            e.message,
            new RegExp(pin.provenance),
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
