/**
 * Freeze-and-Seize script builders.
 *
 * Replicates FreezeAndSeizeScriptBuilderService.java.
 * Uses Evolution SDK directly for parameterization and hashing.
 */

import { Data } from "@evolution-sdk/evolution";
import type { HexString, PlutusBlueprint, PlutusScript, ScriptHash, TxInput } from "../../types.js";
import { getValidatorCode } from "../../standard/blueprint.js";
import {
  parameterizeScript,
  computeScriptHash,
  keyCredential,
  scriptCredential,
  outputReference,
} from "../../core/evo-utils.js";

// ---------------------------------------------------------------------------
// FES Validator Titles
// ---------------------------------------------------------------------------

export const FES_VALIDATORS = {
  ISSUER_ADMIN: "example_transfer_logic.issuer_admin_contract.withdraw",
  TRANSFER: "example_transfer_logic.transfer.withdraw",
  BLACKLIST_MINT: "blacklist_mint.blacklist_mint.mint",
  BLACKLIST_SPEND: "blacklist_spend.blacklist_spend.spend",
} as const;

// ---------------------------------------------------------------------------
// Script Builders
// ---------------------------------------------------------------------------

export interface FESScripts {
  buildIssuerAdmin(adminPkh: HexString, assetNameHex: HexString): PlutusScript;
  buildTransfer(progLogicBaseHash: ScriptHash, blacklistNodePolicyId: HexString): PlutusScript;
  buildBlacklistMint(bootstrapTxInput: TxInput, adminPkh: HexString): PlutusScript;
  buildBlacklistSpend(blacklistMintPolicyId: HexString): PlutusScript;
}

/**
 * Create FES script builders from a blueprint.
 * Uses Evolution SDK directly for parameterization and hashing.
 */
import type { ParameterizationEvent } from "../../standard/scripts.js";

export function createFESScripts(
  blueprint: PlutusBlueprint,
  onParameterize?: (event: ParameterizationEvent) => void,
): FESScripts {
  function parameterize(validatorTitle: string, params: Data.Data[]): PlutusScript {
    const code = getValidatorCode(blueprint, validatorTitle);
    // Same recorder contract as the standard chain: a CIP-171 record is DERIVED
    // from the calls that actually parameterise, never transcribed beside them.
    const script = parameterizeScript(code, params);
    if (onParameterize) {
      onParameterize({
        title: validatorTitle,
        rawScriptHash: computeScriptHash(code),
        appliedScriptHash: script.hash,
        params,
      });
    }
    return script;
  }

  return {
    buildIssuerAdmin(adminPkh, assetNameHex) {
      return parameterize(FES_VALIDATORS.ISSUER_ADMIN, [
        keyCredential(adminPkh),
        Data.bytearray(assetNameHex),
      ]);
    },

    buildTransfer(progLogicBaseHash, blacklistNodePolicyId) {
      return parameterize(FES_VALIDATORS.TRANSFER, [
        scriptCredential(progLogicBaseHash),
        Data.bytearray(blacklistNodePolicyId),
      ]);
    },

    buildBlacklistMint(bootstrapTxInput, adminPkh) {
      return parameterize(FES_VALIDATORS.BLACKLIST_MINT, [
        outputReference(bootstrapTxInput),
        Data.bytearray(adminPkh),
      ]);
    },

    buildBlacklistSpend(blacklistMintPolicyId) {
      return parameterize(FES_VALIDATORS.BLACKLIST_SPEND, [
        Data.bytearray(blacklistMintPolicyId),
      ]);
    },
  };
}
