/**
 * The upgrade lifecycle — locating the two UTxOs that hold a protocol's
 * governable state, and (from T-G02/T-G03) building the transactions that move
 * it.
 *
 * ⛔ WHY THIS IS EXPORTED SURFACE AND NOT A TEST FIXTURE. The 2026-09-17
 * boundary amendment (CLAUDE.md, Giovanni first-hand) put the BUILDING of
 * protocol-bootstrap transactions inside this package, on the governing clause
 * that it is the same thing this SDK already does — build and return unsigned
 * transactions. An upgrade is the bootstrap's sibling, and the amendment's
 * rationale transfers verbatim: a consumer that cannot import this maintains its
 * own port of a protocol-critical sequence, and "two implementations, one right
 * and the other not yet wrong" is the defect the amendment exists to remove.
 * Extended to the upgrade sequence by Giovanni, 2026-10-01, for the platform to
 * drive a MAINNET deployment with.
 *
 * ⛔ WHAT THAT INHERITANCE FORBIDS, and it is the reason the harness's working
 * code could not simply be moved here. `test/harness/upgrade.ts` signs, submits
 * and awaits; it defaults an evaluator endpoint to `localhost:1337`; and it
 * types its client `any` in four places. All three are constitution
 * escalations. Everything in this module therefore:
 *
 *   - is PURE, or returns an UNSIGNED transaction. It never signs, submits,
 *     awaits, or reaches the network.
 *   - takes the UTxOs it reasons about from the CALLER. No chain reads, no
 *     hidden queries, no endpoint defaults. This mirrors
 *     `assertMultisigConfigUtxo`, the house pattern for exactly this problem.
 *   - names every required input. A value the caller must decide is never
 *     defaulted.
 *
 * ---
 *
 * ## Why locating is a function and not a field read
 *
 * `DeploymentParams` records where both UTxOs were at bootstrap. Those
 * coordinates are a RECORD, not an IDENTITY:
 *
 *   - `protocolParams.utxo` moves on every upgrade — each `protocol_params`
 *     spend consumes it and recreates it.
 *   - `upgradeMultisig.utxo` moves on every signer rotation — each
 *     `upgrade_multisig` spend consumes it and recreates it.
 *
 * The NFT is what does not move. Both are one-shot policies minting exactly one
 * token, so "the UTxO at this address carrying an asset of this policy" is the
 * identity, and `src/types.ts` already documents both fields as mutable state
 * for this reason. An operator who reads the recorded coordinate after a
 * rotation is reading a UTxO that no longer exists.
 *
 * ⚑ FILTERED BY POLICY, EXACTLY AS THE VALIDATOR DOES. `upgrade_multisig.withdraw`
 * finds its config UTxO with `has_currency_symbol(i.output.value, own_hash)` —
 * a policy test, not a unit-equality test. Looking up by a unit string this
 * module constructed would share a blind spot with the code that constructed
 * it: get the asset name wrong in both places and the lookup agrees with itself.
 * So the policy decides, and the asset names actually found are reported in the
 * refusal so a mismatch is diagnosable rather than merely fatal.
 */

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Bytes,
  Data,
  InlineDatum,
  KeyHash,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";

import type {
  DeploymentParams,
  HexString,
  PlutusBlueprint,
  PolicyId,
  ScriptHash,
  TxInput,
  UTxO,
} from "../types.js";
import type { UnsignedTx } from "../substandards/interface.js";
import type { MultisigScriptTree, ProtocolParamsData } from "../core/evo-utils.js";
import {
  buildEvoScript,
  decodeMultisigScript,
  decodeProtocolParams,
  getInlineDatum,
  minUtxoAtLeast,
  multisigScriptDatum,
  outputAssets,
  protocolParamsDatum,
  protocolParamsRedeemer,
  scriptAddress,
  voidData,
  Credential,
  type ProtocolParamsActVariant,
} from "../core/evo-utils.js";
import { createStandardScripts } from "./scripts.js";
import type { BootstrapBuildContext } from "./bootstrap.js";
import { finish as finishUnsignedTx } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Token names — fixed by the validators, not by this SDK
// ---------------------------------------------------------------------------

/**
 * `protocol_params`' NFT asset name, as the validator declares it
 * (`programmable_logic/params.ak`: `protocol_params_token`).
 */
export const PROTOCOL_PARAMS_TOKEN_NAME = "ProtocolParams";

/**
 * `upgrade_multisig`'s config NFT asset name, as the validator declares it
 * (`upgrade_multisig.ak`: `upgrade_multisig_token`).
 */
export const UPGRADE_MULTISIG_TOKEN_NAME = "UpgradeMultisig";

// ---------------------------------------------------------------------------
// Addresses — derived, because policy id IS the address's payment credential
// ---------------------------------------------------------------------------

/**
 * The protocol-params address.
 *
 * ⚑ ONE HASH, TWO ROLES, and that is the validator's own construction: every
 * handler of a `validator` block shares a script hash, so the params NFT's
 * policy id and this address's payment credential are the same value. The
 * address needs no separate record and cannot drift from the policy.
 *
 * ⚠ It carries NO STAKE CREDENTIAL — `protocol_params.mint` locks the NFT at
 * `address.from_script(own_policy)`. So the params UTxO can never be delegated,
 * which is also why no upgrade can entangle it with a withdrawal.
 */
export function protocolParamsAddress(networkId: number, deployment: DeploymentParams): string {
  return scriptAddress(networkId, deployment.protocolParams.policyId);
}

/** The `upgrade_multisig` config address — same one-hash-two-roles construction. */
export function upgradeMultisigAddress(networkId: number, deployment: DeploymentParams): string {
  return scriptAddress(networkId, deployment.upgradeMultisig.scriptHash);
}

// ---------------------------------------------------------------------------
// The shared locate primitive
// ---------------------------------------------------------------------------

/** Units a UTxO holds under `policy`, lovelace excluded. */
function unitsOfPolicy(utxo: UTxO, policy: PolicyId): string[] {
  return EvoAssets.getUnits(utxo.assets).filter(
    (unit) => unit !== "lovelace" && unit.slice(0, 56) === policy.toLowerCase()
  );
}

/** `txHash#index` for a located UTxO. */
function refOf(utxo: UTxO): TxInput {
  return {
    txHash: EvoTransactionHash.toHex(utxo.transactionId).toLowerCase(),
    outputIndex: Number(utxo.index),
  };
}

/**
 * Find the single UTxO among `utxosAtAddress` carrying an asset of `policy`.
 *
 * ⚠ NO CARDINALITY RAIL ON THE ADDRESS ITSELF, and its absence is deliberate.
 * The harness version of this lookup refuses when the address holds fewer than
 * two UTxOs, because the devnet bootstrap parks a decoy there to keep the policy
 * filter non-vacuous. That is a true statement about a FIXTURE and a false
 * requirement of a real deployment: nothing obliges a production protocol to
 * have junk parked beside its config UTxO, and carrying the rail here would
 * refuse every clean deployment — most sharply on mainnet, where there is no
 * bootstrap to park anything.
 *
 * Anyone may pay to a script address at any time, so junk parked alongside is
 * expected rather than exceptional, and both validators contemplate it: the
 * one-shot NFT cannot be in two places, and a junk UTxO's own run of the
 * validator fails the transaction.
 */
function locateByPolicy(params: {
  readonly utxosAtAddress: readonly UTxO[];
  readonly policy: PolicyId;
  readonly address: string;
  readonly what: string;
  readonly expectedTokenName: string;
}): UTxO {
  const { utxosAtAddress, policy, address, what, expectedTokenName } = params;
  const candidates = utxosAtAddress.filter((u) => unitsOfPolicy(u, policy).length > 0);

  if (candidates.length === 1) return candidates[0]!;

  const seen = utxosAtAddress
    .map((u) => {
      const ref = refOf(u);
      const units = EvoAssets.getUnits(u.assets).filter((x) => x !== "lovelace");
      return `    ${ref.txHash}#${ref.outputIndex} — ${
        units.length === 0 ? "lovelace only" : units.map((x) => x.slice(56) || "(no name)").join(", ")
      }`;
    })
    .join("\n");

  const nameHint =
    `The NFT's asset name is "${expectedTokenName}" ` +
    `(hex ${Buffer.from(expectedTokenName, "utf-8").toString("hex")}), though this lookup ` +
    `keys on the POLICY, exactly as the validator does.`;

  if (candidates.length === 0) {
    throw new Error(
      `${what}: no UTxO at ${address} carries an asset of policy ${policy}. ` +
        `That policy is one-shot and mints exactly one token, so its absence here means the NFT ` +
        `is not at this address — either this is not the deployment you think it is, or the ` +
        `UTxO set you passed in is stale or was read from a different address.\n` +
        `${nameHint}\n` +
        `The ${utxosAtAddress.length} UTxO(s) you passed in hold:\n${seen || "    (none)"}`
    );
  }

  throw new Error(
    `${what}: ${candidates.length} UTxOs at ${address} carry an asset of policy ${policy}, ` +
      `and exactly one must. The NFT is one-shot, so more than one holder is not a state the ` +
      `validators can produce — this address is not what it is taken to be, or the UTxO set ` +
      `mixes two deployments.\n` +
      `${nameHint}\n` +
      `The ${utxosAtAddress.length} UTxO(s) you passed in hold:\n${seen}`
  );
}

// ---------------------------------------------------------------------------
// The two locators
// ---------------------------------------------------------------------------

/** A located protocol-params UTxO, with its decoded datum. */
export interface LocatedProtocolParams {
  readonly utxo: UTxO;
  readonly ref: TxInput;
  /** The live wiring. Every upgrade is a function of this value. */
  readonly params: ProtocolParamsData;
}

/**
 * Locate the protocol-params UTxO and decode its datum.
 *
 * The caller supplies every UTxO at {@link protocolParamsAddress}; this picks
 * the one holding the params NFT. Pure — pass the result of your own chain read.
 */
export function locateProtocolParams(params: {
  readonly deployment: DeploymentParams;
  readonly utxosAtAddress: readonly UTxO[];
  /** Only used to build the address named in refusals. */
  readonly networkId: number;
}): LocatedProtocolParams {
  const { deployment, utxosAtAddress, networkId } = params;
  const utxo = locateByPolicy({
    utxosAtAddress,
    policy: deployment.protocolParams.policyId,
    address: protocolParamsAddress(networkId, deployment),
    what: "protocol-params UTxO",
    expectedTokenName: PROTOCOL_PARAMS_TOKEN_NAME,
  });

  const datum = getInlineDatum(utxo);
  if (!datum) {
    throw new Error(
      `protocol-params UTxO ${refOf(utxo).txHash}#${refOf(utxo).outputIndex} carries NO INLINE ` +
        `DATUM. The datum IS the live protocol wiring — every delegate credential, the upgrade ` +
        `authority and any standing nomination — so without it there is nothing to upgrade from ` +
        `and no transaction this module can build. A params UTxO in this state cannot be ` +
        `produced by the validators: both handlers require the continuing datum to decode.`
    );
  }

  return { utxo, ref: refOf(utxo), params: decodeProtocolParams(datum) };
}

/** A located `upgrade_multisig` config UTxO, with its decoded authority tree. */
export interface LocatedUpgradeMultisig {
  readonly utxo: UTxO;
  readonly ref: TxInput;
  /** The tree that IS the authority. Satisfying it is what authorises an upgrade. */
  readonly tree: MultisigScriptTree;
}

/**
 * Locate the `upgrade_multisig` config UTxO and decode its authority tree.
 *
 * ⚑ NO `expectedTree` PARAMETER, unlike `assertMultisigConfigUtxo`. That
 * function serves a BOOTSTRAP, which knows the tree it just minted and should
 * refuse if the chain disagrees. This one serves an OPERATOR, who is reading a
 * live authority precisely because they do not know what it holds — and after a
 * rotation the tree is whatever the last rotation wrote. Demanding an
 * expectation here would make the function unusable for its only purpose.
 *
 * ⚠ The tree is returned UNVALIDATED against upstream's `well_formed`.
 * `decodeMultisigScript` deliberately enforces none of those rules, and that
 * asymmetry with the encoder is intentional: a tree already on chain is a fact
 * to be read, not a proposal to be judged. Judging happens when a tree is
 * WRITTEN.
 */
export function locateUpgradeMultisig(params: {
  readonly deployment: DeploymentParams;
  readonly utxosAtAddress: readonly UTxO[];
  readonly networkId: number;
}): LocatedUpgradeMultisig {
  const { deployment, utxosAtAddress, networkId } = params;
  const utxo = locateByPolicy({
    utxosAtAddress,
    policy: deployment.upgradeMultisig.scriptHash,
    address: upgradeMultisigAddress(networkId, deployment),
    what: "upgrade_multisig config UTxO",
    expectedTokenName: UPGRADE_MULTISIG_TOKEN_NAME,
  });

  const datum = getInlineDatum(utxo);
  if (!datum) {
    throw new Error(
      `upgrade_multisig config UTxO ${refOf(utxo).txHash}#${refOf(utxo).outputIndex} carries NO ` +
        `INLINE DATUM. The tree IS the authority: ${"upgrade_multisig.withdraw"} decodes it from ` +
        `this UTxO to decide whether a transaction is authorised, so without it the credential is ` +
        `unsatisfiable and there is no repair path — the config UTxO can only be spent by ` +
        `satisfying the tree it no longer carries.`
    );
  }

  return { utxo, ref: refOf(utxo), tree: decodeMultisigScript(datum) };
}

// ---------------------------------------------------------------------------
// The offline preflight — "do the keys I hold satisfy this authority?"
// ---------------------------------------------------------------------------

/**
 * The evidence a transaction offers a `MultisigScript`, in the three forms
 * upstream's `satisfied` reads: signatories, a validity interval, and the
 * withdrawal set.
 *
 * ⚠ AN ABSENT BOUND IS NOT AN OPEN BOUND. Upstream's `Before`/`After` arms end
 * in `_ -> False`: an interval whose relevant bound is infinite satisfies
 * NEITHER. So omitting a bound here means "this transaction has no such bound",
 * which makes a `Before` or `After` leaf unsatisfiable — the same answer the
 * chain gives.
 */
export interface MultisigEvidence {
  /** `extra_signatories` — the key hashes the transaction names AND carries witnesses for. */
  readonly signatories: readonly HexString[];
  /** Script credentials the transaction withdraws from, for `Script` leaves. */
  readonly withdrawalScriptHashes?: readonly ScriptHash[];
  /** The transaction's validity interval, if it sets one. */
  readonly validityRange?: {
    readonly lowerBound?: { readonly time: bigint; readonly inclusive: boolean };
    readonly upperBound?: { readonly time: bigint; readonly inclusive: boolean };
  };
}

/**
 * Does this evidence satisfy this tree? A faithful port of `multisig.satisfied`
 * (`lib/multisig.ak` at upstream `6b75ba3`).
 *
 * ⛔ WHY AN OFFLINE PORT IS WORTH HAVING despite being a second implementation
 * of an on-chain rule. The chain's answer to "is this authority satisfied" is a
 * script failure with an empty trace list, arriving after a submission. This
 * answers the same question before one is built, which is the difference between
 * an operator learning that their quorum is short and an operator learning that
 * something, somewhere, said no.
 *
 * ⚠ AND IT IS A SECOND IMPLEMENTATION, so it can drift. It is NOT consulted by
 * the chain and nothing here is authoritative: a `true` from this function is a
 * prediction, and the ledger decides. It is used to REFUSE early, never to
 * permit — a `false` blocks a build, a `true` grants nothing.
 */
export function satisfiesMultisigTree(
  tree: MultisigScriptTree,
  evidence: MultisigEvidence
): boolean {
  const signed = new Set((evidence.signatories ?? []).map((k) => k.toLowerCase()));
  const withdrew = new Set((evidence.withdrawalScriptHashes ?? []).map((k) => k.toLowerCase()));

  const go = (t: MultisigScriptTree): boolean => {
    switch (t.type) {
      case "signature":
        return signed.has(t.keyHash.toLowerCase());
      case "script":
        return withdrew.has(t.scriptHash.toLowerCase());
      case "all-of":
        return t.scripts.every(go);
      case "any-of":
        return t.scripts.some(go);
      case "at-least":
        return t.scripts.filter(go).length >= t.required;
      case "before": {
        const hi = evidence.validityRange?.upperBound;
        if (!hi) return false;
        return hi.inclusive ? hi.time <= t.time : hi.time < t.time;
      }
      case "after": {
        const lo = evidence.validityRange?.lowerBound;
        if (!lo) return false;
        return lo.inclusive ? t.time <= lo.time : t.time < lo.time;
      }
    }
  };
  return go(tree);
}

/** Leaf kinds this builder cannot marshal evidence for. See `buildRotateMultisigTx`. */
function unsupportedLeafKinds(tree: MultisigScriptTree): string[] {
  const found = new Set<string>();
  const walk = (t: MultisigScriptTree): void => {
    switch (t.type) {
      case "before":
      case "after":
        found.add(t.type);
        return;
      case "script":
        found.add("script");
        return;
      case "all-of":
      case "any-of":
      case "at-least":
        t.scripts.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(tree);
  return [...found];
}

// ---------------------------------------------------------------------------
// Operation 1 — signer rotation (`upgrade_multisig.spend`)
// ---------------------------------------------------------------------------

export interface RotateMultisigTxParams extends BootstrapBuildContext {
  /** The standard blueprint — the script body is attached from it. */
  readonly blueprint: PlutusBlueprint;
  /** The deployment whose authority is being rotated. */
  readonly deployment: DeploymentParams;
  /**
   * The config UTxO, as {@link locateUpgradeMultisig} found it.
   *
   * ⚠ NOT taken from `deployment.upgradeMultisig.utxo`: that coordinate is a
   * record of where the UTxO was at bootstrap, and every rotation moves it.
   */
  readonly configUtxo: UTxO;
  /** The tree to install. Held to upstream's `well_formed` by the encoder. */
  readonly newTree: MultisigScriptTree;
  /**
   * The key hashes that will sign. REQUIRED, and not inferred from the tree:
   * which satisfying subset signs is the caller's decision, and for an
   * `AnyOf`/`AtLeast` tree there is more than one answer.
   *
   * ⚠ NAMING A SIGNER IS NOT HAVING ONE. These become `required_signers`
   * entries; the witnesses must still be present at submission, or the ledger
   * answers `MissingVKeyWitnessesUTXOW` naming the hash rather than the reason.
   */
  readonly signerKeyHashes: readonly HexString[];
  /**
   * Permit a rotation to a tree byte-identical to the current one.
   *
   * ⚑ REFUSED BY DEFAULT because a rotation that changes nothing is almost
   * always a caller bug — a tree built from stale config, or an edit that did
   * not take. The chain permits it (the rails are about shape and value, not
   * about change), so this is the SDK being stricter than the validator, and
   * the opt-in exists so a caller who means it can say so.
   */
  readonly allowUnchangedTree?: boolean;
}

/**
 * Build the unsigned transaction that rotates the upgrade authority's signer
 * tree — `upgrade_multisig.spend`.
 *
 * ⛔ THE POINT OF THIS OPERATION: the authority's CREDENTIAL does not move. The
 * script hash is a function of the one-shot seed UTxO, not of the signers, so
 * rotating signers is a datum edit and `upgrade_cred` in the protocol params is
 * untouched. That is what makes rotation cheap and an authority handover
 * (`NominateAuthority`/`PromoteAuthority`) a different operation entirely.
 *
 * The five rails `upgrade_multisig.spend` enforces, and where each is satisfied:
 *   1. the OLD tree is `satisfied`      -> `signerKeyHashes`, preflighted below
 *   2. exactly one continuing output at this address -> the single payToAddress
 *   3. non-ADA value EXACTLY conserved  -> every non-lovelace unit carried over
 *   4. no reference script on it        -> none is set
 *   5. the NEW tree is `well_formed`    -> `multisigScriptDatum`, which is a
 *      faithful port of upstream's `shape_ok`/`max_size`
 *
 * ⚠ LOVELACE IS CARRIED FORWARD UNCHANGED. The validator leaves it
 * unconstrained in both directions, and the input's own figure was already
 * min-UTxO-valid for an output of this shape — the datum is the only thing
 * changing size, and a tree is bounded at 20 nodes.
 *
 * ⛔ REFUSES A CURRENT TREE CONTAINING `Before`, `After` OR `Script` LEAVES.
 * Satisfying those needs a validity interval this builder does not set, or a
 * second script's `withdraw` handler marshalled into this transaction with its
 * own reference inputs and redeemer. Rather than half-support them — build a
 * transaction that passes the offline preflight and then fails on chain — they
 * are refused by name, exactly as `buildMultisigGenesisTx` refuses the same
 * shapes. A deployment governed by such a tree must build this transaction
 * itself. The NEW tree is unrestricted: rotating TO an `After` leaf is legal on
 * chain and is the authority's own risk.
 */
export async function buildRotateMultisigTx(params: RotateMultisigTxParams): Promise<UnsignedTx> {
  const { blueprint, deployment, configUtxo, newTree, signerKeyHashes } = params;

  if (!blueprint || typeof blueprint !== "object") {
    throw new Error(
      `rotate-multisig: blueprint is required — the ${"upgrade_multisig"} script body is ` +
        `parameterised from it and attached to this transaction.`
    );
  }
  if (!configUtxo || typeof configUtxo !== "object" || configUtxo.transactionId === undefined) {
    throw new Error(
      `rotate-multisig: configUtxo is required — the UTxO holding the config NFT, as ` +
        `locateUpgradeMultisig() found it. Do not pass deployment.upgradeMultisig.utxo: that ` +
        `coordinate is a record of the bootstrap and every rotation moves it.`
    );
  }

  const policy = deployment.upgradeMultisig.scriptHash;
  const heldUnits = unitsOfPolicy(configUtxo, policy);
  if (heldUnits.length === 0) {
    throw new Error(
      `rotate-multisig: the UTxO ${refOf(configUtxo).txHash}#${refOf(configUtxo).outputIndex} ` +
        `carries no asset of policy ${policy}, so it is not this deployment's config UTxO. ` +
        `Spending it would not rotate anything, and ${"upgrade_multisig.spend"} would refuse it ` +
        `for failing the value-conservation rail.`
    );
  }

  const currentDatum = getInlineDatum(configUtxo);
  if (!currentDatum) {
    throw new Error(
      `rotate-multisig: the config UTxO carries no inline datum, so there is no current tree to ` +
        `satisfy — and the spend rail is "the tree being replaced must approve its replacement". ` +
        `Such a UTxO cannot be spent at all.`
    );
  }
  const currentTree = decodeMultisigScript(currentDatum);

  const unsupported = unsupportedLeafKinds(currentTree);
  if (unsupported.length > 0) {
    throw new Error(
      `rotate-multisig: the CURRENT authority tree contains ${unsupported.join(" and ")} leaf ` +
        `kind(s), which this builder cannot satisfy. A "before"/"after" leaf needs a validity ` +
        `interval this transaction does not set; a "script" leaf needs that script's own ` +
        `withdraw-0 marshalled in here, with its reference inputs and redeemer. Building anyway ` +
        `would produce a transaction that passes every offline check and fails on chain with an ` +
        `empty trace list. A deployment governed by such a tree must build this rotation itself.`
    );
  }

  // ⛔ ENCODE THE NEW TREE FIRST. `multisigScriptDatum` is where upstream's
  // `well_formed` lives — 28-byte leaves, non-empty and duplicate-free child
  // lists, `1 <= required <= |scripts|`, size <= 20. Encoding before anything
  // is spent means a malformed tree costs nothing, and an unsatisfiable
  // authority is the one mistake with no repair path.
  const newDatum = multisigScriptDatum(newTree);

  if (!params.allowUnchangedTree) {
    const before = Bytes.toHex(Data.toCBORBytes(currentDatum));
    const after = Bytes.toHex(Data.toCBORBytes(newDatum));
    if (before === after) {
      throw new Error(
        `rotate-multisig: the new tree is BYTE-IDENTICAL to the one on chain, so this rotation ` +
          `would spend a UTxO, pay a fee and change nothing. That is almost always a caller bug ` +
          `— a tree built from a stale read, or an edit that did not take. The chain permits it; ` +
          `this refusal is the SDK being stricter. Pass allowUnchangedTree: true if you mean it.\n` +
          `  tree (both): ${JSON.stringify(currentTree, bigintReplacer)}`
      );
    }
  }

  if (!Array.isArray(signerKeyHashes) || signerKeyHashes.length === 0) {
    throw new Error(
      `rotate-multisig: signerKeyHashes is required and must be non-empty — the key hashes that ` +
        `will sign, which become this transaction's required_signers. The old tree must be ` +
        `satisfied by them, and which satisfying subset signs is your decision: for an "any-of" ` +
        `or "at-least" tree there is more than one answer, so there is nothing to infer.`
    );
  }
  for (const k of signerKeyHashes) {
    if (typeof k !== "string" || !/^[0-9a-fA-F]{56}$/.test(k)) {
      throw new Error(
        `rotate-multisig: signerKeyHashes entries must be 28-byte hex key hashes (56 hex ` +
          `chars); got ${JSON.stringify(k)}. A hash of any other length can never match an ` +
          `extra_signatories entry, so the old tree could not be satisfied by it.`
      );
    }
  }

  // ⛔ THE PREFLIGHT, AND IT ONLY EVER REFUSES. A `true` here grants nothing —
  // the ledger decides — but a `false` is certain, and catching it now replaces
  // a script failure with an empty trace list by a sentence naming the gap.
  if (!satisfiesMultisigTree(currentTree, { signatories: signerKeyHashes })) {
    throw new Error(
      `rotate-multisig: the signers you named do NOT satisfy the authority tree currently on ` +
        `chain, so ${"upgrade_multisig.spend"} would refuse this transaction — as a script ` +
        `failure with an empty trace list, which names nothing.\n` +
        `  on-chain tree: ${JSON.stringify(currentTree, bigintReplacer)}\n` +
        `  signers named: ${signerKeyHashes.join(", ")}\n` +
        `The tree being replaced is the one that must approve its replacement.`
    );
  }

  const address = upgradeMultisigAddress(params.client.chain.id, deployment);
  const scripts = createStandardScripts(blueprint);
  const script = scripts.upgradeMultisig(deployment.upgradeMultisig.txInput);
  if (script.hash.toLowerCase() !== policy.toLowerCase()) {
    throw new Error(
      `rotate-multisig: the blueprint and seed in this deployment parameterise ` +
        `${"upgrade_multisig"} to ${script.hash}, but the deployment records ` +
        `${policy}. One of the two is from a different protocol instance, and attaching the ` +
        `wrong script body yields a transaction the ledger refuses for a missing script witness.`
    );
  }

  // Rail 3: non-ADA value EXACTLY conserved. Every non-lovelace unit the input
  // holds is carried forward — not just the NFT, because `expect_match_assets`
  // compares the whole non-ADA value and junk bundled into the input must
  // travel with it.
  const carried = new Map<string, bigint>();
  for (const unit of EvoAssets.getUnits(configUtxo.assets)) {
    if (unit === "lovelace") continue;
    carried.set(unit, EvoAssets.getByUnit(configUtxo.assets, unit));
  }

  let tx = params.client.newTx();
  tx = tx.collectFrom({ inputs: [configUtxo], redeemer: voidData() });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(address),
    assets: outputAssets(EvoAssets.lovelaceOf(configUtxo.assets), carried),
    datum: new InlineDatum.InlineDatum({ data: newDatum }),
  });
  tx = tx.attachScript({ script: buildEvoScript(script.compiledCode) });
  for (const keyHash of signerKeyHashes) {
    tx = tx.addSigner({ keyHash: KeyHash.fromHex(keyHash) });
  }

  return finishUnsignedTx(tx, params, "rotate-multisig", {
    upgradeMultisigScriptHash: policy,
    configUtxoSpent: refOf(configUtxo),
    requiredSigners: [...signerKeyHashes],
    newTree,
  });
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}` : v);

// ---------------------------------------------------------------------------
// Operations 2 and 3 — the three `protocol_params` spend arms
// ---------------------------------------------------------------------------

/**
 * How a transaction satisfies the credential that must authorise a
 * `protocol_params` spend.
 *
 * ⛔ THIS SHAPE IS WHAT MAKES A MULTISIG → MULTISIG HANDOVER POSSIBLE, and its
 * absence is why no such handover has ever been executed. The harness's router
 * refuses any script authority that is not *this deployment's* `upgradeMultisig`
 * by name, because it reconstructs the script body and config UTxO from
 * `DeploymentParams`. A nominee authority has a different hash, a different
 * seed, a different config UTxO and a different body — exactly the case that
 * guard rejects. So the only handover the harness can perform is multisig → KEY.
 *
 * ⇒ Here the caller supplies the credential, its body and its config UTxO.
 * Nothing is reconstructed, nothing is compared against the deployment, and a
 * promotion can therefore be authorised by an authority the deployment has
 * never heard of — which is precisely what a promotion is.
 */
export type UpgradeAuthorisation =
  | {
      readonly kind: "key";
      /**
       * The key credential's hash. A key withdrawal carries no script and so
       * needs no witness and no redeemer; the entry's PRESENCE is the
       * authorisation.
       */
      readonly keyHash: HexString;
    }
  | {
      readonly kind: "script";
      /** The script credential's hash. Must equal the credential the datum names. */
      readonly scriptHash: ScriptHash;
      /** The script body, attached as the withdrawal's witness. */
      readonly compiledCode: HexString;
      /**
       * The UTxO whose datum this script reads to decide, supplied as a
       * REFERENCE input.
       *
       * ⛔ A REFERENCE INPUT, NEVER A SPENT ONE. Upstream is explicit: the
       * config UTxO cannot be spent and referenced in one transaction — the
       * ledger's `ConwayUtxoBabbageNonDisjointRefInputs` rule forbids it — which
       * is why a signer rotation and a protocol upgrade are always two
       * transactions.
       */
      readonly configUtxo: UTxO;
      /**
       * Key hashes to name as `required_signers`.
       *
       * ⚠ A WALLET THAT MERELY SIGNS IS NOT ENOUGH. `satisfied` on a
       * `Signature` leaf reads `extra_signatories`, which is the transaction's
       * `required_signers` field, so the hash must be named explicitly.
       */
      readonly signerKeyHashes: readonly HexString[];
    };

/** Common inputs to every `protocol_params` spend. */
export interface ParamsSpendTxParams extends BootstrapBuildContext {
  readonly blueprint: PlutusBlueprint;
  readonly deployment: DeploymentParams;
  /**
   * The params UTxO, as {@link locateProtocolParams} found it.
   *
   * ⚠ NOT `deployment.protocolParams.utxo` — every upgrade moves it.
   */
  readonly paramsUtxo: UTxO;
  /** Who authorises, and how. See {@link UpgradeAuthorisation}. */
  readonly authorisation: UpgradeAuthorisation;
}

const credKey = (c: { type: string; hash: string }): string =>
  `${c.type}:${c.hash.toLowerCase()}`;

function sameCred(
  a: { type: string; hash: string } | null,
  b: { type: string; hash: string } | null
): boolean {
  if (a === null || b === null) return a === b;
  return credKey(a) === credKey(b);
}

const renderCred = (c: { type: string; hash: string } | null): string =>
  c === null ? "None" : `${c.type}(${c.hash})`;

/** Every credential in the datum must be a 28-byte hash, or upgrades brick forever. */
function assertCredentialsWellFormed(p: ProtocolParamsData, where: string): void {
  const fields: Array<[string, { type: string; hash: string } | null]> = [
    ["plgCred", p.plgCred],
    ["issuanceLogicCred", p.issuanceLogicCred],
    ["transferCred", p.transferCred],
    ["thirdPartyCred", p.thirdPartyCred],
    ["upgradeCred", p.upgradeCred],
    ["pendingUpgradeCred", p.pendingUpgradeCred],
  ];
  for (const [name, cred] of fields) {
    if (cred === null || cred === undefined) continue;
    if (typeof cred.hash !== "string" || !/^[0-9a-fA-F]{56}$/.test(cred.hash)) {
      throw new Error(
        `${where}: the new params datum's ${name} is not a 28-byte hash ` +
          `(${JSON.stringify(cred.hash)}). ⛔ THIS IS THE ONE-WAY BRICK. A reward account is a ` +
          `header byte plus a 28-byte hash, so a wrong-length credential can never appear in ` +
          `tx.withdrawals — and every future ProtocolUpgrade, NominateAuthority and ` +
          `PromoteAuthority is authorised by a withdrawal. Writing one ends the protocol's ` +
          `upgradability permanently, with no repair path at any timescale. ` +
          `${"`params_well_formed`"} refuses it on chain; this refuses it before a fee is paid.`
      );
    }
  }
}

/**
 * Build any of the three `protocol_params` spend arms.
 *
 * Shared by the three exported entry points so the redeemer, the value rails
 * and the authorisation wiring have ONE implementation. The arm-specific rules
 * are applied by the caller before this runs.
 */
async function buildParamsSpend(
  params: ParamsSpendTxParams,
  act: ProtocolParamsActVariant,
  nextParams: ProtocolParamsData,
  label: string,
  extraMetadata: Record<string, unknown>
): Promise<UnsignedTx> {
  const { blueprint, deployment, paramsUtxo, authorisation } = params;

  if (!blueprint || typeof blueprint !== "object") {
    throw new Error(`${label}: blueprint is required — the protocol_params body is attached from it.`);
  }
  if (!paramsUtxo || typeof paramsUtxo !== "object" || paramsUtxo.transactionId === undefined) {
    throw new Error(
      `${label}: paramsUtxo is required — the UTxO holding the params NFT, as ` +
        `locateProtocolParams() found it. Do not pass deployment.protocolParams.utxo: every ` +
        `upgrade moves that coordinate.`
    );
  }
  if (unitsOfPolicy(paramsUtxo, deployment.protocolParams.policyId).length === 0) {
    throw new Error(
      `${label}: the UTxO ${refOf(paramsUtxo).txHash}#${refOf(paramsUtxo).outputIndex} carries no ` +
        `asset of policy ${deployment.protocolParams.policyId}, so it is not this deployment's ` +
        `params UTxO. Spending it upgrades nothing.`
    );
  }

  assertCredentialsWellFormed(nextParams, label);

  const networkId = params.client.chain.id;
  const scripts = createStandardScripts(blueprint);
  const paramsScript = scripts.protocolParams(deployment.protocolParams.txInput);
  if (paramsScript.hash.toLowerCase() !== deployment.protocolParams.policyId.toLowerCase()) {
    throw new Error(
      `${label}: the blueprint and seed in this deployment parameterise protocol_params to ` +
        `${paramsScript.hash}, but the deployment records ${deployment.protocolParams.policyId}. ` +
        `One of the two belongs to a different protocol instance.`
    );
  }

  const nextDatum = protocolParamsDatum(nextParams);
  const address = protocolParamsAddress(networkId, deployment);

  let tx = params.client.newTx();

  // ⛔ THE REDEEMER DECLARES THE ACT, through exactly one call site for all
  // three arms. `ProtocolUpgrade` encodes as `Constr(0, [])`, byte-identical to
  // the `voidData()` it replaced, so a defaulted or duplicated call site could
  // emit the old bytes forever with no decoder anywhere — on chain or off —
  // able to tell. Arms 1 and 2 cannot be represented by `voidData()`, so
  // routing all three through here is what proves the call site is live.
  tx = tx.collectFrom({ inputs: [paramsUtxo], redeemer: protocolParamsRedeemer(act) });
  tx = tx.attachScript({ script: buildEvoScript(paramsScript.compiledCode) });

  // ⛔ THE ADA LEG IS RE-FLOORED, AND THE FLOOR ARGUMENT IS LOAD-BEARING.
  // min-UTxO scales with serialised output size, and `pendingUpgradeCred` is
  // the one field whose size changes — `None` is 3 bytes of CBOR,
  // `Some(Credential)` about 40. So a NOMINATION widens this output past the
  // floor the genesis funded it to.
  //
  // MEASURED on devnet 2026-09-10, before the re-flooring existed: carrying the
  // input's 2,000,000 lovelace through a nomination was rejected at SUBMISSION
  // with ledger code 3125, `minimumRequiredValue 2,012,770`. ⚠ Evolution does
  // NOT rescue an under-funded explicit `payToAddress` — its min-UTxO arithmetic
  // applies to CHANGE outputs only — and the ledger says "insufficient Ada",
  // never "your datum grew". Nothing offline notices.
  //
  // ⛔ AND `minUtxoAtLeast` TAKES THE CURRENT LOVELACE AS ITS FLOOR, so this
  // only ever RAISES. Audit r1 M11 replaced that floor with `0n` and the whole
  // suite stayed green: the measured consequence was a promotion — which
  // shrinks the datum back to `None` — re-setting this output from 2,012,770
  // down to 1,861,920, draining 150,850 lovelace per promotion into change,
  // with the chain permitting it because lovelace is unconstrained relative to
  // the input. The floor is the only thing stopping it.
  const carried = paramsUtxo.assets;
  const coinsPerUtxoByte = (await params.client.getProtocolParameters()).coinsPerUtxoByte;
  const outAssets = EvoAssets.withLovelace(
    carried,
    minUtxoAtLeast(EvoAssets.lovelaceOf(carried), {
      address,
      assets: carried,
      datum: nextDatum,
      coinsPerUtxoByte,
    })
  );

  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(address),
    assets: outAssets,
    datum: new InlineDatum.InlineDatum({ data: nextDatum }),
  });

  // ⛔⛔ EXACTLY ONE WITHDRAWAL, and for a promotion that is not a style point.
  // Upstream's promote rail is `pairs.has_key(withdrawals, nominee)` — an
  // EXISTENCE check that never mentions the sitting authority — so a promotion
  // carrying BOTH withdrawals is ACCEPTED on chain. The property "a promotion
  // does not need the outgoing authority" is therefore unenforceable by any
  // on-chain negative, and the only guard is that there is one `withdraw` call
  // here and the built transaction's withdrawal set is returned in `metadata`
  // for a caller to assert on.
  const withdrewFrom: Array<{ type: string; hash: string }> = [];
  if (authorisation.kind === "script") {
    // A script withdraw-0 needs FOUR things, and three are invisible offline:
    //   1. the withdrawal entry        -> withdraw() below
    //   2. a SCRIPT WITNESS            -> attachScript below
    //   3. a REGISTERED stake credential -> the caller's job, before this tx
    //   4. the CONFIG UTxO as a REFERENCE INPUT -> readFrom below
    // (4) is what a plain script withdraw-0 does not need: upgrade_multisig's
    // withdraw handler finds its tree among `self.reference_inputs` and can do
    // nothing without it. Omitting (3) reports as code 3141, "rewards
    // withdrawals must consume rewards in full", which reads as a balance
    // problem and means an UNREGISTERED credential.
    if (!authorisation.configUtxo || authorisation.configUtxo.transactionId === undefined) {
      throw new Error(
        `${label}: a script authorisation requires configUtxo — the UTxO whose datum the ` +
          `authorising script reads. upgrade_multisig.withdraw finds its tree among the ` +
          `reference inputs and can decide nothing without it, so a withdrawal built without ` +
          `it fails on chain with an empty trace list.`
      );
    }
    if (!/^[0-9a-fA-F]+$/.test(authorisation.compiledCode ?? "")) {
      throw new Error(
        `${label}: a script authorisation requires compiledCode — the authorising script's ` +
          `body, attached as the withdrawal's witness. Without it the ledger answers ` +
          `"An associated script witness is missing" on purpose=withdraw, which names the ` +
          `shape but not the script.`
      );
    }
    tx = tx.withdraw({
      stakeCredential: Credential.makeScriptHash(Bytes.fromHex(authorisation.scriptHash)),
      amount: 0n,
      // The withdraw handler ignores its redeemer; a script-witnessed
      // withdrawal still requires one to be present.
      redeemer: voidData(),
    });
    tx = tx.attachScript({ script: buildEvoScript(authorisation.compiledCode) });
    tx = tx.readFrom({ referenceInputs: [authorisation.configUtxo] });
    for (const keyHash of authorisation.signerKeyHashes ?? []) {
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(keyHash) });
    }
    withdrewFrom.push({ type: "script", hash: authorisation.scriptHash });
  } else {
    tx = tx.withdraw({
      stakeCredential: Credential.makeKeyHash(Bytes.fromHex(authorisation.keyHash)),
      amount: 0n,
    });
    tx = tx.addSigner({ keyHash: KeyHash.fromHex(authorisation.keyHash) });
    withdrewFrom.push({ type: "key", hash: authorisation.keyHash });
  }

  return finishUnsignedTx(tx, params, label, {
    act,
    paramsUtxoSpent: refOf(paramsUtxo),
    withdrewFrom,
    nextParams,
    ...extraMetadata,
  });
}

/** Which credential each arm requires, and refuse a mismatch by name. */
function assertAuthorisationMatches(
  authorisation: UpgradeAuthorisation,
  required: { type: string; hash: string },
  label: string,
  role: string
): void {
  const offered =
    authorisation.kind === "script"
      ? { type: "script", hash: authorisation.scriptHash }
      : { type: "key", hash: authorisation.keyHash };
  if (sameCred(offered, required)) return;
  throw new Error(
    `${label}: this arm is authorised by ${role}, which the on-chain datum names as ` +
      `${renderCred(required)} — but the authorisation you supplied is ${renderCred(offered)}.\n` +
      `⚠ THE WRONG CHOICE IS SILENT ON THE BUILD SIDE: the validator does not refuse an extra ` +
      `withdrawal for being extra, it simply does not read it, so the transaction is refused for ` +
      `MISSING the one the rule names — and a reader who assumed the arms are symmetric sees a ` +
      `bare script failure rather than their own mistake. ` +
      `ProtocolUpgrade and NominateAuthority want the SITTING authority; PromoteAuthority wants ` +
      `the STANDING NOMINEE and the sitting authority does not appear in it at all.`
  );
}

export interface ProtocolUpgradeTxParams extends ParamsSpendTxParams {
  /**
   * The current params in, the desired params out.
   *
   * ⚠ BOTH AUTHORITY FIELDS ARE FROZEN BY THIS ARM. Moving `upgradeCred` or
   * `pendingUpgradeCred` here is refused below, because the validator refuses
   * it on chain: an authority handover can never ride inside a transaction that
   * looks like a parameter change.
   */
  readonly change: (current: ProtocolParamsData) => ProtocolParamsData;
}

/**
 * Operation 2 — rewrite the live wiring in place, under `ProtocolUpgrade`.
 *
 * Authorised by the SITTING authority's withdraw-0. Everything except the two
 * authority fields may change, subject to every credential being a well-formed
 * 28-byte hash.
 *
 * ⚑ THE NEW CREDENTIALS NEED NOT BE DEPLOYED OR REGISTERED. `params_well_formed`
 * length-checks them and nothing more, which is what makes a deliberate break
 * (pointing the protocol at credentials that do not exist) possible — and
 * recoverable, because the revert is authorised by `upgradeCred`, which this
 * arm freezes and which no delegate credential influences.
 */
export async function buildProtocolUpgradeTx(params: ProtocolUpgradeTxParams): Promise<UnsignedTx> {
  const label = "protocol-upgrade";
  const current = requireParamsDatum(params.paramsUtxo, label);
  if (typeof params.change !== "function") {
    throw new Error(`${label}: change is required — a function from the current params to the new ones.`);
  }
  const next = params.change(current);
  if (!next || typeof next !== "object") {
    throw new Error(`${label}: change() must return a params object; got ${JSON.stringify(next)}.`);
  }

  if (!sameCred(next.upgradeCred, current.upgradeCred)) {
    throw new Error(
      `${label}: this arm FREEZES upgradeCred, and your change moved it from ` +
        `${renderCred(current.upgradeCred)} to ${renderCred(next.upgradeCred)}. ` +
        `An authority handover can never ride inside a parameter change — that separation is ` +
        `the reason the three arms exist. Changing the authority is two transactions: ` +
        `buildNominateAuthorityTx then buildPromoteAuthorityTx, the second authorised by the ` +
        `nominee itself.`
    );
  }
  if (!sameCred(next.pendingUpgradeCred, current.pendingUpgradeCred)) {
    throw new Error(
      `${label}: this arm FREEZES pendingUpgradeCred, and your change moved it from ` +
        `${renderCred(current.pendingUpgradeCred)} to ${renderCred(next.pendingUpgradeCred)}. ` +
        `Use buildNominateAuthorityTx to write a nomination.`
    );
  }

  assertAuthorisationMatches(params.authorisation, current.upgradeCred, label, "the SITTING authority");
  return buildParamsSpend(params, "PROTOCOL_UPGRADE", next, label, {
    previousParams: current,
  });
}

export interface NominateAuthorityTxParams extends ParamsSpendTxParams {
  /**
   * The successor credential to write into `pendingUpgradeCred`, or `null` to
   * withdraw a standing nomination.
   *
   * ⚑ NO LIVENESS CHECK, by ruling (Giovanni, 2026-10-01). A nomination to a
   * credential that is not yet registered is legal and recoverable — the
   * promotion simply cannot run until it is. Only a MALFORMED credential is
   * fatal, and that is refused.
   */
  readonly nominee: { readonly type: "key" | "script"; readonly hash: HexString } | null;
}

/**
 * Operation 3, phase 1 — write a nomination, under `NominateAuthority`.
 *
 * Authorised by the SITTING authority. The arm freezes everything except
 * `pendingUpgradeCred`, so this cannot smuggle a parameter change.
 *
 * ⚑ REVERSIBLE. A nomination is an ordinary upgrade of one field; writing
 * `null` withdraws it. Only the promotion is one-way.
 */
export async function buildNominateAuthorityTx(params: NominateAuthorityTxParams): Promise<UnsignedTx> {
  const label = "nominate-authority";
  const current = requireParamsDatum(params.paramsUtxo, label);
  if (params.nominee !== null && (!params.nominee || typeof params.nominee !== "object")) {
    throw new Error(
      `${label}: nominee is required — a credential to nominate, or an explicit null to ` +
        `withdraw a standing nomination. There is no default: who may take over a protocol is ` +
        `not a value this SDK will choose.`
    );
  }
  const next: ProtocolParamsData = { ...current, pendingUpgradeCred: params.nominee };

  if (sameCred(next.pendingUpgradeCred, current.pendingUpgradeCred)) {
    throw new Error(
      `${label}: the nomination already reads ${renderCred(current.pendingUpgradeCred)} on chain, ` +
        `so this transaction would spend the params UTxO, pay a fee and change nothing.`
    );
  }

  assertAuthorisationMatches(params.authorisation, current.upgradeCred, label, "the SITTING authority");
  return buildParamsSpend(params, "NOMINATE_AUTHORITY", next, label, {
    nominee: params.nominee,
    previousNomination: current.pendingUpgradeCred,
  });
}

/**
 * Operation 3, phase 2 — promote the standing nominee, under
 * `PromoteAuthority`.
 *
 * ⛔ AUTHORISED BY THE NOMINEE'S OWN WITHDRAW-0, and the sitting authority does
 * not appear at all. This is the only transaction shape that may move
 * `upgradeCred`, and the evidence it demands is that the incoming authority
 * EXISTS, RUNS and CONSENTS — so a typo, or the hash of a script nobody
 * deployed, can never take over.
 *
 * ⚠ THE NOMINEE'S STAKE CREDENTIAL MUST ALREADY BE REGISTERED, in a STRICTLY
 * EARLIER transaction. The ledger applies withdrawals against reward-account
 * state BEFORE it applies certificates, so registering and withdrawing in one
 * transaction is not one transaction, it is two. Omitting the registration
 * reports as code 3141, which reads as a balance problem.
 *
 * ⚑ THE NEW DATUM IS COMPUTED, NOT SUPPLIED. The arm permits exactly
 * `{...old, upgradeCred: nominee, pendingUpgradeCred: None}`, so there is
 * nothing for a caller to decide and a `change` hook here could only be used to
 * build a transaction the chain refuses.
 */
export async function buildPromoteAuthorityTx(params: ParamsSpendTxParams): Promise<UnsignedTx> {
  const label = "promote-authority";
  const current = requireParamsDatum(params.paramsUtxo, label);
  const nominee = current.pendingUpgradeCred;
  if (nominee === null || nominee === undefined) {
    throw new Error(
      `${label}: there is NO STANDING NOMINATION in the params datum, so there is nothing to ` +
        `promote. ${"`promote_authority`"} begins ` +
        `${"`expect Some(nominee) = old.pending_upgrade_cred`"}, so this transaction cannot ` +
        `validate. Write a nomination first with buildNominateAuthorityTx — authorised by the ` +
        `sitting authority ${renderCred(current.upgradeCred)} — and promote it in a later ` +
        `transaction.`
    );
  }

  const next: ProtocolParamsData = { ...current, upgradeCred: nominee, pendingUpgradeCred: null };
  assertAuthorisationMatches(params.authorisation, nominee, label, "the STANDING NOMINEE");

  return buildParamsSpend(params, "PROMOTE_AUTHORITY", next, label, {
    promoted: nominee,
    previousAuthority: current.upgradeCred,
  });
}

/** The current params, read off the UTxO being spent — the only source of truth. */
function requireParamsDatum(paramsUtxo: UTxO | undefined, label: string): ProtocolParamsData {
  if (!paramsUtxo || typeof paramsUtxo !== "object" || paramsUtxo.transactionId === undefined) {
    throw new Error(
      `${label}: paramsUtxo is required — the UTxO holding the params NFT, as ` +
        `locateProtocolParams() found it.`
    );
  }
  const datum = getInlineDatum(paramsUtxo);
  if (!datum) {
    throw new Error(
      `${label}: the params UTxO carries no inline datum, so the current wiring cannot be read. ` +
        `Every arm's rules are evaluated against the datum being SPENT — the state decides who ` +
        `may spend it — so there is nothing to build from.`
    );
  }
  return decodeProtocolParams(datum);
}
