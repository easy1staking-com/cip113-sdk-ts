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
 * Validator titles that existed in earlier CIP-113 releases and are GONE.
 *
 * Kept so that loading an old blueprint produces a diagnosis instead of a bare
 * "missing required validator", which reads as a corrupt file rather than as
 * "this SDK no longer targets that protocol version".
 */
export const RETIRED_VALIDATORS: Record<string, string> = {
  "programmable_logic_global.programmable_logic_global.withdraw":
    "dissolved by upstream #110 — its transfer arm is now `transfer.transfer.withdraw`, " +
    "seize/clawback is `third_party.third_party.withdraw`, and unfracking is reached " +
    "directly by programmable_logic_base",
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
 * Validate that a blueprint contains all required standard validators.
 */
export function validateStandardBlueprint(blueprint: PlutusBlueprint): void {
  const titles = blueprint.validators.map((v) => v.title);
  const missing = Object.entries(STANDARD_VALIDATORS).filter(
    ([, title]) => !titles.includes(title)
  );
  if (missing.length === 0) return;

  const label = `${blueprint.preamble.title} v${blueprint.preamble.version}`;

  // If the blueprint carries a validator this SDK has retired, it is an OLD
  // protocol version, not a damaged file. Say so — otherwise the reader spends
  // the next hour looking for a corrupt artifact.
  const retired = titles.filter((t) => t in RETIRED_VALIDATORS);
  if (retired.length > 0) {
    throw new Error(
      `Blueprint "${label}" targets an earlier CIP-113 protocol version that this SDK no ` +
        `longer supports. It still declares ${retired.map((t) => `"${t}"`).join(", ")} — ` +
        retired.map((t) => RETIRED_VALIDATORS[t]).join("; ") +
        `. This SDK targets 0.5.0-alpha.2 (upstream 9db7e06); use a blueprint from ` +
        `blueprints/standard/v0.5.0-alpha.2/, or an SDK release pinned to the older contracts.`
    );
  }

  throw new Error(
    `Standard blueprint "${label}" is missing required validator(s): ` +
      missing.map(([name, title]) => `${name} (title: "${title}")`).join(", ") +
      `. Present titles: ${titles.join(", ")}`
  );
}
