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
  Assets as EvoAssets,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";

import type { DeploymentParams, PolicyId, TxInput, UTxO } from "../types.js";
import type { MultisigScriptTree, ProtocolParamsData } from "../core/evo-utils.js";
import {
  decodeMultisigScript,
  decodeProtocolParams,
  getInlineDatum,
  scriptAddress,
} from "../core/evo-utils.js";

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
