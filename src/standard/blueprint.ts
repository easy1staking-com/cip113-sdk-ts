/**
 * Blueprint loading and validator lookup.
 */

import type { PlutusBlueprint, BlueprintValidator, HexString } from "../types.js";

/**
 * Standard validator titles as they appear in the blueprint.
 *
 * Targets CIP-113 0.5.0-alpha.4 (upstream commit d37ca8d). See PLAN.md D-11.
 *
 * --- What alpha.4 moved --------------------------------------------------
 *
 * ADDITIONS ONLY, at the level of titles: 28 -> 34 handlers, and no title this
 * SDK requires was retired. What DID move is arity — `issuance_mint` went from
 * four parameters to two, `upgrade_multisig` from `(signers, threshold)` to a
 * single `utxo_ref` — plus one new validator, `issuance_logic`. An arity change
 * is invisible to every title check in this file; see `src/standard/scripts.ts`
 * for the builders that encode it and `test/blueprint-version-guard.test.mjs`
 * for the pin that catches upstream moving it again.
 *
 * --- Do not read upstream's CONTRACT_SURFACE_CHANGES.md for these ---------
 *
 * That document contains an SDK impact map naming this repository by path, and
 * it has been WRONG about this repository twice. Once about the params datum in
 * a way that produces malformed transactions (it said 6 fields; the artifact
 * had 7, and one line was phrased as an instruction to build the 6-field
 * shape). Every title, arity and field order here comes from the blueprint
 * itself. See PLAN.md, W-D hazard box.
 */
export const STANDARD_VALIDATORS = {
  ALWAYS_FAIL: "always_fail.always_fail.spend",

  /**
   * ⚑ ONE HASH FOR POLICY *AND* ADDRESS. `protocol_params_mint` and
   * `protocol_params_spend` merged into one multi-purpose validator (#118), so
   * the params-NFT policy id and the params address's payment credential are
   * now THE SAME VALUE. Two derivations that used to be independently correct
   * are one; deriving them separately yields a valid-looking address that holds
   * nothing.
   */
  PROTOCOL_PARAMS: "protocol_params.protocol_params.mint",

  PROGRAMMABLE_LOGIC_BASE: "programmable_logic_base.programmable_logic_base.spend",
  ISSUANCE_CBOR_HEX_MINT: "issuance_cbor_hex_mint.issuance_cbor_hex_mint.mint",
  ISSUANCE_MINT: "issuance_mint.issuance_mint.mint",

  /** ⚑ ONE HASH FOR POLICY *AND* ADDRESS — same merge as PROTOCOL_PARAMS (#117). */
  REGISTRY: "registry.registry.mint",

  /**
   * The dispatcher, REINTRODUCED by #117 after #110 dissolved it.
   *
   * ⚠ Its title is identical to the one 0.3.x used, and its ROLE is not: it
   * carries the three delegate hashes as compile-time parameters and every
   * programmable transaction now withdraws through it. Do not read its presence
   * as evidence of any protocol version — see RETIRED_VALIDATORS.
   */
  PROGRAMMABLE_LOGIC_GLOBAL: "programmable_logic_global.programmable_logic_global.withdraw",

  /** Withdraw-0 delegates. Arity 1 -> 3 in alpha.3; the titles did not change. */
  TRANSFER: "transfer.transfer.withdraw",
  THIRD_PARTY: "third_party.third_party.withdraw",
  UNFRACKING: "unfracking.unfracking.withdraw",

  /** Reference upgrade authority; the initial `upgrade_cred` target. Withdraw-0. */
  UPGRADE_MULTISIG: "upgrade_multisig.upgrade_multisig.withdraw",

  /**
   * `issuance_logic` — NEW in alpha.4, and the replaceable half of issuance.
   *
   * The params datum's FIELD 1 names its credential (see
   * `ProgrammableLogicGlobalParams.issuanceLogicCred`), and `issuance_mint`
   * dispatches to whatever that field says — so this validator's withdraw-0
   * rides on EVERY mint and EVERY burn.
   *
   * ⚠ Its credential must be REGISTERED before it can withdraw. An unregistered
   * stake credential does not fail with "not registered"; the ledger reports
   * code 3141, *"rewards withdrawals must consume rewards in full"*, which
   * reads as a balance problem. That is how S-11 lost an afternoon on the
   * dispatcher.
   */
  ISSUANCE_LOGIC: "issuance_logic.issuance_logic.withdraw",
} as const;

/**
 * The protocol version this SDK builds transactions for.
 *
 * ⚠ SINGLE SOURCE OF TRUTH for the version verdict. A migration flips this one
 * constant; nothing else should encode a target version.
 */
export const TARGET_PROTOCOL_VERSION = "0.5.0-alpha.4";

/** Upstream commit the target version's blueprint was built from. */
export const TARGET_PROTOCOL_COMMIT = "d37ca8d";

/**
 * Validator titles that existed in an ADJACENT CIP-113 release and are absent
 * from the target one.
 *
 * ⛔ THESE ARE HINTS, NEVER A VERSION VERDICT, AND THE DISTINCTION IS THE WHOLE
 * POINT OF THIS BLOCK. This map used to DRIVE the diagnosis: any present title
 * appearing here meant "an EARLIER protocol version". That inference is unsound,
 * and it broke the first time it was tested against reality —
 * `programmable_logic_global` was dissolved by upstream #110 and then
 * REINTRODUCED by #117 as the PLG dispatcher, so a blueprint strictly NEWER
 * than the target was reported as too OLD, sending the reader to hunt for a
 * stale checkout.
 *
 * A symbol's absence tells you nothing about direction, because a symbol can
 * come back. The version comes from the PREAMBLE; these strings only add colour
 * once the direction is already known.
 *
 * ⚠ ALPHA.4 ADDS NOTHING HERE, and that is measured rather than assumed: no
 * alpha.3 title is absent from alpha.4 (28 -> 34 handlers, additions only; the
 * delta is pinned in `test/blueprint-version-guard.test.mjs`). Do not add
 * speculative entries — a title listed here that is also required makes the
 * guard contradict itself, which is the original defect's exact shape.
 */
export const RETIRED_VALIDATORS: Record<string, string> = {
  "protocol_params_mint.protocol_params_mint.mint":
    "merged with protocol_params_spend into `protocol_params` by upstream #118 — one validator, " +
    "one hash serving as BOTH the params-NFT policy id and the params address's payment credential",
  "protocol_params_spend.protocol_params_spend.spend":
    "merged into `protocol_params` by upstream #118 (it was itself the #117 rename of " +
    "`coordination_spend`)",
  "coordination_spend.coordination_spend.spend":
    "renamed `protocol_params_spend` by upstream #117, then merged into `protocol_params` by #118",
  "registry_mint.registry_mint.mint":
    "merged with registry_spend into `registry` by upstream #117 — one validator, one hash serving " +
    "as BOTH the registry-node policy id and the node address's payment credential",
  "registry_spend.registry_spend.spend":
    "merged into `registry` by upstream #117",
};

/**
 * Get a validator's compiled code from a blueprint by title.
 * Throws if the validator is not found.
 */
export function getValidatorCode(
  blueprint: PlutusBlueprint,
  title: string
): HexString {
  const validator = blueprint.validators.find((v) => v.title === title);
  if (!validator) {
    throw new Error(
      `Validator "${title}" not found in blueprint "${blueprint.preamble.title} v${blueprint.preamble.version}"`
    );
  }
  return validator.compiledCode;
}

/**
 * Get a validator's un-parameterised script hash from a blueprint by title.
 * This is the hash Aiken stamps in plutus.json — what CIP-171 verifiers
 * reproduce by compiling the source repo at the named commit.
 */
export function getValidatorHash(
  blueprint: PlutusBlueprint,
  title: string
): HexString {
  return getValidator(blueprint, title).hash;
}

/**
 * Get a validator entry from a blueprint by title.
 */
export function getValidator(
  blueprint: PlutusBlueprint,
  title: string
): BlueprintValidator {
  const validator = blueprint.validators.find((v) => v.title === title);
  if (!validator) {
    throw new Error(
      `Validator "${title}" not found in blueprint "${blueprint.preamble.title} v${blueprint.preamble.version}"`
    );
  }
  return validator;
}

/**
 * Compare two semver-ish version strings.
 *
 * Returns a negative number if `a < b`, positive if `a > b`, 0 if equal, and
 * `null` if either string cannot be parsed.
 *
 * ⛔ `null` IS A REAL ANSWER AND MUST NOT BE COERCED TO 0. "I cannot tell which
 * is newer" and "they are the same" are different facts, and collapsing them is
 * how a guard starts reporting a confident direction it never established.
 *
 * Prerelease handling follows semver: a version WITH a prerelease tag sorts
 * BELOW the same core version without one (`0.5.0-alpha.2` < `0.5.0`), and tags
 * compare identifier by identifier, numerically where both sides are numeric.
 * That last rule is what orders `alpha.2` before `alpha.10` — a plain string
 * compare puts them the other way round.
 */
export function compareProtocolVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      v.trim()
    );
    if (!m) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
      pre: m[4] === undefined ? null : m[4].split("."),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d;
  }
  // No prerelease outranks any prerelease.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;

  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      // Numeric identifiers always sort below alphanumeric ones.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Validate that a blueprint contains all required standard validators.
 *
 * ⛔ THE VERSION VERDICT COMES FROM THE PREAMBLE, NEVER FROM WHICH SYMBOLS ARE
 * PRESENT. The first implementation inferred "this blueprint is OLDER" from the
 * presence of any retired validator title, and reality broke it on first
 * contact: `programmable_logic_global` was removed by upstream #110 and brought
 * BACK by #117 in a new role, so 0.5.0-alpha.3 — strictly newer than the target
 * — was reported as "an earlier protocol version that this SDK no longer
 * supports". The guard fired correctly and named the wrong cause, which is
 * worse than not firing: it sends the reader to look for a stale checkout.
 *
 * A symbol can come back. A version number cannot go backwards.
 *
 * ⛔⛔ AND THE SAME DEFECT CLASS SURVIVED ONE LEVEL UP IN CONTROL FLOW, WHICH IS
 * WHAT THIS ORDERING FIXES. The version comparison used to sit BELOW an early
 * `if (missing.length === 0) return;`, so symbol presence still decided the
 * verdict — it just decided it by returning silently instead of by throwing.
 * alpha.4 retires no title this SDK requires, so a strictly LATER blueprint
 * produced `missing: []` and was ACCEPTED, while
 * `compareProtocolVersions("0.5.0-alpha.4", TARGET_PROTOCOL_VERSION)` was
 * returning `1` the whole time. The comparator was correct; the gate never
 * called it.
 *
 * ⚠ The file's own "newer" fixture could not catch that, and the reason
 * generalises: `NEWER_WITH_SAME_SYMBOL` is built from the alpha.2-shaped v0.3.0
 * artefact, which is ALSO missing titles — so it entered through the
 * missing-title door and only ever exercised the comparator. A fixture that
 * reaches a branch by the wrong route proves nothing about the route that
 * matters.
 *
 * ⇒ THE ORDER BELOW IS LOAD-BEARING: preamble verdict first, `missing` second.
 * Every case that reaches the `missing` branch has already been established to
 * be AT the target version.
 */
export function validateStandardBlueprint(blueprint: PlutusBlueprint): void {
  const titles = blueprint.validators.map((v) => v.title);
  const missing = Object.entries(STANDARD_VALIDATORS).filter(
    ([, title]) => !titles.includes(title)
  );

  const version = blueprint.preamble.version;
  const label = `${blueprint.preamble.title} v${version}`;

  // ⚠ `detail` must stay honest in BOTH cases. Emitting
  // "Missing required validator(s): ." with an empty list would be a guard
  // naming a defect it did not find — the same failure mode as reporting a
  // direction the comparator never established.
  const detail =
    missing.length > 0
      ? `Missing required validator(s): ` +
        missing.map(([name, title]) => `${name} (title: "${title}")`).join(", ") + `.`
      : `Every required validator title IS present, which is exactly why this is not a ` +
        `missing-symbol failure: the PROTOCOL VERSION ITSELF is the mismatch.`;

  // Hints, added only once direction is known from the preamble — never used to
  // decide it. See RETIRED_VALIDATORS.
  const retired = titles.filter((t) => t in RETIRED_VALIDATORS);
  const hint =
    retired.length > 0
      ? ` It declares ${retired.map((t) => `"${t}"`).join(", ")} — ` +
        retired.map((t) => RETIRED_VALIDATORS[t]).join("; ") + `.`
      : "";

  const cmp = compareProtocolVersions(version, TARGET_PROTOCOL_VERSION);

  // ⛔ THE RULING ON AN UNPARSEABLE PREAMBLE, AND THE REASON, so nobody relaxes
  // it back. This file's doctrine is that the verdict comes from the preamble;
  // a preamble that cannot be read therefore cannot yield a verdict, and
  // accepting-because-the-symbols-look-right is the precise defect fixed above.
  // So an unreadable version is refused EVEN WHEN EVERY REQUIRED TITLE IS
  // PRESENT.
  //
  // ACCEPTED CONSEQUENCE: a fork carrying a non-semver version string ("main",
  // "2026-09-10", a git describe) is now refused. It is refused LOUDLY and the
  // message names the remedy, which is the trade being made — a fork that wants
  // to be usable gives its preamble a semver-parseable version.
  if (cmp === null) {
    throw new Error(
      `Standard blueprint "${label}" cannot be used: its preamble version could not be ` +
        `parsed, so this SDK cannot establish whether it is behind or ahead of the target ` +
        `${TARGET_PROTOCOL_VERSION} (upstream ${TARGET_PROTOCOL_COMMIT}), and a verdict this ` +
        `SDK cannot establish is not one it will guess. ${detail}${hint} ` +
        `Give the blueprint a semver-parseable preamble version (e.g. "${TARGET_PROTOCOL_VERSION}"), ` +
        `or use one from blueprints/standard/v${TARGET_PROTOCOL_VERSION}/. ` +
        `Present titles: ${titles.join(", ")}`
    );
  }

  if (cmp < 0) {
    throw new Error(
      `Blueprint "${label}" targets an EARLIER CIP-113 protocol version than this SDK ` +
        `supports (target ${TARGET_PROTOCOL_VERSION}, upstream ${TARGET_PROTOCOL_COMMIT}). ` +
        `${detail}${hint} Use a blueprint from blueprints/standard/v${TARGET_PROTOCOL_VERSION}/, ` +
        `or an SDK release pinned to the older contracts.`
    );
  }

  if (cmp > 0) {
    throw new Error(
      `Blueprint "${label}" targets a LATER CIP-113 protocol version than this SDK supports ` +
        `(target ${TARGET_PROTOCOL_VERSION}, upstream ${TARGET_PROTOCOL_COMMIT}). This is not a ` +
        `stale or corrupt file — the SDK has not been migrated to it yet. ${detail}${hint} ` +
        `Upgrade the SDK, or pin the blueprint to v${TARGET_PROTOCOL_VERSION}.`
    );
  }

  // At the target version, with every required title present: usable.
  if (missing.length === 0) return;

  // Same version, still missing validators: the artifact does not match what
  // this version is supposed to contain. Neither older nor newer explains it.
  throw new Error(
    `Standard blueprint "${label}" declares this SDK's target version ` +
      `(${TARGET_PROTOCOL_VERSION}) but does not contain the validators that version should ` +
      `have — the artifact does not match its own version string. ${detail}${hint} ` +
      `Present titles: ${titles.join(", ")}`
  );
}
