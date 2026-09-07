/**
 * The version verdict comes from the PREAMBLE, never from which symbols are present.
 *
 * ⛔ THE DEFECT THIS PINS, and it is worth stating precisely because the guard
 * was not broken in an obvious way — it fired correctly and named the wrong
 * cause. `validateStandardBlueprint` inferred "this blueprint is OLDER than the
 * SDK" from the presence of any retired validator title. Upstream #110
 * dissolved `programmable_logic_global`; upstream #117 brought it BACK as the
 * PLG dispatcher. So 0.5.0-alpha.3 — strictly NEWER than this SDK's target —
 * was reported as "an earlier CIP-113 protocol version that this SDK no longer
 * supports", sending the reader to hunt for a stale checkout.
 *
 * A symbol can come back. A version number cannot go backwards.
 *
 * The discriminating pair below is the point of the file: TWO blueprints that
 * carry the SAME retired symbol and differ ONLY in their preamble version must
 * produce OPPOSITE verdicts. A test that only checked the old direction would
 * pass against the broken implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateStandardBlueprint,
  compareProtocolVersions,
  TARGET_PROTOCOL_VERSION,
} from "../dist/standard/blueprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

/**
 * A real pre-0.5 artifact: genuinely older, AND it declares the retired
 * `programmable_logic_global` title. Both facts matter.
 */
const OLD = load("blueprints/standard/v0.3.0/plutus.json");

/** The same validator set, relabelled as a version NEWER than the target. */
const NEWER_WITH_SAME_SYMBOL = {
  ...OLD,
  preamble: { ...OLD.preamble, version: "0.5.0-alpha.3" },
};

const messageOf = (bp) => {
  try {
    validateStandardBlueprint(bp);
    return null;
  } catch (e) {
    return e.message;
  }
};

test("THE DISCRIMINATING PAIR: same retired symbol, opposite verdicts", () => {
  const older = messageOf(OLD);
  const newer = messageOf(NEWER_WITH_SAME_SYMBOL);

  assert.ok(older, "an unusable blueprint must be refused");
  assert.ok(newer, "an unusable blueprint must be refused");

  assert.match(older, /EARLIER CIP-113 protocol version/);
  assert.match(newer, /LATER CIP-113 protocol version/);

  // The regression, stated directly: the newer one must NEVER be called older.
  assert.doesNotMatch(
    newer,
    /EARLIER/,
    "a blueprint newer than the target was reported as earlier — the original defect",
  );

  // And the reader must be told it is a migration gap, not a bad file.
  assert.match(newer, /not a stale or corrupt file/);
});

test("both verdicts still carry the retired-symbol hint as colour", () => {
  // The hint is useful; it just must not DECIDE the direction.
  for (const bp of [OLD, NEWER_WITH_SAME_SYMBOL]) {
    assert.match(messageOf(bp), /programmable_logic_global/);
  }
});

test("an unparseable version says so rather than guessing a direction", () => {
  const msg = messageOf({
    ...OLD,
    preamble: { ...OLD.preamble, version: "not-a-version" },
  });
  assert.match(msg, /could not be parsed/);
  assert.doesNotMatch(msg, /EARLIER|LATER/, "must not claim a direction it cannot establish");
});

test("the target version itself, missing validators, is neither older nor newer", () => {
  const msg = messageOf({
    ...OLD,
    preamble: { ...OLD.preamble, version: TARGET_PROTOCOL_VERSION },
  });
  assert.match(msg, /does not match its own version string/);
  assert.doesNotMatch(msg, /EARLIER|LATER/);
});

test("a valid target blueprint still passes untouched", () => {
  assert.equal(
    validateStandardBlueprint(load("blueprints/standard/v0.5.0-alpha.2/plutus.json")),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// The real alpha.3 artifact — the case that exposed the defect
// ---------------------------------------------------------------------------

test("the VENDORED alpha.3 blueprint is refused as LATER, not as stale", () => {
  // The synthetic pair above isolates the variable; this one is the artifact
  // that actually broke the old guard. Both matter: the synthetic proves the
  // MECHANISM, this proves it against real bytes with real titles.
  const alpha3 = load("blueprints/standard/v0.5.0-alpha.3/plutus.json");
  assert.equal(alpha3.preamble.version, "0.5.0-alpha.3");

  const msg = messageOf(alpha3);
  assert.ok(msg, "alpha.3 is not yet supported and must be refused");
  assert.match(msg, /LATER CIP-113 protocol version/);
  assert.match(msg, /not a stale or corrupt file/);
  assert.doesNotMatch(msg, /EARLIER/, "the original defect: newer reported as older");

  // It must also name what is missing, so the refusal is actionable.
  assert.match(msg, /PROTOCOL_PARAMS_MINT|REGISTRY_MINT|REGISTRY_SPEND|COORDINATION_SPEND/);
});

test("alpha.3 declares the four validators this SDK has not migrated to", () => {
  // Pins the shape of the work S-4 must do. If upstream changes this set, the
  // migration's scope changed and someone must look.
  const titles = load("blueprints/standard/v0.5.0-alpha.3/plutus.json").validators.map(
    (v) => v.title,
  );
  for (const t of [
    "protocol_params.protocol_params.mint",
    "protocol_params.protocol_params.spend",
    "registry.registry.mint",
    "registry.registry.spend",
    "programmable_logic_global.programmable_logic_global.withdraw",
  ]) {
    assert.ok(titles.includes(t), `alpha.3 should declare ${t}`);
  }
  for (const gone of [
    "protocol_params_mint.protocol_params_mint.mint",
    "registry_mint.registry_mint.mint",
    "registry_spend.registry_spend.spend",
    "coordination_spend.coordination_spend.spend",
  ]) {
    assert.ok(!titles.includes(gone), `alpha.3 should no longer declare ${gone}`);
  }
});

test("comparator: ordering, including the traps", () => {
  const lt = (a, b) => assert.ok(compareProtocolVersions(a, b) < 0, `${a} should sort below ${b}`);

  lt("0.5.0-alpha.2", "0.5.0-alpha.3");
  lt("0.3.0", "0.5.0-alpha.2");
  lt("0.5.0-alpha.2", "0.5.0"); // a prerelease sorts BELOW its release
  lt("0.4.9", "0.5.0");

  // A plain string compare puts alpha.10 before alpha.2. Semver does not.
  lt("0.5.0-alpha.2", "0.5.0-alpha.10");

  // Numeric identifiers sort below alphanumeric ones.
  lt("0.5.0-1", "0.5.0-alpha");

  // A longer prerelease with an equal prefix sorts above the shorter one.
  lt("0.5.0-alpha", "0.5.0-alpha.1");

  assert.equal(compareProtocolVersions("0.5.0-alpha.2", "0.5.0-alpha.2"), 0);
  assert.equal(compareProtocolVersions("v0.5.0", "0.5.0"), 0, "a leading v is tolerated");
  assert.equal(
    compareProtocolVersions("0.5.0+build1", "0.5.0+build2"),
    0,
    "build metadata does not affect precedence",
  );
});

test("comparator returns null — not 0 — when it cannot tell", () => {
  // ⛔ Coercing this to 0 would make an unparseable version read as "same
  // version", which is a confident answer the comparator never established.
  assert.equal(compareProtocolVersions("garbage", "0.5.0"), null);
  assert.equal(compareProtocolVersions("0.5.0", ""), null);
  assert.equal(compareProtocolVersions("0.5", "0.5.0"), null, "an incomplete core is unparseable");
});
