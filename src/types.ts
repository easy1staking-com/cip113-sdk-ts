/**
 * Core types for the CIP-113 SDK.
 *
 * String aliases (HexString, Address, etc.) kept for readability.
 * Evolution SDK types used directly where possible.
 */

import type {
  Data as EvoData,
  UTxO as EvoUTxO,
  Script as EvoScript,
  Assets as EvoAssets,
} from "@evolution-sdk/evolution";

// ---------------------------------------------------------------------------
// Primitives (string aliases for readability)
// ---------------------------------------------------------------------------

/** Hex-encoded byte string */
export type HexString = string;

/** A Cardano policy ID (28-byte blake2b-224 hash, hex-encoded) */
export type PolicyId = HexString;

/** A Cardano script hash (same format as PolicyId) */
export type ScriptHash = HexString;

/** Bech32-encoded Cardano address */
export type Address = string;

/** Transaction hash (32-byte blake2b-256 hash, hex-encoded) */
export type TxHash = HexString;

// ---------------------------------------------------------------------------
// Re-exports from Evolution SDK
// ---------------------------------------------------------------------------

/** PlutusData — Evolution SDK's Data.Data type */
export type PlutusData = EvoData.Data;

/** UTxO — Evolution SDK's UTxO type */
export type UTxO = EvoUTxO.UTxO;

/** Script — Evolution SDK's Script type */
export type Script = EvoScript.Script;

/** Assets — Evolution SDK's Assets type */
export type Assets = EvoAssets.Assets;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface TxInput {
  txHash: TxHash;
  outputIndex: number;
}

/** Script metadata: compiled code + hash for parameterization and attachment */
export interface PlutusScript {
  type: "PlutusV3";
  compiledCode: HexString;
  hash: ScriptHash;
}

// ---------------------------------------------------------------------------
// Blueprint (CIP-57)
// ---------------------------------------------------------------------------

export interface BlueprintValidator {
  title: string;
  compiledCode: HexString;
  hash: HexString;
  parameters?: BlueprintParameter[];
}

export interface BlueprintParameter {
  title: string;
  schema: { $ref?: string } & Record<string, unknown>;
}

export interface PlutusBlueprint {
  preamble: {
    title: string;
    version: string;
    description?: string;
    plutusVersion?: string;
    /** Compiler that produced this blueprint — CIP-171 verifiers reproduce hashes with it */
    compiler?: {
      name: string;
      version: string;
    };
    license?: string;
  };
  validators: BlueprintValidator[];
  definitions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Deployment Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters from a deployed CIP-113 protocol instance.
 * Produced by the bootstrap transaction, consumed by all subsequent operations.
 */
export interface DeploymentParams {
  /** Bootstrap transaction hash */
  txHash: TxHash;

  /**
   * `protocol_params` — the merged mint+spend validator (#118).
   *
   * ⚑ `policyId` IS ALSO THE ADDRESS. The NFT policy id and the params
   * address's payment credential are the same 28 bytes: the mint handler locks
   * the NFT at `Script(own_policy)`, the minting policy naming itself. There is
   * deliberately no second field for the address — a second field is a second
   * chance to disagree.
   *
   * ⚠ No nonce and no lock-target hash. `protocol_params_mint` took
   * `(utxo_ref, coordination_hash)`, `coordination_spend` took `(nonce)`; both
   * validators are gone and the ordering cycle between them with them.
   */
  protocolParams: {
    /** The one-shot UTxO `protocol_params` is parameterised by. Already spent. */
    txInput: TxInput;
    /** Policy id AND address payment credential. One value, one derivation. */
    policyId: PolicyId;
    /** The params UTxO itself, so callers can supply it as a reference input. */
    utxo: TxInput;
  };

  /**
   * The three withdraw-0 delegates.
   *
   * ⚠ In alpha.3 they are parameterised `(prog_logic_cred, registry_node_cs,
   * max_inline_datum_bytes)` — arity 1 -> 3 — while keeping their titles. They
   * no longer read the params datum at all; PLB dispatches to the dispatcher,
   * which names them at compile time.
   */
  transfer: { scriptHash: ScriptHash };
  thirdParty: { scriptHash: ScriptHash };
  unfracking: { scriptHash: ScriptHash };

  /**
   * `programmable_logic_global` — the dispatcher, reintroduced by #117.
   *
   * Every programmable transaction now carries ONE MORE withdraw-0 (this one)
   * on top of its delegate's, so every withdrawal index shifts relative to
   * alpha.2.
   *
   * ⛔ UPGRADE-COHERENCE HAZARD, NOT ENFORCEABLE ON CHAIN. A script cannot read
   * another script's parameters, so nothing verifies that the three hashes
   * baked into this dispatcher agree with the `transfer_cred` /
   * `third_party_cred` the params datum carries for `issuance_mint`. They must
   * be written together. `assertDeploymentScripts` checks this off-chain
   * precisely because the ledger cannot.
   */
  programmableLogicGlobal: { scriptHash: ScriptHash };

  /**
   * `max_inline_datum_bytes` — a deployment CHOICE, not a derivation.
   *
   * ⚠ It is a compile-time parameter of all four delegates — transfer,
   * third_party, unfracking and issuance_logic — so it is baked into their
   * hashes: two deployments differing only here are different protocols.
   * Recorded because it cannot be recovered from any hash.
   */
  maxInlineDatumBytes: number;

  /**
   * `upgrade_multisig` as deployed — upstream's REFERENCE upgrade authority.
   *
   * ⚠ Deployed and hash-asserted, but NOT necessarily the ACTIVE authority. See
   * `upgradeAuthority`, which records what the params datum actually says.
   */
  upgradeMultisig: {
    /**
     * ⚑ ONE VALUE, THREE ROLES: the config NFT's POLICY ID, the config UTxO
     * address's PAYMENT CREDENTIAL, and the WITHDRAW-0 CREDENTIAL an upgrade
     * authorisation is satisfied by.
     *
     * ⛔ DO NOT ADD A SECOND FIELD FOR THE POLICY OR THE ADDRESS. This is the
     * same collapse `protocolParams` and `registry` already record, with one
     * more role attached: a second field is a second chance to disagree about
     * one fact, and the disagreement presents as a valid-looking address that
     * holds nothing.
     */
    scriptHash: ScriptHash;
    /**
     * The one-shot UTxO `upgrade_multisig` is parameterised by. Already spent.
     *
     * ⚠ IDENTICAL IN TYPE TO `protocolParams.txInput`, AND NOT INTERCHANGEABLE
     * WITH IT. Nothing can tell the two apart, and a record that reuses one for
     * both makes the `upgrade_multisig` hash assertion pass regardless of which
     * the code reads — the vacuity that hid a real defect for an entire
     * migration once already.
     */
    txInput: TxInput;
    /**
     * MUTABLE STATE — the config UTxO holding the NFT and the `MultisigScript`
     * tree, exactly as `protocolParams.utxo` holds the params datum. A signer
     * rotation SPENDS this UTxO and recreates it, so the recorded value goes
     * stale; re-read it rather than trusting an old record.
     */
    utxo: TxInput;
  };

  /**
   * `upgrade_multisig`'s reference script input.
   *
   * ⚠ Its body is ~2,791 B — far past what an authorisation can afford to
   * inline. Publishing the script without recording where it landed strands
   * every later authorisation: the credential is satisfiable in principle and
   * unusable in practice, with nothing to point at.
   */
  upgradeMultisigRefInput: TxInput;

  /**
   * The credential in the params datum's `upgrade_cred` field — the SOURCE OF
   * TRUTH for the ACTIVE upgrade authority, whatever `upgradeMultisig` records
   * as deployed.
   *
   * The validator only requires this credential to appear in `tx.withdrawals`;
   * it never inspects the authority's internals, so a verification-key
   * credential is as valid as a script one. ⛔ Nothing derives this from
   * `upgradeMultisig` and nothing may check the two against each other — a
   * deployment may legitimately name a key, an unrelated script, or the
   * multisig.
   *
   * ⚠ ALPHA.4 MAKES A HANDOVER TWO-PHASE. The params datum carries a
   * `pending_upgrade_cred` beside this one: a rotation NOMINATES the successor
   * there and a second transaction promotes it, so for the window between them
   * two credentials exist and only this one is live.
   *
   * ⚠ AN UNSATISFIABLE VALUE HERE IS A ONE-WAY BRICK, in upstream's own words:
   * it makes the authority check "permanently unsatisfiable, with no repair
   * path". A credential that cannot be registered — and therefore cannot appear
   * in a withdrawals map — is exactly that.
   */
  upgradeAuthority: { type: "key" | "script"; hash: ScriptHash };

  /**
   * `issuance_logic` — the withdraw-0 credential named by the params datum's
   * FIELD 1, and the replaceable half of issuance (alpha.4).
   *
   * ⚠ EVERY MINT AND EVERY BURN CARRIES ITS WITHDRAWAL. `issuance_mint`
   * dispatches to whatever the datum's field 1 says, so this credential is on
   * the critical path of both operations rather than of an occasional one.
   *
   * ⛔ IT MUST BE REGISTERED. An unregistered stake credential does not fail
   * with "not registered": the ledger reports code 3141, *"rewards withdrawals
   * must consume rewards in full"*, which reads as a balance problem and sends
   * the reader to the wrong subsystem.
   */
  issuanceLogic: { scriptHash: ScriptHash };

  /** `issuance_logic`'s reference script input. */
  issuanceLogicRefInput: TxInput;

  programmableLogicBase: {
    scriptHash: ScriptHash;
  };

  issuance: {
    txInput: TxInput;
    policyId: PolicyId;
    /** Still `always_fail` here — issuance_cbor_hex_mint's 2nd parameter is unchanged. */
    alwaysFailScriptHash: ScriptHash;
  };

  /**
   * `registry` — the merged mint+spend validator (#117).
   *
   * ⚑ `scriptHash` IS ALSO THE ADDRESS, same collapse as `protocolParams`: the
   * registry-node NFT policy id and the node address's payment credential are
   * one value. This replaces the old `directoryMint` / `directorySpend` PAIR,
   * whose two hashes were independently correct and are now one.
   */
  registry: {
    /** The one-shot UTxO `registry` is parameterised by. Already spent. */
    txInput: TxInput;
    /** `issuance_cbor_hex_mint`'s policy — the registry's 2nd parameter. */
    issuanceScriptHash: ScriptHash;
    /** Node NFT policy id AND node address payment credential. */
    scriptHash: ScriptHash;
  };

  /** Reference inputs carrying the deployed scripts. */
  programmableBaseRefInput: TxInput;
  /** The dispatcher's reference script — new in alpha.3, needed on every programmable tx. */
  programmableLogicGlobalRefInput: TxInput;
  transferRefInput: TxInput;
  thirdPartyRefInput: TxInput;
  unfrackingRefInput: TxInput;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type Network = "mainnet" | "preprod" | "preview";
