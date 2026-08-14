/**
 * Standard script parameterization.
 *
 * Replicates the parameterization chain from ProtocolScriptBuilderService.java.
 * Uses Evolution SDK directly for UPLC.applyParamsToScript and ScriptHash.
 *
 * Dependency graph:
 *
 *   always_fail(nonce) → hash
 *   protocol_params_mint(utxo_ref, always_fail_hash) → hash
 *   programmable_logic_global(protocol_params_hash) → hash
 *   programmable_logic_base(Script(plg_hash)) → hash
 *   issuance_cbor_hex_mint(utxo_ref, always_fail_hash) → hash
 *   registry_mint(utxo_ref, issuance_cbor_hex_hash) → hash
 *   registry_spend(protocol_params_hash) → hash
 *   issuance_mint(Script(plb_hash), registry_mint_hash, Script(minting_logic_hash)) → hash
 */

import { Data } from "@evolution-sdk/evolution";
import type {
  DeploymentParams,
  HexString,
  PlutusBlueprint,
  PlutusScript,
  ScriptHash,
  TxInput,
} from "../types.js";
import { getValidatorCode, STANDARD_VALIDATORS } from "./blueprint.js";
import {
  parameterizeScript,
  outputReference,
  scriptCredential,
} from "../core/evo-utils.js";

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

export interface StandardScripts {
  alwaysFail(nonce: HexString): PlutusScript;
  protocolParamsMint(utxoRef: TxInput, alwaysFailHash: ScriptHash): PlutusScript;
  programmableLogicGlobal(protocolParamsHash: ScriptHash): PlutusScript;
  programmableLogicBase(plgHash: ScriptHash): PlutusScript;
  issuanceCborHexMint(utxoRef: TxInput, alwaysFailHash: ScriptHash): PlutusScript;
  registryMint(utxoRef: TxInput, issuanceCborHexHash: ScriptHash): PlutusScript;
  registrySpend(protocolParamsHash: ScriptHash): PlutusScript;
  issuanceMint(plbHash: ScriptHash, registryMintHash: ScriptHash, mintingLogicHash: ScriptHash): PlutusScript;
}

/**
 * Create standard script builders from a blueprint.
 * Uses Evolution SDK directly for parameterization and hashing.
 */
export function createStandardScripts(
  blueprint: PlutusBlueprint,
): StandardScripts {
  function parameterize(validatorTitle: string, params: Data.Data[]): PlutusScript {
    const code = getValidatorCode(blueprint, validatorTitle);
    return parameterizeScript(code, params);
  }

  return {
    alwaysFail(nonce) {
      return parameterize(STANDARD_VALIDATORS.ALWAYS_FAIL, [
        Data.bytearray(nonce),
      ]);
    },

    protocolParamsMint(utxoRef, alwaysFailHash) {
      return parameterize(STANDARD_VALIDATORS.PROTOCOL_PARAMS_MINT, [
        outputReference(utxoRef),
        Data.bytearray(alwaysFailHash),
      ]);
    },

    programmableLogicGlobal(protocolParamsHash) {
      return parameterize(STANDARD_VALIDATORS.PROGRAMMABLE_LOGIC_GLOBAL, [
        Data.bytearray(protocolParamsHash),
      ]);
    },

    programmableLogicBase(plgHash) {
      return parameterize(STANDARD_VALIDATORS.PROGRAMMABLE_LOGIC_BASE, [
        scriptCredential(plgHash),
      ]);
    },

    issuanceCborHexMint(utxoRef, alwaysFailHash) {
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_CBOR_HEX_MINT, [
        outputReference(utxoRef),
        Data.bytearray(alwaysFailHash),
      ]);
    },

    registryMint(utxoRef, issuanceCborHexHash) {
      return parameterize(STANDARD_VALIDATORS.REGISTRY_MINT, [
        outputReference(utxoRef),
        Data.bytearray(issuanceCborHexHash),
      ]);
    },

    registrySpend(protocolParamsHash) {
      return parameterize(STANDARD_VALIDATORS.REGISTRY_SPEND, [
        Data.bytearray(protocolParamsHash),
      ]);
    },

    issuanceMint(plbHash, registryMintHash, mintingLogicHash) {
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_MINT, [
        scriptCredential(plbHash),
        Data.bytearray(registryMintHash),
        scriptCredential(mintingLogicHash),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Deployment verification
// ---------------------------------------------------------------------------

/** One derived-vs-deployed script hash comparison. */
export interface ScriptHashCheck {
  /** Validator name, as it appears in the parameterization chain */
  name: string;
  /** Hash derived from the blueprint + deployment parameters */
  derived: ScriptHash;
  /** Hash recorded in DeploymentParams */
  deployed: ScriptHash;
}

/** Thrown when a blueprint does not reproduce its deployment's script hashes. */
export class DeploymentMismatchError extends Error {
  readonly mismatches: ScriptHashCheck[];

  constructor(mismatches: ScriptHashCheck[], blueprintTitle: string) {
    super(
      `Blueprint "${blueprintTitle}" does not reproduce this deployment. ` +
      `${mismatches.length} script hash(es) differ:\n` +
      mismatches
        .map((m) => `  ${m.name}: derived ${m.derived}, deployment says ${m.deployed}`)
        .join("\n") +
      `\nThe blueprint and the DeploymentParams describe different protocol instances. ` +
      `Transactions built from this pairing would be rejected at submission.`
    );
    this.name = "DeploymentMismatchError";
    this.mismatches = mismatches;
  }
}

/**
 * Derive every parameterizable standard script hash from the blueprint and
 * check it against DeploymentParams. Throws DeploymentMismatchError on any
 * difference; returns the full check list on success.
 *
 * Why this exists: parameterization changes are not always visible to the
 * compiler. Upstream has changed a parameter's *meaning* while keeping its
 * arity and type (protocol_params_mint's `always_fail_hash` became
 * `coordination_addr_hash` in 0.5.0-alpha.1), so a wrong value typechecks,
 * builds, and only fails when the ledger rejects the transaction. This is the
 * check that catches it, and it is why buildDeploymentScripts no longer
 * overwrites derived hashes with deployment values.
 *
 * Not covered: the two always_fail hashes (their nonces are not carried in
 * DeploymentParams) and issuance_mint (parameterized per minting logic).
 */
export function assertDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): ScriptHashCheck[] {
  const builders = createStandardScripts(blueprint);

  const checks: ScriptHashCheck[] = [
    {
      name: "protocol_params_mint",
      derived: builders.protocolParamsMint(
        deployment.protocolParams.txInput,
        deployment.protocolParams.alwaysFailScriptHash
      ).hash,
      deployed: deployment.protocolParams.policyId,
    },
    {
      name: "programmable_logic_global",
      derived: builders.programmableLogicGlobal(deployment.protocolParams.policyId).hash,
      deployed: deployment.programmableLogicGlobal.scriptHash,
    },
    {
      name: "programmable_logic_base",
      derived: builders.programmableLogicBase(
        deployment.programmableLogicGlobal.scriptHash
      ).hash,
      deployed: deployment.programmableLogicBase.scriptHash,
    },
    {
      name: "issuance_cbor_hex_mint",
      derived: builders.issuanceCborHexMint(
        deployment.issuance.txInput,
        deployment.issuance.alwaysFailScriptHash
      ).hash,
      deployed: deployment.issuance.policyId,
    },
    {
      name: "registry_mint",
      derived: builders.registryMint(
        deployment.directoryMint.txInput,
        deployment.issuance.policyId
      ).hash,
      deployed: deployment.directoryMint.scriptHash,
    },
    {
      name: "registry_spend",
      derived: builders.registrySpend(deployment.protocolParams.policyId).hash,
      deployed: deployment.directorySpend.scriptHash,
    },
  ];

  const mismatches = checks.filter((c) => c.derived !== c.deployed);
  if (mismatches.length > 0) {
    throw new DeploymentMismatchError(mismatches, blueprint.preamble.title);
  }
  return checks;
}

/**
 * Build resolved standard scripts from deployment params.
 *
 * Every derivable script hash is ASSERTED equal to its DeploymentParams value
 * (see assertDeploymentScripts). Earlier versions silently overwrote the
 * derived hash with the deployment's, which made a wrong parameterization
 * undetectable until submission.
 */
export function buildDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): ResolvedStandardScripts {
  assertDeploymentScripts(blueprint, deployment);

  const builders = createStandardScripts(blueprint);

  const protocolParamsMint = builders.protocolParamsMint(
    deployment.protocolParams.txInput,
    deployment.protocolParams.alwaysFailScriptHash
  );

  const programmableLogicGlobal = builders.programmableLogicGlobal(
    deployment.protocolParams.policyId
  );

  const programmableLogicBase = builders.programmableLogicBase(
    deployment.programmableLogicGlobal.scriptHash
  );

  const issuanceCborHexMint = builders.issuanceCborHexMint(
    deployment.issuance.txInput,
    deployment.issuance.alwaysFailScriptHash
  );

  const registryMint = builders.registryMint(
    deployment.directoryMint.txInput,
    deployment.issuance.policyId
  );

  const registrySpend = builders.registrySpend(
    deployment.protocolParams.policyId
  );

  return {
    protocolParamsMint,
    programmableLogicGlobal,
    programmableLogicBase,
    issuanceCborHexMint,
    registryMint,
    registrySpend,
    buildIssuanceMint(mintingLogicHash: ScriptHash) {
      return builders.issuanceMint(
        deployment.programmableLogicBase.scriptHash,
        deployment.directoryMint.scriptHash,
        mintingLogicHash
      );
    },
  };
}

export interface ResolvedStandardScripts {
  protocolParamsMint: PlutusScript;
  programmableLogicGlobal: PlutusScript;
  programmableLogicBase: PlutusScript;
  issuanceCborHexMint: PlutusScript;
  registryMint: PlutusScript;
  registrySpend: PlutusScript;
  /** Build issuance_mint for a specific minting logic — NOT cached */
  buildIssuanceMint(mintingLogicHash: ScriptHash): PlutusScript;
}
