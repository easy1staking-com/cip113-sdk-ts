/**
 * BaFin securities script builders (Track 4 — hybrid TEL + denylist design).
 *
 * Parameterizes all BaFin validators from the blueprint. Signatures reflect
 * the admin-in-datum refactor and the users-LL → denylist-LL rename.
 */

import { Data } from "@evolution-sdk/evolution";
import type { HexString, PlutusBlueprint, PlutusScript, TxInput } from "../../types.js";
import { getValidatorCode } from "../../standard/blueprint.js";
import { parameterizeScript, outputReference } from "../../core/evo-utils.js";

// ---------------------------------------------------------------------------
// BaFin Validator Titles (from plutus.json)
// ---------------------------------------------------------------------------

export const BAFIN_VALIDATORS = {
  MINTING_LOGIC: "minting_logic_script.minting_logic_validator.withdraw",
  TRANSFER_LOGIC: "transfer_logic_script.transfer_logic_validator.withdraw",
  THIRD_PARTY_TRANSFER_LOGIC:
    "third_party_transfer_logic_script.third_party_transfer_logic_validator.withdraw",
  GLOBAL_STATE_MINT: "global_state.global_state_mint_validator.mint",
  GLOBAL_STATE_SPEND: "global_state.global_state_spend_validator.spend",
  POWER_USERS_MINT: "power_users.mint.mint",
  POWER_USERS_SPEND: "power_users.power_users_validator.spend",
  DENYLIST_MINT: "denylist.mint.mint",
  DENYLIST_SPEND: "denylist.denylist_validator.spend",
} as const;

// ---------------------------------------------------------------------------
// Script Builders
// ---------------------------------------------------------------------------

export interface BaFinScripts {
  // CIP-113 logic scripts

  buildMintingLogic(
    securityAssetName: HexString,
    globalStatePolicyId: HexString,
    powerUsersLinkedListPolicyId: HexString,
  ): PlutusScript;

  /**
   * Transfer-logic no longer takes the users-LL policy id as a param — the
   * denylist LL policy id now flows through GS datum at runtime, and KYC is
   * a TEL proof (also in GS datum). Compile-time parameters are just the
   * things that uniquely identify the deployment's token.
   */
  buildTransferLogic(
    securityAssetName: HexString,
    globalStatePolicyId: HexString,
    issuancePolicyId: HexString,
  ): PlutusScript;

  /**
   * Third-party-transfer-logic: dropped users_linked_list_policy_id; added
   * global_state_policy_id (for reading GS ref input).
   */
  buildThirdPartyTransferLogic(
    securityAssetName: HexString,
    powerUsersLinkedListPolicyId: HexString,
    globalStatePolicyId: HexString,
    issuancePolicyId: HexString,
  ): PlutusScript;

  // Global state

  buildGlobalStateMint(initInputOutRef: TxInput): PlutusScript;

  /**
   * Global-state spend: owner_credential_hash parameter dropped (admin now
   * lives in the datum).
   */
  buildGlobalStateSpend(
    securityAssetName: HexString,
    configPolicyId: HexString,
    globalStatePolicyId: HexString,
  ): PlutusScript;

  // Linked lists (power_users + denylist)

  /**
   * PowerUsers spend: owner_credential_hash dropped; now reads admin via
   * GS ref input using global_state_policy_id.
   */
  buildPowerUsersSpend(
    globalStatePolicyId: HexString,
    powerUsersLinkedListPolicyId: HexString,
  ): PlutusScript;

  /**
   * PowerUsers mint: owner_credential_hash dropped; now reads admin via
   * GS ref input using global_state_policy_id (except in Init which is
   * nonce-gated).
   */
  buildPowerUsersMint(
    globalStatePolicyId: HexString,
    initInputOutRef: TxInput,
  ): PlutusScript;

  /**
   * Denylist spend: parameterised only by denylist LL policy id. Delegates
   * to mint for state transitions.
   */
  buildDenylistSpend(denylistLinkedListPolicyId: HexString): PlutusScript;

  /**
   * Denylist mint: admin-gated via GS ref input for Add/Remove/Deinit;
   * Init is nonce-gated.
   */
  buildDenylistMint(
    globalStatePolicyId: HexString,
    initInputOutRef: TxInput,
  ): PlutusScript;
}

/**
 * Create BaFin script builders from a blueprint.
 */
export function createBaFinScripts(blueprint: PlutusBlueprint): BaFinScripts {
  function parameterize(validatorTitle: string, params: Data.Data[]): PlutusScript {
    const code = getValidatorCode(blueprint, validatorTitle);
    return parameterizeScript(code, params);
  }

  return {
    buildMintingLogic(securityAssetName, globalStatePolicyId, powerUsersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.MINTING_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(powerUsersLinkedListPolicyId),
      ]);
    },

    buildTransferLogic(securityAssetName, globalStatePolicyId, issuancePolicyId) {
      return parameterize(BAFIN_VALIDATORS.TRANSFER_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(issuancePolicyId),
      ]);
    },

    buildThirdPartyTransferLogic(
      securityAssetName,
      powerUsersLinkedListPolicyId,
      globalStatePolicyId,
      issuancePolicyId,
    ) {
      return parameterize(BAFIN_VALIDATORS.THIRD_PARTY_TRANSFER_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(powerUsersLinkedListPolicyId),
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(issuancePolicyId),
      ]);
    },

    buildGlobalStateMint(initInputOutRef) {
      return parameterize(BAFIN_VALIDATORS.GLOBAL_STATE_MINT, [
        Data.bytearray(initInputOutRef.txHash),
        Data.int(BigInt(initInputOutRef.outputIndex)),
      ]);
    },

    buildGlobalStateSpend(securityAssetName, configPolicyId, globalStatePolicyId) {
      return parameterize(BAFIN_VALIDATORS.GLOBAL_STATE_SPEND, [
        Data.bytearray(securityAssetName),
        Data.bytearray(configPolicyId),
        Data.bytearray(globalStatePolicyId),
      ]);
    },

    buildPowerUsersSpend(globalStatePolicyId, powerUsersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.POWER_USERS_SPEND, [
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(powerUsersLinkedListPolicyId),
      ]);
    },

    buildPowerUsersMint(globalStatePolicyId, initInputOutRef) {
      return parameterize(BAFIN_VALIDATORS.POWER_USERS_MINT, [
        Data.bytearray(globalStatePolicyId),
        outputReference(initInputOutRef),
      ]);
    },

    buildDenylistSpend(denylistLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.DENYLIST_SPEND, [
        Data.bytearray(denylistLinkedListPolicyId),
      ]);
    },

    buildDenylistMint(globalStatePolicyId, initInputOutRef) {
      return parameterize(BAFIN_VALIDATORS.DENYLIST_MINT, [
        Data.bytearray(globalStatePolicyId),
        outputReference(initInputOutRef),
      ]);
    },
  };
}
