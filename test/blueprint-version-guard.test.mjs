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
 * be judged on that string and nothing else. A test that only checked the old
 * direction would pass against the broken implementation.
 *
 * ⛔ WHAT 0.13.0 TOOK OUT OF EVERY ASSERTION IN THIS FILE, AND WHY IT IS NOT A
 * WEAKENING. The refusal used to say EARLIER or LATER, and upstream proved it
 * could not: `v0.0.1` is upstream's FIRST MAINNET RELEASE CANDIDATE and is
 * byte-identical to `0.5.0-alpha.5`, yet `0.0.1 < 0.5.0-alpha.5` under semver.
 * The newest artefact upstream has ever published compares as the oldest, so
 * every blueprint this repo ships was diagnosed as "LATER" and its holder told
 * to upgrade an SDK that was already ahead of them.
 *
 * ⇒ A version string orders releases only while its publisher keeps ONE series.
 * The gate is EQUALITY, so the ordering was never load-bearing — it was a
 * diagnostic nicety, and a nicety that can be confidently wrong is worse than
 * one that is absent. The refusal now names the blueprint's declared version,
 * names the SDK's target, and claims NO direction.
 *
 * ⚠ THE ASSERTIONS DID NOT GET LOOSER, THEY MOVED. Each test below that read
 * `/EARLIER|LATER/` now reads the two version strings it must name, which is
 * strictly more content than a single direction word: a message naming
 * "0.5.0-alpha.4" and "0.0.1" can only come from a gate that read the preamble.
 * `⛔ NO DIRECTION, EVER` at the foot of the file is the guard that fails if the
 * words come back.
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

/** A version string as a literal regex fragment. */
const esc = (v) => v.replace(/\./g, "\\.");

const messageOf = (bp) => {
  try {
    validateStandardBlueprint(bp);
    return null;
  } catch (e) {
    return e.message;
  }
};

test("THE DISCRIMINATING PAIR: same retired symbols, and the verdict still comes from the preamble", () => {
  const older = messageOf(OLD);
  const newer = messageOf(NEWER_WITH_SAME_SYMBOL);

  assert.ok(older, "an unusable blueprint must be refused");
  assert.ok(newer, "an unusable blueprint must be refused");

  // ⛔ WHAT THIS PAIR ASSERTED UNTIL 0.13.0, RECORDED RATHER THAN DELETED. It
  // demanded OPPOSITE verdicts — "EARLIER" for one, "LATER" for the other —
  // because that was the sharpest available proof that the DIRECTION came from
  // the preamble and not from the symbols, which are IDENTICAL across these two
  // fixtures. The refusal no longer claims a direction at all, so there is no
  // direction left to oppose.
  //
  // ⇒ THE PAIR'S PURPOSE IS INTACT, on a property that is still there and is
  // strictly more specific: each message QUOTES THE VERSION ITS OWN PREAMBLE
  // DECLARES. These two fixtures carry the same validator set, the same missing
  // titles and the same retired titles, and differ ONLY in that string — so an
  // implementation that read the SYMBOLS would emit the SAME message twice.
  assert.match(older, /It declares "0\.3\.0"/, "must quote the version this blueprint declares");
  assert.match(newer, /It declares "0\.9\.9"/, "must quote the version this blueprint declares");
  assert.notEqual(
    older,
    newer,
    "identical symbols, different preambles — two identical messages would mean the symbols decided",
  );

  // The original defect, restated for a gate that no longer has a direction to
  // get wrong: neither reader is told which of the two is newer.
  assert.doesNotMatch(older, /EARLIER|LATER/);
  assert.doesNotMatch(newer, /EARLIER|LATER/);

  // And the reader must still be told this is a MIGRATION GAP rather than a bad
  // file. "not a stale or corrupt file" was the old wording; the same fact is
  // now carried by the two-sided remedy — move the blueprint, or move the SDK.
  for (const msg of [older, newer]) {
    assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
    assert.match(
      msg,
      /an SDK release that targets/,
      "a version gap has two remedies and the message must offer both",
    );
  }
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

test("alpha.2 is refused BY VERSION, and the message names both — a real artifact, not a fixture", () => {
  // The SDK moved past it in S-4. It is still shipped, because a live preview
  // instance runs it, so this is the message a caller pointed at the old
  // blueprint will actually see.
  //
  // ⚠ It asserted "EARLIER" until 0.13.0. What replaces it is not a looser
  // check: the message must name "0.5.0-alpha.2" AND the target, which one
  // direction word never established.
  const msg = messageOf(load("blueprints/standard/v0.5.0-alpha.2/plutus.json"));
  assert.ok(msg, "alpha.2 is no longer the target and must be refused");
  assert.match(msg, /It declares "0\.5\.0-alpha\.2"/, "must name the version the artifact declares");
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");
});

// ---------------------------------------------------------------------------
// The real alpha.3 artifact — the case that exposed the defect
// ---------------------------------------------------------------------------

test("F. the VENDORED alpha.3 blueprint is refused, and the refusal names both versions", () => {
  // In S-3 this asserted a LATER refusal. S-4 migrated the SDK to alpha.3 and
  // it INVERTED to an acceptance. T-F02 moved the target to alpha.4 and it
  // inverted once more; T-D53 moved it to alpha.5. 0.13.0 moves it to 0.0.1 and
  // drops the direction word entirely. Kept as ONE test through all five states
  // rather than deleted-and-rewritten, so each flip is visible in the diff;
  // that is the convention S-4 used four migrations ago.
  const alpha3 = load("blueprints/standard/v0.5.0-alpha.3/plutus.json");
  assert.equal(alpha3.preamble.version, "0.5.0-alpha.3");
  assert.notEqual(
    alpha3.preamble.version,
    TARGET_PROTOCOL_VERSION,
    "0.0.1 IS the target now",
  );

  const msg = messageOf(alpha3);
  assert.ok(msg, "alpha.3 is no longer the target and must be refused");
  assert.match(msg, /It declares "0\.5\.0-alpha\.3"/, "must name the version the artifact declares");
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");
  // ⛔ DERIVED FROM THE CONSTANT, NOT SPELLED OUT. A literal directory here is
  // a second place the target version lives, and it went stale at this very
  // migration — the assertion read `alpha.4` while the SDK had moved to
  // alpha.5, and its message still said "must point at the alpha.4 directory".
  assert.match(
    msg,
    new RegExp(
      `blueprints/standard/v${TARGET_PROTOCOL_VERSION.replace(/\./g, "\\.")}/`,
    ),
    `must point at the v${TARGET_PROTOCOL_VERSION} blueprint directory`,
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

test("E. the VENDORED alpha.4 blueprint is refused ON THE PREAMBLE ALONE — the flip back", () => {
  // T-F01 wrote this as "alpha.4 is ACCEPTED", the §7f control proving the gate
  // does not refuse everything. T-D53 moved the target to alpha.5 and it
  // inverted, exactly as F did one release earlier; 0.13.0 moves the target to
  // 0.0.1 and takes the direction word out of the refusal. Kept as ONE test
  // through all three states so each flip is visible in the diff.
  //
  // ⛔ AND alpha.4 IS THE CASE WORTH KEEPING, because it is the one that
  // refuses on the PREAMBLE ALONE. Every required validator title is present —
  // alpha.5 added no title, removed none, and changed no arity — so a
  // symbol-based gate would accept it silently and build an alpha.4 genesis
  // transaction against alpha.5's rules. That transaction is refused by the
  // ledger for a reason naming neither version.
  const alpha4 = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  assert.equal(alpha4.preamble.version, "0.5.0-alpha.4");
  assert.notEqual(
    alpha4.preamble.version,
    TARGET_PROTOCOL_VERSION,
    "0.0.1 IS the target now",
  );

  const msg = messageOf(alpha4);
  assert.ok(msg, "alpha.4 is no longer the target and must be refused");
  assert.match(msg, /It declares "0\.5\.0-alpha\.4"/, "must name the version the artifact declares");
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");
  // The distinguishing clause: refused despite nothing being missing.
  assert.match(msg, /Every required validator title IS present/);
  assert.doesNotMatch(msg, /Missing required validator/);
});

test("E2. the VENDORED v0.0.1 blueprint is ACCEPTED and alpha.5 is not — the §7f control, and the relabel's edge", () => {
  // A gate that refuses everything is not a fixed gate. This is the one
  // acceptance in the file that names a real shipped artefact rather than the
  // target-derived path used by "the TARGET blueprint passes untouched", and it
  // is deliberately spelled out: the two would move together if the constant
  // itself were wrong.
  //
  // T-F01 wrote it on alpha.4, T-D53 flipped it to alpha.5, and 0.13.0 flips it
  // to v0.0.1 — kept as ONE test so the flip is visible in the diff.
  const v001 = load("blueprints/standard/v0.0.1/plutus.json");
  assert.equal(v001.preamble.version, "0.0.1");
  assert.equal(v001.preamble.version, TARGET_PROTOCOL_VERSION, "0.0.1 IS the target now");
  assert.equal(validateStandardBlueprint(v001), undefined);

  // ⛔ THE SHARPEST CASE IN THE FILE, AND IT IS NEW AT 0.13.0. alpha.5 is
  // BYTE-IDENTICAL to v0.0.1 — 34 validators, same compiledCode, same
  // definitions, same metadata; only `preamble.version` differs (measured in
  // `test/relabel-0.0.1.test.mjs`). It is nonetheless REFUSED, because the gate
  // is version EQUALITY and nothing else. That is the breaking half of the
  // 0.13.0 migration note stated as an assertion: identical bytes, refused at
  // `init`, while every derived hash is unchanged on chain.
  const alpha5 = load("blueprints/standard/v0.5.0-alpha.5/plutus.json");
  assert.deepEqual(
    alpha5.validators.map((v) => v.compiledCode),
    v001.validators.map((v) => v.compiledCode),
    "sanity: the refusal below must be about the version string and nothing else",
  );
  const msg = messageOf(alpha5);
  assert.ok(msg, "alpha.5 is no longer the target and must be refused despite identical bytes");
  assert.match(msg, /It declares "0\.5\.0-alpha\.5"/);
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");
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
    ["programmable_logic_base_cred", "registry_node_cs", "params_policy", "max_inline_datum_bytes"],
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

test("A. a blueprint ABOVE the target with EVERY required title PRESENT is refused on the PREAMBLE ALONE", () => {
  const msg = messageOf(LATER_WITH_EVERY_TITLE);

  // The fixture really is above the target — stated, not assumed, because the
  // whole point of this entrance is that `missing` is empty and the version is
  // the only thing left to refuse on.
  assert.ok(
    compareProtocolVersions("0.9.9", TARGET_PROTOCOL_VERSION) > 0,
    "the fixture must stay above the target or it enters through a different door",
  );

  assert.ok(msg, "a blueprint that is not at the target version must be refused");
  assert.match(msg, /It declares "0\.9\.9"/, "must name the version the blueprint declares");
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  // ⚠ The old assertion here was `/not a stale or corrupt file/`, and its
  // PURPOSE — tell the reader this is a migration gap rather than a bad file —
  // is carried now by the two-sided remedy plus the explicit "not a
  // missing-symbol failure" clause below. The phrase went; the reassurance did
  // not.
  assert.match(
    msg,
    /an SDK release that targets/,
    "a version gap has two remedies and the message must offer both",
  );
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");

  // ⚠ And it must not name a defect it did not find. Nothing is missing here,
  // so an empty "Missing required validator(s):" list would be the guard
  // reporting the wrong cause.
  assert.doesNotMatch(
    msg,
    /Missing required validator\(s\): \./,
    "an empty missing-validator list names a defect that is not present",
  );
});

test("B. the missing twin: EVERY title present, version BELOW the target, refused the SAME way", () => {
  // ⛔ THE FIXTURE'S LABEL MOVED AT 0.13.0 AND IT HAD TO. It was "0.4.0", chosen
  // when the target was an 0.5.0 prerelease. The target is now "0.0.1", so
  // "0.4.0" is ABOVE it — this twin would have quietly become a duplicate of
  // test A, entering through the same side and proving half of what it claims.
  // A fixture whose whole job is to sit on the other side of the target stops
  // doing that job silently, which is the hazard NEWER_WITH_SAME_SYMBOL's note
  // already records one door along.
  const BELOW = "0.0.0";
  assert.ok(
    compareProtocolVersions(BELOW, TARGET_PROTOCOL_VERSION) < 0,
    `${BELOW} must stay BELOW the target or this is test A with a different label`,
  );

  const bp = load("blueprints/standard/v0.5.0-alpha.4/plutus.json");
  const msg = messageOf({ ...bp, preamble: { ...bp.preamble, version: BELOW } });

  assert.ok(msg, "a blueprint that is not at the target version must be refused");
  // ⇒ The point of the twin, now that no direction is claimed: BOTH sides get
  // the SAME treatment, each naming its own declared version. Before 0.13.0
  // this asserted the opposite word from test A; the property that survives is
  // that the side of the target does not change the shape of the answer.
  assert.match(msg, new RegExp(`It declares "${esc(BELOW)}"`), "must name the declared version");
  assert.match(msg, new RegExp(`this SDK targets ${esc(TARGET_PROTOCOL_VERSION)}`));
  assert.doesNotMatch(msg, /EARLIER|LATER/, "the refusal claims no direction");
  assert.match(
    msg,
    new RegExp(`blueprints/standard/v${esc(TARGET_PROTOCOL_VERSION)}/`),
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

// ---------------------------------------------------------------------------
// ⛔ THE RULING, AS A GUARD: no refusal may claim a direction, ever again
// ---------------------------------------------------------------------------

/**
 * ⛔ WHY THIS IS A SWEEP AND NOT A LINE IN EACH TEST ABOVE. The tests above each
 * assert `doesNotMatch(/EARLIER|LATER/)` on ONE message, so a NEW refusal branch
 * added tomorrow — or an existing one reworded — is covered by none of them.
 * This one enumerates EVERY way `validateStandardBlueprint` can refuse and holds
 * all of them to the ruling at once.
 *
 * ⚠ ASSERTED AGAINST THE THROWN MESSAGE, NEVER AGAINST THE SOURCE TEXT. A grep
 * over `src/standard/blueprint.ts` would go red on the file's own COMMENTS,
 * which are required to say EARLIER and LATER — they record why the words left.
 * A guard that cannot tell the explanation from the defect is a guard nobody
 * keeps.
 */
test("⛔ NO DIRECTION, EVER: not one refusal message says EARLIER or LATER", () => {
  const relabel = (bp, version) => ({ ...bp, preamble: { ...bp.preamble, version } });
  const target = load(`blueprints/standard/v${TARGET_PROTOCOL_VERSION}/plutus.json`);

  const cases = [
    ["the vendored v0.3.0 artefact", OLD],
    ["the vendored alpha.2 artefact", load("blueprints/standard/v0.5.0-alpha.2/plutus.json")],
    ["the vendored alpha.3 artefact", load("blueprints/standard/v0.5.0-alpha.3/plutus.json")],
    ["the vendored alpha.4 artefact", load("blueprints/standard/v0.5.0-alpha.4/plutus.json")],
    [
      "the vendored alpha.5 artefact — byte-identical to the target, refused on its version string",
      load("blueprints/standard/v0.5.0-alpha.5/plutus.json"),
    ],
    ["every title present, version ABOVE the target", relabel(target, "0.9.9")],
    ["every title present, version BELOW the target", relabel(target, "0.0.0")],
    ["every title present, version UNPARSEABLE", relabel(target, "main")],
    ["the target version on an artefact that is missing titles", relabel(OLD, TARGET_PROTOCOL_VERSION)],
  ];

  const messages = [];
  for (const [what, bp] of cases) {
    const msg = messageOf(bp);

    // ⚠ NON-VACUITY, PER CASE. A case that stopped throwing would otherwise
    // satisfy every `doesNotMatch` below by having no message at all — the
    // exact shape of a guard that cannot fail.
    assert.ok(msg, `${what}: must be REFUSED — a case that does not throw proves nothing here`);

    assert.doesNotMatch(
      msg,
      /EARLIER|LATER/,
      `${what}: the refusal claims a direction again. Upstream restarted its version series, ` +
        `so the strings do not order its releases — see blueprint.ts and the 0.13.0 migration note`,
    );
    // The same ruling in lower case, so a reworded message cannot smuggle the
    // claim back past the two capitalised words.
    assert.doesNotMatch(
      msg,
      /\b(?:earlier|later|older|newer)\s+(?:CIP-113\s+)?protocol\s+version\b/i,
      `${what}: the refusal claims a direction in prose`,
    );

    // And the contract the direction word was replaced BY, asserted on every
    // path: both versions named, every time.
    assert.ok(
      msg.includes(bp.preamble.version),
      `${what}: must name the version the blueprint declares (${bp.preamble.version})`,
    );
    assert.ok(
      msg.includes(TARGET_PROTOCOL_VERSION),
      `${what}: must name the version this SDK targets`,
    );
    messages.push(msg);
  }

  assert.equal(messages.length, 9, "every refusal path must stay enumerated here");

  // ⚠ THE SWEEP MUST REACH MORE THAN ONE BRANCH. All nine messages coming out
  // of a single `throw` would satisfy everything above while testing one line.
  const distinct = new Set(
    messages.map((m) =>
      /could not be parsed/.test(m)
        ? "unparseable"
        : /does not match its own version string/.test(m)
          ? "artefact-mismatch"
          : "version-mismatch",
    ),
  );
  assert.deepEqual(
    [...distinct].sort(),
    ["artefact-mismatch", "unparseable", "version-mismatch"],
    "the sweep must exercise all three refusal branches, or it speaks for only one",
  );
});
