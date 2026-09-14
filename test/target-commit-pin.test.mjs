/**
 * TARGET_PROTOCOL_COMMIT agrees with the pin beside it — offline, no network.
 *
 * ⛔ THE GUARD'S REACH, STATED SO ITS NAME CANNOT OVERSTATE IT. Both values this
 * test compares — `TARGET_PROTOCOL_COMMIT` in src/standard/blueprint.ts and
 * `upstream.commit` in blueprints/standard/v${TARGET_PROTOCOL_VERSION}/UPSTREAM_PIN.json
 * — live in THIS repository and are written by US. Agreement between them proves only
 * that our label agrees with our pin file; it proves NOTHING about whether either one
 * matches the commit the shipped blueprint artifact was actually built from. That is a
 * consistency check, not a verification. What establishes the pin is TRUE is the
 * reproduction-from-source recorded in the pin's own `"provenance": "VERIFIED"` block
 * (see `test/provenance.test.mjs`), and no offline test — this one included — can stand
 * in for that. This guard closes exactly one narrower defect: someone bumps the
 * blueprint directory (moves TARGET_PROTOCOL_VERSION) and forgets to also update the
 * commit label, so the SDK prints a stale upstream commit in every refusal it issues.
 *
 * Import path: from `../dist/standard/blueprint.js`, NOT the `../dist/index.js` barrel —
 * neither constant is re-exported from the barrel (measured; see T-D32-1.r2.md). This
 * matches the path the sibling guard `test/blueprint-version-guard.test.mjs` already
 * uses to reach TARGET_PROTOCOL_VERSION, so it needs no change to the public surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGET_PROTOCOL_VERSION,
  TARGET_PROTOCOL_COMMIT,
} from "../dist/standard/blueprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("TARGET_PROTOCOL_COMMIT is a well-formed hex prefix, not an empty or malformed label", () => {
  // Without this, an emptied TARGET_PROTOCOL_COMMIT would still pass the "starts with"
  // assertion below vacuously — "anything".startsWith("") is true.
  assert.match(
    TARGET_PROTOCOL_COMMIT,
    /^[0-9a-f]{7,}$/,
    `TARGET_PROTOCOL_COMMIT must be a non-empty lowercase hex string of at least 7 characters, got ${JSON.stringify(TARGET_PROTOCOL_COMMIT)}`,
  );
});

test("TARGET_PROTOCOL_COMMIT is a prefix of the pin's upstream.commit for TARGET_PROTOCOL_VERSION", () => {
  // Path built from the version constant — never hard-coded — so this guard keeps
  // following the pin it is meant to check across a migration.
  const pinPath = resolve(
    ROOT,
    `blueprints/standard/v${TARGET_PROTOCOL_VERSION}/UPSTREAM_PIN.json`,
  );
  const pin = JSON.parse(readFileSync(pinPath, "utf-8"));

  // The constant is a 7-character PREFIX of the full 40-char commit, not the full hash.
  assert.ok(
    pin.upstream.commit.startsWith(TARGET_PROTOCOL_COMMIT),
    `TARGET_PROTOCOL_COMMIT (${JSON.stringify(TARGET_PROTOCOL_COMMIT)}) is not a prefix of ` +
      `${pinPath}'s upstream.commit (${JSON.stringify(pin.upstream.commit)}) — bump the constant ` +
      `alongside the blueprint directory`,
  );
});
