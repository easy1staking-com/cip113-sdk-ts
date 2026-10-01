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
  multisigScriptDatum,
  outputAssets,
  scriptAddress,
  voidData,
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
