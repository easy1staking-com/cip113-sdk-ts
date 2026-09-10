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
import type { HexString, PolicyId, ScriptHash, TxInput } from "../types.js";
// No cycle: `evo-utils.ts` names this file only in prose, never in an import.
import {
  issuanceRedeemer as buildIssuanceRedeemer,
  issuanceLogicRedeemer as buildIssuanceLogicRedeemer,
  mintingProofRefInput,
  mintingProofOutputIndex,
} from "./evo-utils.js";

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
 *
 * ⇒ If this transaction MINTS OR BURNS, use {@link issuancePlan} instead — the
 * withdrawal set has one more member (`issuance_logic`'s), so every index this
 * function returns is one short.
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
// The issuance plan — withdrawals, reference inputs and outputs, together
// ---------------------------------------------------------------------------

/**
 * Where a policy's registry node lives in THIS transaction.
 *
 * ⛔ A SOURCE, NOT A `Data.Data`. A caller cannot hand in a pre-built
 * `MintingRegistryProof`, because a pre-built one carries an index computed
 * somewhere this object cannot see — which is precisely the failure it exists
 * to prevent. Name the coordinate or the output tag and let the plan do the
 * arithmetic, over the complete sets, last.
 */
export type IssuanceProofSource =
  | { kind: "reference-input"; input: TxInput }
  | { kind: "output"; tag: string };

/** One policy this transaction issues, and where its registry node is. */
export interface IssuedPolicy {
  policyId: PolicyId;
  proof: IssuanceProofSource;
}

/** What {@link issuancePlan} hands back. See its block comment. */
export interface IssuancePlan {
  /** The complete withdrawal set, unsorted — emit exactly these. */
  withdrawals: WithdrawalKey[];
  /** `issuance_logic`'s own withdraw-0 key. Its absence is silent on chain. */
  issuanceLogicKey: WithdrawalKey;
  /** Position of any member of the complete withdrawal set. */
  withdrawalIndexOf(target: WithdrawalKey): number;
  /**
   * `programmable_logic_base`'s `wdrl_idx`.
   *
   * ⛔ A METHOD HERE AND A PROPERTY ON {@link plbWithdrawalPlan}, DELIBERATELY.
   * That asymmetry is the guard, not a style choice: a call site copy-pasted
   * from the old plan reads `plan.plgIdx` and gets a COMPILE ERROR, instead of
   * a function object silently encoded as an index. Throws when `plgHash` was
   * not supplied.
   */
  plgIdx(): number;
  /** The complete reference-input set, unsorted — as given. */
  referenceInputs: TxInput[];
  /** `IssuanceRedeemer`'s `params_idx`, over the complete sorted set. */
  paramsIdx: number;
  /** Position of any member of the complete reference-input set. */
  referenceInputIndexOf(input: TxInput): number;
  /** The transaction's explicit outputs, as tags, in emission order. */
  declaredOutputs: readonly string[];
  /** Position of a declared output, by tag rather than by count. */
  outputIndexOf(tag: string): number;
  /** `issuance_mint`'s redeemer — `IssuanceRedeemer { params_idx }`. */
  issuanceRedeemer: Data.Data;
  /** `issuance_logic`'s withdraw-0 redeemer — `Pairs<PolicyId, MintingRegistryProof>`. */
  issuanceLogicRedeemer: Data.Data;
}

/**
 * The plan for a transaction that MINTS OR BURNS a programmable token.
 *
 * ⛔ WHAT alpha.4 CHANGED. Issuance was split (upstream #129). `issuance_mint`'s
 * redeemer is now `IssuanceRedeemer { params_idx }` — an index and nothing else,
 * frozen for as long as any token exists, because that script's applied hash IS
 * the token's policy id. Everything that may change moved behind
 * `issuance_logic_cred` in the protocol-params datum, and the registry proof now
 * travels as a VALUE inside `issuance_logic`'s withdraw-0 map, keyed by policy
 * id. So one index became three interdependent sets.
 *
 * ⛔ OMITTING THE `issuance_logic` WITHDRAWAL IS SILENT. `issuance_mint` does not
 * look for the withdrawal; it calls `covered_by(self.redeemers, …)`, which scans
 * for a redeemer whose purpose is `Withdraw(issuance_logic_cred)` and requires
 * `own_policy` to be one of its keys. With the withdrawal absent there is no such
 * redeemer, `covered_by` returns `False`, and the mint fails NAMING NOTHING —
 * not a missing withdrawal, not a policy, not an index.
 *
 * ⚠ AND `params_idx` HAS NO FALLBACK. `params.with_protocol_params_fields` opens
 * with `list.expect_at(reference_inputs, params_idx)` — a hard fail, not a scan.
 * A params UTxO the builder forgot to add as a reference input cannot be
 * recovered on chain, and an index computed before the last reference input was
 * added resolves to some other UTxO and dies on the NFT check.
 *
 * ⇒ THIS IS THE EXTENSION OF {@link plbWithdrawalPlan} FOR TRANSACTIONS THAT
 * MINT OR BURN. That function remains correct and unchanged for transactions
 * that do neither — transfer, third-party transfer, seize, freeze/unfreeze.
 *
 * ⚠ THE RESIDUAL RISK A MECHANISM CANNOT CARRY, stated here because it is the
 * fallback and not the fix: nothing PREVENTS an issuing transaction from calling
 * `plbWithdrawalPlan` directly and computing `plgIdx` over a set one entry short.
 * The five remaining `plbWithdrawalPlan` call sites are:
 *
 *   NON-ISSUING, and correct as they stand —
 *     src/substandards/dummy/index.ts:597            thirdPartyTransfer
 *     src/substandards/dummy/index.ts:768            transfer
 *     src/substandards/freeze-and-seize/index.ts:1022  transfer
 *     src/substandards/freeze-and-seize/index.ts:1474  seize
 *
 *   ⛔ ISSUING, and therefore ALREADY one entry short in alpha.4 —
 *     src/substandards/freeze-and-seize/index.ts:820   burn
 *
 * The burn call site is T-F04-3's to rewire; it is named here rather than left
 * implied, because an unexplained gap is indistinguishable from a missing one.
 *
 * ⇒ And the check that proves the set was not merely COMPUTED but actually
 * ADDED is a per-call-site count cross-check — `plan.withdrawals.length` against
 * the number of `withdraw()` calls the builder emits. That is the S-6 rule: a
 * correct index over a set the transaction does not carry is the same failure
 * wearing a different name.
 */
export function issuancePlan(params: {
  /** `issuance_logic`'s script hash, from the protocol-params datum, field 1. */
  issuanceLogicHash: HexString;
  /** Present IFF this transaction spends a `programmable_logic_base` input. */
  plgHash?: HexString;
  /** Every OTHER withdrawal the final transaction will carry. */
  otherWithdrawals: readonly WithdrawalKey[];
  /** Every reference input the final transaction will carry. */
  referenceInputs: readonly TxInput[];
  /** The protocol-params UTxO. Must be a member of `referenceInputs`. */
  paramsRefInput: TxInput;
  /** The explicit `payToAddress` outputs, as tags, in emission order. */
  outputs?: readonly string[];
  /** Every policy this transaction mints or burns. */
  issued: readonly IssuedPolicy[];
}): IssuancePlan {
  const issuanceLogicKey: WithdrawalKey = {
    hash: params.issuanceLogicHash,
    isScript: true,
  };

  // ⛔ `plgHash: ""` IS NOT "NO DISPATCHER", IT IS A MALFORMED ONE. `plgHash` is
  // optional, so the natural JavaScript way to pass one through is
  // `plgHash: maybeHash ?? ""` — and an empty string is a credential hash of
  // length zero, which no credential has. Refused by name here rather than
  // classified: every OTHER site in this function asks `=== undefined`, and a
  // falsy-but-present value that some branches read as absent and others as
  // present is how a duplicate-credential scan gets skipped by both halves at
  // once (T-F04-1 audit r1, F-2).
  if (params.plgHash !== undefined && params.plgHash.length === 0) {
    throw new Error(
      `issuancePlan: plgHash was supplied as an EMPTY STRING. Pass the ` +
        `programmable_logic_global script hash when this transaction spends a ` +
        `programmable_logic_base input, or OMIT plgHash entirely when it does not — a ` +
        `zero-length credential hash is neither, and it would occupy a withdrawal slot ` +
        `that no credential can ever match on chain.`
    );
  }

  // The withdrawal set. When a PLB input is spent, reuse plbWithdrawalPlan so
  // the dispatcher rule lives in exactly one place — it already adds plgHash and
  // already refuses duplicates over the complete set.
  //
  // ⚠ PAIRED WITH THE EMPTY-plgHash GUARD ABOVE, and legitimate only because of
  // it. `!== undefined` rather than truthiness is what makes this branch agree
  // with the two `=== undefined` tests further down; with the entry guard in
  // place no falsy-but-present value can reach here, so MUTATING THIS LINE BACK
  // TO TRUTHINESS REDDENS NOTHING (measured, r3 M-F2b — a deliberate survivor).
  // If that entry guard is ever removed, this line becomes load-bearing again
  // and its absence is the F-2 defect: both duplicate scans skipped at once.
  const withOthers = [issuanceLogicKey, ...params.otherWithdrawals];
  const withdrawals = params.plgHash !== undefined
    ? plbWithdrawalPlan({ plgHash: params.plgHash, others: withOthers }).all
    : withOthers;

  if (params.plgHash === undefined) {
    // The same scan plbWithdrawalPlan performs, for the pure-mint path that does
    // not go through it.
    const dupes = withdrawals.filter(
      (k, i) => withdrawals.findIndex((o) => compareWithdrawalKeys(o, k) === 0) !== i
    );
    if (dupes.length > 0) {
      throw new Error(
        `issuancePlan: duplicate withdrawal credential ${dupes[0]!.hash}. A credential ` +
          `occupies exactly one slot in the ledger's withdrawal map, so listing it twice ` +
          `produces indices that do not match the transaction the builder emits.`
      );
    }
  }

  // Two reference inputs comparing equal are ONE entry on chain, so the set is
  // one shorter than the caller believes and every index after it is wrong.
  const refs = [...params.referenceInputs];
  const dupRef = refs.find(
    (r, i) => refs.findIndex((o) => compareTxInputs(o, r) === 0) !== i
  );
  if (dupRef) {
    throw new Error(
      `issuancePlan: duplicate reference input ${dupRef.txHash}#${dupRef.outputIndex}. ` +
        `A UTxO occupies exactly one slot in the ledger's reference-input list, so listing ` +
        `it twice produces a set one entry longer than the transaction carries and every ` +
        `index at or after it is wrong.`
    );
  }

  const referenceInputIndexOfMember = (input: TxInput): number =>
    referenceInputIndexOf(refs, input);

  let paramsIdx: number;
  try {
    paramsIdx = referenceInputIndexOfMember(params.paramsRefInput);
  } catch (err) {
    throw new Error(
      `issuancePlan: the protocol-params UTxO ` +
        `${params.paramsRefInput.txHash}#${params.paramsRefInput.outputIndex} is not in the ` +
        `reference-input set (${refs.length} entries). issuance_mint reaches it through ` +
        `list.expect_at(reference_inputs, params_idx), which is a HARD FAIL and not a scan: ` +
        `there is no fallback and no search, so a params UTxO missing from the reference ` +
        `inputs cannot be recovered on chain. (${(err as Error).message})`
    );
  }

  const declaredOutputs = params.outputs ?? [];
  const dupTag = declaredOutputs.find((t, i) => declaredOutputs.indexOf(t) !== i);
  if (dupTag !== undefined) {
    throw new Error(
      `issuancePlan: duplicate output tag ${JSON.stringify(dupTag)}. Two outputs sharing one ` +
        `name make outputIndexOf ambiguous, and it would silently return the FIRST — which ` +
        `is a coin flip about which output a registry proof points at.`
    );
  }

  const outputIndexOf = (tag: string): number => {
    if (params.outputs === undefined) {
      throw new Error(
        `issuancePlan: an output proof names tag ${JSON.stringify(tag)}, but \`outputs\` was ` +
          `not supplied. The plan indexes outputs BY TAG over the declared emission order, ` +
          `so a transaction that proves a registry node from one of its own outputs must ` +
          `declare that output list.`
      );
    }
    const idx = declaredOutputs.indexOf(tag);
    if (idx < 0) {
      throw new Error(
        `issuancePlan: unknown output tag ${JSON.stringify(tag)}. Declared outputs, in ` +
          `emission order: ${JSON.stringify(declaredOutputs)}.`
      );
    }
    return idx;
  };

  const entries = params.issued.map((e) => {
    // Each arm requires its OWN payload, not merely the right `kind`: without
    // this, `{ kind: "reference-input" }` with no `input` raised a raw TypeError
    // from inside the catch block's own template literal, so the named refusal
    // below never emerged (T-F04-1 audit r1, F-5).
    const src = e.proof as IssuanceProofSource | undefined;
    if (src?.kind === "reference-input" && src.input != null) {
      let idx: number;
      try {
        idx = referenceInputIndexOfMember(src.input);
      } catch (err) {
        throw new Error(
          `issuancePlan: the registry node for policy ${e.policyId} names reference input ` +
            `${src.input.txHash}#${src.input.outputIndex}, which is not in the ` +
            `reference-input set (${refs.length} entries). (${(err as Error).message})`
        );
      }
      return { policyId: e.policyId, proof: mintingProofRefInput(idx) };
    }
    if (src?.kind === "output" && typeof src.tag === "string") {
      return { policyId: e.policyId, proof: mintingProofOutputIndex(outputIndexOf(src.tag)) };
    }
    throw new Error(
      `issuancePlan: the proof for policy ${e.policyId} is not an IssuanceProofSource. ` +
        `Pass { kind: "reference-input", input } or { kind: "output", tag } — NOT a ` +
        `pre-built MintingRegistryProof, because a pre-built one carries an index computed ` +
        `somewhere this object cannot see, which is the failure it exists to prevent.`
    );
  });

  // Built EAGERLY, and that is itself a guard: the map cannot be forgotten, and
  // TWO of issuanceLogicRedeemer's three refusals — the empty map, and a
  // duplicate policy id compared as lower-cased hex — fire here, in the caller's
  // own stack, rather than three lines from submission.
  //
  // Its THIRD refusal, a value that is not a MintingRegistryProof, is
  // structurally UNREACHABLE through this path and is not inherited: the plan
  // builds every proof itself with mintingProofRefInput/mintingProofOutputIndex
  // and can never hand a bad value down. MEASURED — neutering that guard in
  // evo-utils.ts moves no issuancePlan test (T-F04-1 audit r1, M17). The guard
  // for the equivalent CALLER mistake is this function's own "is not an
  // IssuanceProofSource" refusal above, which is load-bearing.
  const issuanceRedeemerData = buildIssuanceRedeemer(paramsIdx);
  const issuanceLogicRedeemerData = buildIssuanceLogicRedeemer(entries);

  return {
    withdrawals,
    issuanceLogicKey,
    withdrawalIndexOf: (target) => withdrawalIndexOf(withdrawals, target),
    plgIdx: () => {
      if (params.plgHash === undefined) {
        throw new Error(
          `issuancePlan: plgIdx() needs plgHash, which was not supplied. plgHash is present ` +
            `IFF the transaction spends a programmable_logic_base input — a burn does, a ` +
            `register or a mint does not. Asking for the dispatcher's index on a transaction ` +
            `that carries no dispatcher withdrawal has no answer, and returning 0 would be ` +
            `the same defect wearing the opposite sign.`
        );
      }
      return withdrawalIndexOf(withdrawals, { hash: params.plgHash, isScript: true });
    },
    referenceInputs: refs,
    paramsIdx,
    referenceInputIndexOf: referenceInputIndexOfMember,
    declaredOutputs,
    outputIndexOf,
    issuanceRedeemer: issuanceRedeemerData,
    issuanceLogicRedeemer: issuanceLogicRedeemerData,
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
  // `Object.hasOwn`, not `=== undefined`: `PlgAct["valueOf"]` inherits a FUNCTION
  // from Object.prototype, so a plain lookup sails past an undefined check and
  // dies inside the encoder as a Data.Constr index type error naming nothing the
  // caller can act on. Twin of the `protocolParamsRedeemer` finding in
  // `src/core/evo-utils.ts` (T-F02-1 audit F-2); same pattern, same reasoning.
  const idx = Object.hasOwn(PlgAct, via) ? PlgAct[via] : undefined;
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
