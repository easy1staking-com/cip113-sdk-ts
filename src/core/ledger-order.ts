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

/**
 * The withdrawal plan for a programmable-token transaction.
 *
 * ⛔ EXISTS TO MAKE THE DISPATCHER UNFORGETTABLE. alpha.3 adds one withdraw-0 to
 * EVERY programmable transaction — the dispatcher's — and `programmable_logic_base`
 * resolves `wdrl_idx` against it. Omitting it from the set does not produce a
 * missing-withdrawal error: it produces a set that is one entry short, so every
 * index computed from it is wrong by one or more, and the failure surfaces as a
 * credential-equality mismatch that names nothing.
 *
 * You cannot get `plgIdx` without having supplied `plgHash`, and the index is
 * computed over the COMPLETE set including it. That is the whole point of
 * returning them together rather than offering two helpers.
 */
export function plbWithdrawalPlan(params: {
  /** programmable_logic_global's script hash — the credential PLB checks. */
  plgHash: HexString;
  /** Every OTHER withdrawal the final transaction will carry. */
  others: readonly WithdrawalKey[];
}): {
  /** The complete set, unsorted — pass it on if another index is needed. */
  all: WithdrawalKey[];
  /** Position of the dispatcher's withdrawal — this is PLB's `wdrl_idx`. */
  plgIdx: number;
  /** Position of any other member of the set. */
  indexOf(target: WithdrawalKey): number;
} {
  const plgKey: WithdrawalKey = { hash: params.plgHash, isScript: true };
  const all = [plgKey, ...params.others];

  const dupes = all.filter(
    (k, i) => all.findIndex((o) => compareWithdrawalKeys(o, k) === 0) !== i
  );
  if (dupes.length > 0) {
    throw new Error(
      `plbWithdrawalPlan: duplicate withdrawal credential ${dupes[0]!.hash}. A credential ` +
        `occupies exactly one slot in the ledger's withdrawal map, so listing it twice ` +
        `produces indices that do not match the transaction the builder emits.`
    );
  }

  return {
    all,
    plgIdx: withdrawalIndexOf(all, plgKey),
    indexOf: (target) => withdrawalIndexOf(all, target),
  };
}

// ---------------------------------------------------------------------------
// BaseSpendRedeemer — programmable_logic_base.spend
// ---------------------------------------------------------------------------

/**
 * Build a `BaseSpendRedeemer { params_idx, wdrl_idx }`.
 *
 * ⛔ THIS IS THE MOST DANGEROUS CHANGE IN THE alpha.3 MIGRATION, AND IT IS
 * DANGEROUS BECAUSE IT IS INVISIBLE. In alpha.2 this redeemer was an ENUM of
 * three constructors — `SpendViaTransfer` / `SpendViaThirdParty` /
 * `SpendViaUnfracking` — each carrying the same two ints. It is now a single
 * RECORD.
 *
 * `SpendViaTransfer(a, b)` encoded as `Constr(0, [Int, Int])`.
 * `BaseSpendRedeemer { a, b }` encodes as `Constr(0, [Int, Int])`.
 *
 * THEY ARE BYTE-IDENTICAL. A stale builder emitting the old transfer variant
 * produces a perfectly valid new redeemer that DECODES CLEANLY. Only the other
 * two variants (constructors 1 and 2) fail outright — so the failure is
 * ASYMMETRIC, and the path that stays silent is the transfer path, i.e. the
 * common one.
 *
 * ⚠ AND `wdrl_idx` CHANGED WHAT IT POINTS AT, not merely where. The chain is
 * now `PLB -> params[plg_cred] -> PLG -> delegate`: this index selects the
 * DISPATCHER'S withdrawal, and the validator compares that entry against
 * `plg_cred` from the params datum. In alpha.2 it selected the DELEGATE'S. A
 * stale index therefore resolves to the wrong credential and fails an equality
 * check — reported as a mismatch, never as "your redeemer is from the previous
 * protocol version".
 *
 * ⇒ The variant is gone from this redeemer entirely. It moved to the
 * dispatcher: see {@link programmableLogicGlobalRedeemer}. Passing one here is
 * refused loudly rather than silently encoded.
 */
export function baseSpendRedeemer(paramsIdx: number, wdrlIdx: number): Data.Data {
  // ⚠ A caller still on the alpha.2 signature passes the variant FIRST, so the
  // legacy call `baseSpendRedeemer("TRANSFER", 0, 1)` lands its variant in
  // paramsIdx. Name that specifically: "params_idx must be an integer" is true
  // but sends the reader looking at their index arithmetic instead of at their
  // SDK version.
  if (typeof paramsIdx === "string") {
    throw new Error(
      `baseSpendRedeemer no longer takes a dispatch variant. It was ` +
        `(via, params_idx, wdrl_idx) in 0.5.0-alpha.2 and is (params_idx, wdrl_idx) now: ` +
        `programmable_logic_base dispatches to the single programmable_logic_global ` +
        `credential, and the variant moved to that dispatcher's own redeemer — see ` +
        `programmableLogicGlobalRedeemer("${paramsIdx}"). ⚠ wdrl_idx ALSO changed meaning: ` +
        `it must now index the DISPATCHER's withdrawal, not the delegate's.`
    );
  }
  if (!Number.isInteger(paramsIdx) || paramsIdx < 0) {
    throw new Error(`baseSpendRedeemer: params_idx must be a non-negative integer, got ${paramsIdx}`);
  }
  if (!Number.isInteger(wdrlIdx) || wdrlIdx < 0) {
    throw new Error(`baseSpendRedeemer: wdrl_idx must be a non-negative integer, got ${wdrlIdx}`);
  }
  return Data.constr(0n, [Data.int(BigInt(paramsIdx)), Data.int(BigInt(wdrlIdx))]);
}

// ---------------------------------------------------------------------------
// ProgrammableLogicGlobalRedeemer — the dispatcher
// ---------------------------------------------------------------------------

/**
 * Which delegate the DISPATCHER routes to. Field-less constructors; the index
 * is the whole payload.
 *
 * These are the three constructors that used to live on BaseSpendRedeemer. They
 * did not disappear in alpha.3 — they MOVED one level up.
 */
export const PlgAct = {
  TRANSFER: 0n,
  THIRD_PARTY: 1n,
  UNFRACKING: 2n,
} as const;

export type PlgActVariant = keyof typeof PlgAct;

/**
 * Build a `ProgrammableLogicGlobalRedeemer`.
 *
 * Every programmable-token transaction now carries the dispatcher's withdraw-0
 * in ADDITION to its delegate's, so every withdrawal index in the transaction
 * shifts relative to alpha.2 — compute them over the complete set, last.
 */
export function programmableLogicGlobalRedeemer(via: PlgActVariant): Data.Data {
  const idx = PlgAct[via];
  if (idx === undefined) {
    throw new Error(
      `programmableLogicGlobalRedeemer: unknown act ${JSON.stringify(via)}. ` +
        `Expected one of: ${Object.keys(PlgAct).join(", ")}.`
    );
  }
  return Data.constr(idx, []);
}

// ---------------------------------------------------------------------------
// Delegate redeemers
// ---------------------------------------------------------------------------

export interface RegistryProofRef {
  type: "exists" | "not-exists";
  nodeIdx: number;
}

/**
 * `transfer`'s `TransferRedeemer { proofs }`.
 *
 * ⚠ `params_idx` was DROPPED in alpha.3 — the delegates stop reading the params
 * datum entirely. A stale two-argument call puts an Int where the proof list
 * belongs, which is refused below rather than encoded into a malformed list.
 */
export function transferRedeemer(proofs: readonly RegistryProofRef[]): Data.Data {
  if (!Array.isArray(proofs)) {
    throw new Error(
      `transferRedeemer takes only the proof list now — it was (params_idx, proofs) in ` +
        `0.5.0-alpha.2. The delegates no longer read the protocol-params datum, so ` +
        `params_idx is gone from all three delegate redeemers. Got ${typeof proofs}.`
    );
  }
  return Data.constr(0n, [
    Data.list(
      proofs.map((p) =>
        Data.constr(p.type === "exists" ? 0n : 1n, [Data.int(BigInt(p.nodeIdx))])
      )
    ),
  ]);
}

/**
 * ⛔ THE ONE THAT WOULD HAVE BEEN SILENT. `thirdPartyRedeemer` and
 * `unfrackingRedeemer` went from THREE ints to TWO by dropping the FIRST. A
 * stale three-argument call is not a type error in JavaScript: the first two
 * arguments land in the two remaining slots and the third is ignored, so
 * `(params_idx, registry_node_idx, outputs_start_idx)` silently encodes as
 * `{ registry_node_idx: params_idx, outputs_start_idx: registry_node_idx }` —
 * a well-formed redeemer with two wrong values and no complaint anywhere.
 *
 * Arity is therefore checked explicitly. TypeScript catches this for TS
 * callers; `arguments.length` catches it for everyone else.
 */
function assertTwoArgs(fn: string, got: number): void {
  if (got > 2) {
    throw new Error(
      `${fn} takes (registry_node_idx, outputs_start_idx) — TWO arguments. It took ` +
        `(params_idx, registry_node_idx, outputs_start_idx) in 0.5.0-alpha.2 and the FIRST ` +
        `was dropped, so a 3-argument call silently shifts both values one slot left and ` +
        `encodes cleanly. Got ${got} arguments.`
    );
  }
}

/** `third_party`'s `ThirdPartyRedeemer { registry_node_idx, outputs_start_idx }`. */
export function thirdPartyRedeemer(
  registryNodeIdx: number,
  outputsStartIdx: number
): Data.Data {
  // eslint-disable-next-line prefer-rest-params
  assertTwoArgs("thirdPartyRedeemer", arguments.length);
  return Data.constr(0n, [
    Data.int(BigInt(registryNodeIdx)),
    Data.int(BigInt(outputsStartIdx)),
  ]);
}

/** `unfracking`'s `UnfrackingRedeemer { registry_node_idx, outputs_start_idx }`. */
export function unfrackingRedeemer(
  registryNodeIdx: number,
  outputsStartIdx: number
): Data.Data {
  // eslint-disable-next-line prefer-rest-params
  assertTwoArgs("unfrackingRedeemer", arguments.length);
  return Data.constr(0n, [
    Data.int(BigInt(registryNodeIdx)),
    Data.int(BigInt(outputsStartIdx)),
  ]);
}
