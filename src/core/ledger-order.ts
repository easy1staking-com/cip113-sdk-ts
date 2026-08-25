/**
 * Ledger ordering, and the redeemer indices that depend on it.
 *
 * CIP-113 0.5.0-alpha.2 moved several lookups from "scan the transaction" to
 * "the builder tells the validator where to look". That is cheaper on chain and
 * strictly more dangerous off it: an index is a plain integer, so a wrong one
 * typechecks, encodes, builds, and fails ONLY when the ledger runs the script.
 * Nothing in this repository's other guards can see it.
 *
 * Two orderings matter, and they are NOT the same rule.
 *
 * --- Reference inputs -----------------------------------------------------
 *
 * Ordered by (transaction id, output index): bytewise on the id, then numeric
 * on the index. `params_idx` is the protocol-params UTxO's position in that
 * ordering, over the COMPLETE reference-input set.
 *
 * --- Withdrawals ----------------------------------------------------------
 *
 * NOT bytewise on the reward address, and NOT insertion order.
 *
 * EVERY SCRIPT CREDENTIAL SORTS BEFORE EVERY KEY CREDENTIAL, then bytewise by
 * hash within each kind. The reason is a Haskell detail with an on-chain
 * consequence: cardano-ledger's `Credential` is
 *
 *     data Credential kr c = ScriptHashObj !(ScriptHash c) | KeyHashObj !(KeyHash kr c)
 *
 * with a derived `Ord`, and a derived `Ord` on a sum type compares constructor
 * position first. `ScriptHashObj` is declared first, so it sorts first. The
 * withdrawals map is keyed by `RewardAccount`, which orders by network then
 * credential, and Plutus hands the script that map in that order.
 *
 * ⚠ THIS IS THE OPPOSITE OF WHAT THE SERIALISED BYTES SUGGEST, which is the
 * trap. A reward account's header byte encodes key-stake as 0xE0|network and
 * script-stake as 0xF0|network, so sorting the ENCODED addresses puts key
 * credentials first — the exact reverse of the order the script sees. Deriving
 * this ordering from the wire format is a natural mistake that produces a
 * `wdrl_idx` that is wrong only when both kinds are present.
 *
 * PROVENANCE: DERIVED from cardano-ledger's constructor order and corroborated
 * by upstream's own integration guide (documentation/09 › Withdrawal indices),
 * which cites the same `Ord` derivation. NOT yet OBSERVED on chain by us — that
 * happens in T-D08, and until then this is reasoned, not booted.
 */

import { Data } from "@evolution-sdk/evolution";
import type { HexString, ScriptHash, TxInput } from "../types.js";

// ---------------------------------------------------------------------------
// Reference inputs
// ---------------------------------------------------------------------------

/**
 * Compare two hex strings as the bytes they encode.
 *
 * Two separate things are going on here; only one of them was a live bug.
 *
 * CASE NORMALISATION — this one was real. Hex case is presentation: a tx id is
 * bytes, and providers differ on which spelling they hand you. Comparing raw
 * strings makes "ab…" and "AB…" neither equal nor consistently ordered, so one
 * reference input can occupy two different positions depending on who fetched
 * it. MEASURED: `localeCompare` orders "0a" BEFORE "0A" while the bytes order
 * it after, so the two disagree in direction, not merely in strictness.
 *
 * NOT `localeCompare` — this one is defensive. It is a collation comparison,
 * not a byte comparison. MEASURED in this environment: over all 240 ordered
 * pairs of lowercase hex digits it agrees with byte order exactly, so replacing
 * it changes nothing observable HERE. It is avoided because that agreement is a
 * property of the current ICU data rather than of the language, and because the
 * only failure mode of getting it wrong is a transaction that fails on chain.
 * Upstream's sample code (documentation/09) uses `localeCompare` on unnormalised
 * hex and therefore carries the case bug.
 */
function compareHex(a: HexString, b: HexString): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ledger order for transaction inputs: by tx id, then by output index. */
export function compareTxInputs(a: TxInput, b: TxInput): number {
  const h = compareHex(a.txHash, b.txHash);
  return h !== 0 ? h : a.outputIndex - b.outputIndex;
}

/**
 * Position of `target` in the ledger-sorted reference inputs.
 *
 * Throws rather than returning -1: a missing reference input is a builder bug,
 * and -1 encodes as a valid integer that fails obscurely on chain.
 */
export function referenceInputIndexOf(
  all: readonly TxInput[],
  target: TxInput
): number {
  const idx = [...all]
    .sort(compareTxInputs)
    .findIndex((i) => compareTxInputs(i, target) === 0);
  if (idx < 0) {
    throw new Error(
      `Reference input ${target.txHash}#${target.outputIndex} is not in the reference-input ` +
        `set (${all.length} entries). The index must be computed over the COMPLETE set, ` +
        `after the builder has added every reference input.`
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export interface WithdrawalKey {
  /** 28-byte credential hash, hex. */
  hash: HexString;
  /** true = script credential, false = verification-key credential. */
  isScript: boolean;
}

/** Ledger order: every script credential before every key credential. */
export function compareWithdrawalKeys(a: WithdrawalKey, b: WithdrawalKey): number {
  if (a.isScript !== b.isScript) return a.isScript ? -1 : 1;
  return compareHex(a.hash, b.hash);
}

/** Sort withdrawal keys into the order the script sees. Does not mutate. */
export function sortWithdrawalKeys(keys: readonly WithdrawalKey[]): WithdrawalKey[] {
  return [...keys].sort(compareWithdrawalKeys);
}

/**
 * Position of `target` in the ledger-ordered withdrawal map.
 *
 * `all` MUST be the complete withdrawal set of the final transaction. Any extra
 * withdrawal — a second substandard script, or a key-hash reward withdrawal a
 * wallet adds during balancing — occupies a slot and shifts every position
 * after it. Compute this last.
 */
export function withdrawalIndexOf(
  all: readonly WithdrawalKey[],
  target: WithdrawalKey
): number {
  const idx = sortWithdrawalKeys(all).findIndex(
    (w) => compareWithdrawalKeys(w, target) === 0
  );
  if (idx < 0) {
    throw new Error(
      `Withdrawal ${target.isScript ? "script" : "key"} credential ${target.hash} is not in ` +
        `the withdrawal set (${all.length} entries). programmable_logic_base resolves the ` +
        `entry at wdrl_idx and requires it to equal the delegate credential from the ` +
        `protocol-params datum, so a missing entry cannot authorise anything.`
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// BaseSpendRedeemer — programmable_logic_base.spend
// ---------------------------------------------------------------------------

/**
 * Which delegate programmable_logic_base dispatches to.
 *
 * Constructor indices are the on-chain contract: 0/1/2. Exactly one framework
 * delegate may be invoked per transaction.
 */
export const BaseSpendVia = {
  TRANSFER: 0n,
  THIRD_PARTY: 1n,
  UNFRACKING: 2n,
} as const;

export type BaseSpendVariant = keyof typeof BaseSpendVia;

/**
 * Build a BaseSpendRedeemer.
 *
 * Replaces the untyped redeemer of 0.3.x and the bare `Int` of #109. Every
 * programmable_logic_base input in the transaction needs one.
 */
export function baseSpendRedeemer(
  via: BaseSpendVariant,
  paramsIdx: number,
  wdrlIdx: number
): Data.Data {
  if (!Number.isInteger(paramsIdx) || paramsIdx < 0) {
    throw new Error(`baseSpendRedeemer: params_idx must be a non-negative integer, got ${paramsIdx}`);
  }
  if (!Number.isInteger(wdrlIdx) || wdrlIdx < 0) {
    throw new Error(`baseSpendRedeemer: wdrl_idx must be a non-negative integer, got ${wdrlIdx}`);
  }
  return Data.constr(BaseSpendVia[via], [
    Data.int(BigInt(paramsIdx)),
    Data.int(BigInt(wdrlIdx)),
  ]);
}

// ---------------------------------------------------------------------------
// Delegate redeemers
// ---------------------------------------------------------------------------

export interface RegistryProofRef {
  type: "exists" | "not-exists";
  nodeIdx: number;
}

/**
 * `transfer`'s TransferRedeemer { params_idx, proofs }.
 *
 * Single constructor 0, same field order as the old `TransferAct` with
 * `params_idx` prepended — so an old encoder's output is NOT compatible.
 */
export function transferRedeemer(
  paramsIdx: number,
  proofs: readonly RegistryProofRef[]
): Data.Data {
  return Data.constr(0n, [
    Data.int(BigInt(paramsIdx)),
    Data.list(
      proofs.map((p) =>
        Data.constr(p.type === "exists" ? 0n : 1n, [Data.int(BigInt(p.nodeIdx))])
      )
    ),
  ]);
}

/** `third_party`'s ThirdPartyRedeemer { params_idx, registry_node_idx, outputs_start_idx }. */
export function thirdPartyRedeemer(
  paramsIdx: number,
  registryNodeIdx: number,
  outputsStartIdx: number
): Data.Data {
  return Data.constr(0n, [
    Data.int(BigInt(paramsIdx)),
    Data.int(BigInt(registryNodeIdx)),
    Data.int(BigInt(outputsStartIdx)),
  ]);
}

/** `unfracking`'s UnfrackingRedeemer { params_idx, registry_node_idx, outputs_start_idx }. */
export function unfrackingRedeemer(
  paramsIdx: number,
  registryNodeIdx: number,
  outputsStartIdx: number
): Data.Data {
  return Data.constr(0n, [
    Data.int(BigInt(paramsIdx)),
    Data.int(BigInt(registryNodeIdx)),
    Data.int(BigInt(outputsStartIdx)),
  ]);
}
