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
 *
 * ⛔ AND IT IS NOT COVERAGE OF THE GATE. It is built from the alpha.2-shaped
 * v0.3.0 artefact, so it is ALSO missing required titles and exercises the
 * MISSING-TITLE path only. Keep it — the discriminating pair below is still
 * worth having — but read `LATER_WITH_EVERY_TITLE` for the gate itself.
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

test("F. the VENDORED alpha.3 blueprint is now diagnosed as EARLIER", () => {
  // In S-3 this asserted a LATER refusal. S-4 migrated the SDK to alpha.3 and
  // it INVERTED to an acceptance. T-F02 moves the target to alpha.4, so it
  // inverts once more — alpha.3 is now behind. Kept as ONE test through all
  // three states rather than deleted-and-rewritten, so each flip is visible in
  // the diff; that is the convention S-4 used one migration ago.
  const alpha3 = load("blueprints/standard/v0.5.0-alpha.3/plutus.json");
  assert.equal(alpha3.preamble.version, "0.5.0-alpha.3");
  assert.notEqual(alpha3.preamble.version, TARGET_PROTOCOL_VERSION, "alpha.4 IS the target now");

  const msg = messageOf(alpha3);
  assert.ok(msg, "alpha.3 is no longer the target and must be refused");
  assert.match(msg, /EARLIER CIP-113 protocol version/);
  assert.doesNotMatch(msg, /LATER/);
  assert.match(
    msg,
    /blueprints\/standard\/v0\.5\.0-alpha\.4\//,
    "must point at the alpha.4 blueprint directory",
  );
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
// alpha.4 — vendored by T-F01-1, and THE TARGET since T-F02-2.
//
// ⛔ WHAT THE GATE USED TO DO, kept because the repair is only legible beside
// the defect. `validateStandardBlueprint` computed `missing` and its FIRST
// statement after that was `if (missing.length === 0) return;`. Every version
// comparison lived below that line. So the function RETURNED SILENTLY for any
// blueprint whose required titles all happened to be present — including a
// strictly LATER one. alpha.4 retires no title this SDK requires, so `missing`
// was `[]` for alpha.4 exactly as for the correctly-accepted alpha.3, and an
// SDK targeting alpha.3 accepted an alpha.4 artefact it could not build
// against: wrong arities on `issuance_mint` and `upgrade_multisig`, and a
// validator it had no builder for at all.
//
// ⚠ The comparator was never the problem —
// `compareProtocolVersions("0.5.0-alpha.4", TARGET_PROTOCOL_VERSION)` returned
// 1 throughout. The gate simply never called it. This is the same defect class
// the file header warns about (symbol presence deciding the verdict), one level
// up in control flow: there it decided by throwing the wrong message, here by
// returning nothing at all.
//
// ⚠ AND THE EXISTING "newer" FIXTURE COULD NOT CATCH IT. `NEWER_WITH_SAME_SYMBOL`
// is built from the alpha.2-shaped v0.3.0 blueprint, which is ALSO missing
// titles — so it entered through the missing-title door and only ever proved
// the comparator. Test A above is the fixture that enters through the other
// door: every required title present, and refusable only by a gate that
// consults the preamble first. T-F01's worker measured that this test could not
// be written against the old control flow and escalated rather than routing
// around it; the comparison now runs FIRST, which is what makes it writable.
// ---------------------------------------------------------------------------

test("E. the VENDORED alpha.4 blueprint is now ACCEPTED — the flip", () => {
  // Nothing to invert here: no earlier test asserted anything about alpha.4's
  // acceptance, because under the old control flow it was accepted silently and
  // wrongly. This is a new assertion, and it is the §7f control for the whole
  // file — a gate that refuses everything is not a fixed gate.
  const alpha4 = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  assert.equal(alpha4.preamble.version, "0.5.0-alpha.4");
  assert.equal(alpha4.preamble.version, TARGET_PROTOCOL_VERSION, "alpha.4 IS the target now");
  assert.equal(validateStandardBlueprint(alpha4), undefined);
});

test("G. alpha.4 PARAMETER ARITY, read from the artefact", () => {
  // The delta pin below catches changed BYTES. This catches a changed ARITY,
  // which is a different failure and the one the builders encode: a validator
  // can keep its title and its compiled code can move without its parameter
  // list moving, and vice versa. An arity change is invisible to every title
  // check in blueprint.ts and produces a script that builds and hashes.
  const bp = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  const paramsOf = (title) => {
    const v = bp.validators.find((x) => x.title === title);
    assert.ok(v, `alpha.4 must declare ${title}`);
    return (v.parameters ?? []).map((p) => p.title);
  };

  assert.deepEqual(
    paramsOf("issuance_logic.issuance_logic.withdraw"),
    ["programmable_logic_base", "registry_node_cs", "params_policy", "max_inline_datum_bytes"],
    "issuance_logic takes FOUR parameters, and the two adjacent PolicyIds are in THIS order",
  );
  assert.deepEqual(
    paramsOf("issuance_mint.issuance_mint.mint"),
    ["minting_logic_cred", "params_policy"],
    "issuance_mint dropped to TWO in alpha.4 — it was four",
  );
  assert.deepEqual(
    paramsOf("upgrade_multisig.upgrade_multisig.withdraw"),
    ["utxo_ref"],
    "upgrade_multisig takes ONE parameter — its signers/threshold moved into a datum",
  );
});

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

// ---------------------------------------------------------------------------
// ⛔ THE GATE ITSELF — reachable in both directions, with EVERY title present
// ---------------------------------------------------------------------------

/**
 * The alpha.4 validator set relabelled as a version strictly ABOVE any target.
 *
 * ⛔ THIS FIXTURE ENTERS THROUGH THE DOOR `NEWER_WITH_SAME_SYMBOL` NEVER USED.
 * That one is built from the alpha.2-shaped v0.3.0 artefact, which is ALSO
 * missing required titles — so it reaches the version comparison through the
 * missing-title branch and proves only the comparator. This one declares every
 * title this SDK requires, so it can only be refused by a gate that consults
 * the preamble BEFORE it consults `missing`.
 *
 * It stays valid after the target flips precisely because it is built from the
 * TARGET-SHAPED artefact: whatever titles the target requires, this fixture has
 * them, and 0.9.9 stays ahead.
 */
const LATER_WITH_EVERY_TITLE = (() => {
  const bp = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  return { ...bp, preamble: { ...bp.preamble, version: "0.9.9" } };
})();

test("A. a strictly LATER blueprint with EVERY required title PRESENT is refused as LATER", () => {
  const msg = messageOf(LATER_WITH_EVERY_TITLE);

  assert.ok(msg, "a blueprint from a later protocol version must be refused");
  assert.match(msg, /LATER CIP-113 protocol version/);
  assert.match(msg, /not a stale or corrupt file/);
  assert.doesNotMatch(msg, /EARLIER/, "it is not earlier, and must never be called earlier");

  // ⚠ And it must not name a defect it did not find. Nothing is missing here,
  // so an empty "Missing required validator(s):" list would be the guard
  // reporting the wrong cause.
  assert.doesNotMatch(
    msg,
    /Missing required validator\(s\): \./,
    "an empty missing-validator list names a defect that is not present",
  );
});

test("B. the missing twin: EVERY title present, version BELOW the target, refused as EARLIER", () => {
  const bp = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  const msg = messageOf({ ...bp, preamble: { ...bp.preamble, version: "0.4.0" } });

  assert.ok(msg, "a blueprint from an earlier protocol version must be refused");
  assert.match(msg, /EARLIER CIP-113 protocol version/);
  assert.doesNotMatch(msg, /LATER/);
  assert.match(
    msg,
    new RegExp(`blueprints/standard/v${TARGET_PROTOCOL_VERSION.replace(/\./g, "\\.")}/`),
    "must point at the blueprint directory for the target",
  );

  // Same property test A asserts: nothing is missing here, so an empty
  // "Missing required validator(s):" list would name a defect that is absent.
  assert.doesNotMatch(
    msg,
    /Missing required validator\(s\): \./,
    "an empty missing-validator list names a defect that is not present",
  );
});

test("C. EVERY title present and an UNPARSEABLE version claims no direction", () => {
  const bp = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  const msg = messageOf({ ...bp, preamble: { ...bp.preamble, version: "not-a-version" } });

  assert.ok(msg, "a preamble that cannot be read cannot yield a verdict");
  assert.match(msg, /could not be parsed/);
  assert.doesNotMatch(msg, /EARLIER|LATER/, "must not claim a direction it cannot establish");

  // Same property test A asserts.
  assert.doesNotMatch(
    msg,
    /Missing required validator\(s\): \./,
    "an empty missing-validator list names a defect that is not present",
  );
});
