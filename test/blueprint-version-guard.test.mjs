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
  STANDARD_VALIDATORS,
  RETIRED_VALIDATORS,
} from "../dist/standard/blueprint.js";
import { computeScriptHash } from "../dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(ROOT, p), "utf-8"));

/**
 * A real pre-0.5 artifact: genuinely older, AND it declares the retired
 * `programmable_logic_global` title. Both facts matter.
 */
const OLD = load("blueprints/standard/v0.3.0/plutus.json");

/**
 * The same validator set, relabelled as a version NEWER than the target.
 *
 * ⚠ The label must stay AHEAD of TARGET_PROTOCOL_VERSION as the target moves.
 * It was "0.5.0-alpha.3" until S-4 made that the target; a fixture whose whole
 * job is to be newer silently stops being newer the moment the SDK catches up,
 * and the test would then pass for the wrong reason.
 */
const NEWER_WITH_SAME_SYMBOL = {
  ...OLD,
  preamble: { ...OLD.preamble, version: "0.9.9" },
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

test("both verdicts still carry a retired-symbol hint as colour", () => {
  // The hint is useful; it just must not DECIDE the direction. v0.3.0 declares
  // registry_mint / registry_spend, both retired by the alpha.3 merges.
  for (const bp of [OLD, NEWER_WITH_SAME_SYMBOL]) {
    assert.match(messageOf(bp), /registry_mint|registry_spend|protocol_params_mint/);
  }
});

test("⛔ programmable_logic_global is REQUIRED now, not retired — the crux", () => {
  // The original defect was reading this symbol's presence as evidence of an
  // OLD blueprint. #117 brought it back as the dispatcher, so in alpha.3 it is
  // a REQUIRED validator. If it ever reappears in RETIRED_VALIDATORS while also
  // being required, the guard is contradicting itself and the old bug is back.
  assert.ok(
    Object.values(STANDARD_VALIDATORS).includes(
      "programmable_logic_global.programmable_logic_global.withdraw",
    ),
    "alpha.3 requires the dispatcher",
  );
  assert.ok(
    !Object.keys(RETIRED_VALIDATORS).some((t) => t.startsWith("programmable_logic_global")),
    "a required validator must never also be listed as retired",
  );

  // And the same symbol must not be BOTH required and retired for any title.
  const required = new Set(Object.values(STANDARD_VALIDATORS));
  const clash = Object.keys(RETIRED_VALIDATORS).filter((t) => required.has(t));
  assert.deepEqual(clash, [], `titles listed as both required and retired: ${clash.join(", ")}`);
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

test("the TARGET blueprint passes untouched", () => {
  assert.equal(
    validateStandardBlueprint(load(`blueprints/standard/v${TARGET_PROTOCOL_VERSION}/plutus.json`)),
    undefined,
    "the shipped blueprint for the target version must validate",
  );
});

test("alpha.2 is now diagnosed as EARLIER — a real artifact, not a fixture", () => {
  // The SDK moved past it in S-4. It is still shipped, because a live preview
  // instance runs it, so this is the message a caller pointed at the old
  // blueprint will actually see.
  const msg = messageOf(load("blueprints/standard/v0.5.0-alpha.2/plutus.json"));
  assert.ok(msg, "alpha.2 is no longer the target and must be refused");
  assert.match(msg, /EARLIER CIP-113 protocol version/);
  assert.doesNotMatch(msg, /LATER/);
});

// ---------------------------------------------------------------------------
// The real alpha.3 artifact — the case that exposed the defect
// ---------------------------------------------------------------------------

test("the VENDORED alpha.3 blueprint is now ACCEPTED — S-4's whole point", () => {
  // In S-3 this asserted a LATER refusal. S-4 migrated the SDK to alpha.3, so
  // the assertion INVERTS: the artifact that used to be refused must now
  // validate. Kept as one test rather than deleted-and-rewritten so the flip is
  // visible in the diff.
  const alpha3 = load("blueprints/standard/v0.5.0-alpha.3/plutus.json");
  assert.equal(alpha3.preamble.version, "0.5.0-alpha.3");
  assert.equal(alpha3.preamble.version, TARGET_PROTOCOL_VERSION, "alpha.3 IS the target now");
  assert.equal(validateStandardBlueprint(alpha3), undefined);
});

test("alpha.3 declares the merged validators, and not their predecessors", () => {
  // Pinned the shape of S-4's work while it was pending; now pins that the
  // artifact the SDK targets is still the one S-4 was written against. If
  // upstream changes this set, the migration's ground moved and someone must
  // look.
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

// ---------------------------------------------------------------------------
// alpha.4 — vendored (T-F01-1), but NOT the target. T-F02 owns the flip.
//
// ⛔ ESCALATED, NOT WRITTEN: the contract's test (a) — "alpha.4 is diagnosed
// as LATER" — cannot be built against the real artifact. `validateStandardBlueprint`
// only reaches its version-comparison branch when `missing.length > 0` (a
// required title is absent). alpha.4 retires NO title `STANDARD_VALIDATORS`
// requires — it only changes some validators' bytes/arity and adds
// `issuance_logic` — so `missing` is `[]` for alpha.4 exactly as it is for the
// (correctly accepted) alpha.3, and `validateStandardBlueprint(alpha4)` returns
// silently instead of throwing, even though `compareProtocolVersions("0.5.0-alpha.4",
// TARGET_PROTOCOL_VERSION)` correctly returns 1. Measured, not assumed: both
// alpha.3 and alpha.4 produce `missing: []` and neither throws. Fixing this is a
// `src/standard/blueprint.ts` change and `src/**` is off this slice's allowlist —
// reported to the Orchestrator rather than routed around. See the worker report.
// ---------------------------------------------------------------------------

test("the alpha.3 → alpha.4 validator delta is exactly what T-F02 must absorb", () => {
  // Keyed by the validator's first title segment (e.g. "issuance_mint" from
  // "issuance_mint.issuance_mint.mint"), hashing compiledCode rather than
  // trusting titles — a title can survive while its bytes do not, and vice
  // versa (see the alpha.2/alpha.3 delta test above).
  const hashesByKey = (bp) => {
    const m = new Map();
    for (const v of bp.validators) {
      const key = v.title.split(".")[0];
      const hash = computeScriptHash(v.compiledCode);
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(hash);
    }
    return m;
  };

  const h3 = hashesByKey(load("blueprints/standard/v0.5.0-alpha.3/plutus.json"));
  const h4 = hashesByKey(load("blueprints/standard/v0.5.0-alpha.4/plutus.json"));

  const allKeys = new Set([...h3.keys(), ...h4.keys()]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of allKeys) {
    const s3 = h3.get(key);
    const s4 = h4.get(key);
    if (!s3) {
      added.push(key);
      continue;
    }
    if (!s4) {
      removed.push(key);
      continue;
    }
    const sameSet = s3.size === s4.size && [...s3].every((h) => s4.has(h));
    if (!sameSet) changed.push(key);
  }

  // Red first (proven manually, not left in the suite): dropping
  // "issuance_logic" from `added` below makes this assertion fail, because
  // the measured set really does contain it.
  assert.deepEqual(
    { added: added.sort(), removed: removed.sort(), changed: changed.sort() },
    {
      added: ["issuance_logic"],
      removed: [],
      changed: ["issuance_mint", "protocol_params", "upgrade_multisig"],
    },
    "the alpha.3 → alpha.4 validator surface moved differently than measured here — " +
      "if upstream's diff changed, the scope T-F02 must absorb changed with it, and someone must look",
  );
});
