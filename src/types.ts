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

  protocolParams: {
    txInput: TxInput;
    /**
     * `protocol_params_mint`'s policy id — i.e. its script hash. This is the
     * `params_policy` that now parameterises programmable_logic_base, transfer,
     * third_party, unfracking and issuance_mint.
     */
    policyId: PolicyId;
    /**
     * The lock target baked into `protocol_params_mint`'s 2nd parameter.
     *
     * ⚠ In 0.5.x this is `coordination_spend`'s hash. It was `always_fail`'s in
     * 0.3.x, and upstream kept the parameter's ARITY AND TYPE identical across
     * that change — so nothing in TypeScript, and nothing at build time, can
     * tell you if you supply the wrong one. `assertDeploymentScripts` is the
     * only thing that catches it. See PLAN.md D-04.
     */
    coordinationScriptHash: ScriptHash;
  };

  /**
   * The coordination UTxO — the live protocol wiring, introduced by upstream's
   * in-place upgradability work. It holds the protocol-params NFT and the
   * 7-field ProgrammableLogicGlobalParams datum, and every programmable_logic_base
   * spend reads it as a reference input.
   */
  /**
   * The nonce `coordination_spend` was parameterised with. Carried so the lock
   * target can be RE-DERIVED and asserted rather than trusted — without it,
   * protocol_params_mint's 2nd parameter is unverifiable and the silent
   * always_fail -> coordination_spend swap has nothing checking it.
   */
  coordinationNonce: HexString;

  coordination: {
    /** `coordination_spend`, parameterised by `coordinationNonce`. */
    scriptHash: ScriptHash;
    /** The UTxO itself, carried so callers can supply it as a reference input. */
    utxo: TxInput;
  };

  /**
   * The three withdraw-0 delegates that replaced programmable_logic_global.
   *
   * PLB no longer routes through a coordinator: it dispatches straight to one
   * of these, chosen by the BaseSpendRedeemer constructor. Their credentials
   * live in the coordination datum (fields 2, 3, 4) and are swappable in place.
   */
  transfer: { scriptHash: ScriptHash };
  thirdParty: { scriptHash: ScriptHash };
  unfracking: { scriptHash: ScriptHash };

  /** Upgrade authority named by coordination datum field 5 (`upgrade_cred`). */
  upgradeMultisig: { scriptHash: ScriptHash };

  programmableLogicBase: {
    scriptHash: ScriptHash;
  };

  issuance: {
    txInput: TxInput;
    policyId: PolicyId;
    /** Still `always_fail` here — issuance_cbor_hex_mint's 2nd parameter is unchanged. */
    alwaysFailScriptHash: ScriptHash;
  };

  directoryMint: {
    txInput: TxInput;
    issuanceScriptHash: ScriptHash;
    scriptHash: ScriptHash;
  };

  directorySpend: {
    policyId: PolicyId;
    scriptHash: ScriptHash;
  };

  /** Reference inputs carrying the deployed scripts. */
  programmableBaseRefInput: TxInput;
  transferRefInput: TxInput;
  thirdPartyRefInput: TxInput;
  unfrackingRefInput: TxInput;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type Network = "mainnet" | "preprod" | "preview";
