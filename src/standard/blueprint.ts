/**
 * Blueprint loading and validator lookup.
 */

import type { PlutusBlueprint, BlueprintValidator, HexString } from "../types.js";

/**
 * Standard validator titles as they appear in the blueprint.
 *
 * Targets CIP-113 0.5.0-alpha.2 (upstream commit 9db7e06). See PLAN.md D-11.
 *
 * --- The dissolution of programmable_logic_global ------------------------
 *
 * Upstream #110 dissolved the PLG coordinator. Its transfer arm was RENAMED
 * `transfer`; third-party (seize/clawback) logic moved to a new standalone
 * `third_party`; `unfracking` is no longer reached through it. Instead
 * `programmable_logic_base` dispatches straight to one of the three.
 *
 * The practical consequence for this table: the title
 * `programmable_logic_global.programmable_logic_global.withdraw` NO LONGER
 * EXISTS in any 0.5.x blueprint. Its removal is why validateStandardBlueprint()
 * fails closed on the new artifact rather than silently building transactions
 * against a validator that is not there — the loud failure is deliberate and
 * must not be "fixed" by relaxing the check.
 *
 * --- Do not read upstream's CONTRACT_SURFACE_CHANGES.md for these ---------
 *
 * That document contains an SDK impact map naming this repository by path, and
 * it is WRONG about the params datum in a way that produces malformed
 * transactions (it says 6 fields; the artifact has 7, and one line is phrased
 * as an instruction to build the 6-field shape). Every title, arity and field
 * order here comes from the blueprint itself. See PLAN.md, W-D hazard box.
 */
export const STANDARD_VALIDATORS = {
  ALWAYS_FAIL: "always_fail.always_fail.spend",
  PROTOCOL_PARAMS_MINT: "protocol_params_mint.protocol_params_mint.mint",
  PROGRAMMABLE_LOGIC_BASE: "programmable_logic_base.programmable_logic_base.spend",
  ISSUANCE_CBOR_HEX_MINT: "issuance_cbor_hex_mint.issuance_cbor_hex_mint.mint",
  ISSUANCE_MINT: "issuance_mint.issuance_mint.mint",
  REGISTRY_MINT: "registry_mint.registry_mint.mint",
  REGISTRY_SPEND: "registry_spend.registry_spend.spend",

  /** PLG's transfer arm, renamed by #110. Withdraw-0. */
  TRANSFER: "transfer.transfer.withdraw",
  /** Seize / clawback, split out of PLG by #110. Withdraw-0. */
  THIRD_PARTY: "third_party.third_party.withdraw",
  /** Now dispatched to directly by PLB, with no PLG hop. Withdraw-0. */
  UNFRACKING: "unfracking.unfracking.withdraw",
  /** Holds the coordination UTxO — the live protocol wiring. Spend. */
  COORDINATION_SPEND: "coordination_spend.coordination_spend.spend",
  /** Reference upgrade authority; the initial `upgrade_cred` target. Withdraw-0. */
  UPGRADE_MULTISIG: "upgrade_multisig.upgrade_multisig.withdraw",
} as const;

/**
 * The protocol version this SDK builds transactions for.
 *
 * ⚠ SINGLE SOURCE OF TRUTH for the version verdict. A migration flips this one
 * constant; nothing else should encode a target version.
 */
export const TARGET_PROTOCOL_VERSION = "0.5.0-alpha.2";

/** Upstream commit the target version's blueprint was built from. */
export const TARGET_PROTOCOL_COMMIT = "9db7e06";

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
 */
export const RETIRED_VALIDATORS: Record<string, string> = {
  "programmable_logic_global.programmable_logic_global.withdraw":
    "dissolved by upstream #110 — its transfer arm became `transfer.transfer.withdraw`, " +
    "seize/clawback `third_party.third_party.withdraw`, and unfracking is reached " +
    "directly by programmable_logic_base. ⚠ REINTRODUCED by #117 as the PLG dispatcher, " +
    "so its presence alone does NOT date a blueprint in either direction",
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
 * PRESENT. The previous implementation inferred "this blueprint is OLDER" from
 * the presence of any retired validator title, and reality broke it on first
 * contact: `programmable_logic_global` was removed by upstream #110 and brought
 * BACK by #117 in a new role, so 0.5.0-alpha.3 — strictly newer than the target
 * — was reported as "an earlier protocol version that this SDK no longer
 * supports". The guard fired correctly and named the wrong cause, which is worse
 * than not firing: it sends the reader to look for a stale checkout.
 *
 * A symbol can come back. A version number cannot go backwards.
 */
export function validateStandardBlueprint(blueprint: PlutusBlueprint): void {
  const titles = blueprint.validators.map((v) => v.title);
  const missing = Object.entries(STANDARD_VALIDATORS).filter(
    ([, title]) => !titles.includes(title)
  );
  if (missing.length === 0) return;

  const version = blueprint.preamble.version;
  const label = `${blueprint.preamble.title} v${version}`;
  const detail =
    `Missing required validator(s): ` +
    missing.map(([name, title]) => `${name} (title: "${title}")`).join(", ") + `.`;

  // Hints, added only once direction is known from the preamble — never used to
  // decide it. See RETIRED_VALIDATORS.
  const retired = titles.filter((t) => t in RETIRED_VALIDATORS);
  const hint =
    retired.length > 0
      ? ` It declares ${retired.map((t) => `"${t}"`).join(", ")} — ` +
        retired.map((t) => RETIRED_VALIDATORS[t]).join("; ") + `.`
      : "";

  const cmp = compareProtocolVersions(version, TARGET_PROTOCOL_VERSION);

  if (cmp === null) {
    throw new Error(
      `Standard blueprint "${label}" is not usable by this SDK, and its version string ` +
        `could not be parsed, so this SDK cannot say whether it is older or newer than the ` +
        `target ${TARGET_PROTOCOL_VERSION} (upstream ${TARGET_PROTOCOL_COMMIT}). ${detail}${hint} ` +
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

  // Same version, still missing validators: the artifact does not match what
  // this version is supposed to contain. Neither older nor newer explains it.
  throw new Error(
    `Standard blueprint "${label}" declares this SDK's target version ` +
      `(${TARGET_PROTOCOL_VERSION}) but does not contain the validators that version should ` +
      `have — the artifact does not match its own version string. ${detail}${hint} ` +
      `Present titles: ${titles.join(", ")}`
  );
}
