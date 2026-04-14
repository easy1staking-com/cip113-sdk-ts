/**
 * BaFin securities script builders.
 *
 * Parameterizes all BaFin validators from the blueprint:
 * - minting_logic_script.withdraw — controls mint/burn authorization
 * - transfer_logic_script.withdraw — controls transfers with KYC checks
 * - third_party_transfer_logic_script.withdraw — controls forced transfers
 * - global_state_spend_validator.spend — guards global state UTxO updates
 * - power_users.mint — linked list init/add/remove for power users
 * - power_users_validator.spend — spend guard for power user nodes
 * - users.mint — linked list init/add/remove for users
 * - users_validator.spend — spend guard for user nodes
 */

import { Data } from "@evolution-sdk/evolution";
import type { HexString, PlutusBlueprint, PlutusScript, ScriptHash, TxInput } from "../../types.js";
import { getValidatorCode } from "../../standard/blueprint.js";
import { parameterizeScript, outputReference } from "../../core/evo-utils.js";

// ---------------------------------------------------------------------------
// BaFin Validator Titles (from plutus.json)
// ---------------------------------------------------------------------------

export const BAFIN_VALIDATORS = {
  MINTING_LOGIC: "minting_logic_script.minting_logic_validator.withdraw",
  TRANSFER_LOGIC: "transfer_logic_script.transfer_logic_validator.withdraw",
  THIRD_PARTY_TRANSFER_LOGIC: "third_party_transfer_logic_script.third_party_transfer_logic_validator.withdraw",
  GLOBAL_STATE_MINT: "global_state.global_state_mint_validator.mint",
  GLOBAL_STATE_SPEND: "global_state.global_state_spend_validator.spend",
  POWER_USERS_MINT: "power_users.mint.mint",
  POWER_USERS_SPEND: "power_users.power_users_validator.spend",
  USERS_MINT: "users.mint.mint",
  USERS_SPEND: "users.users_validator.spend",
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

  buildTransferLogic(
    securityAssetName: HexString,
    globalStatePolicyId: HexString,
    usersLinkedListPolicyId: HexString,
    issuancePolicyId: HexString,
  ): PlutusScript;

  buildThirdPartyTransferLogic(
    securityAssetName: HexString,
    powerUsersLinkedListPolicyId: HexString,
    usersLinkedListPolicyId: HexString,
    issuancePolicyId: HexString,
  ): PlutusScript;

  // Global state
  buildGlobalStateMint(
    initInputOutRef: TxInput,
  ): PlutusScript;

  buildGlobalStateSpend(
    ownerCredentialHash: HexString,
    securityAssetName: HexString,
    configPolicyId: HexString,
    globalStatePolicyId: HexString,
  ): PlutusScript;

  // Linked lists
  buildPowerUsersMint(
    ownerCredentialHash: HexString,
    initInputOutRef: TxInput,
  ): PlutusScript;

  buildPowerUsersSpend(
    ownerCredentialHash: HexString,
    powerUsersLinkedListPolicyId: HexString,
  ): PlutusScript;

  buildUsersMint(
    initInputOutRef: TxInput,
    powerUsersLinkedListPolicyId: HexString,
  ): PlutusScript;

  buildUsersSpend(
    powerUsersLinkedListPolicyId: HexString,
    usersLinkedListPolicyId: HexString,
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
    // -- CIP-113 logic scripts --

    buildMintingLogic(securityAssetName, globalStatePolicyId, powerUsersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.MINTING_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(powerUsersLinkedListPolicyId),
      ]);
    },

    buildTransferLogic(securityAssetName, globalStatePolicyId, usersLinkedListPolicyId, issuancePolicyId) {
      return parameterize(BAFIN_VALIDATORS.TRANSFER_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(globalStatePolicyId),
        Data.bytearray(usersLinkedListPolicyId),
        Data.bytearray(issuancePolicyId),
      ]);
    },

    buildThirdPartyTransferLogic(securityAssetName, powerUsersLinkedListPolicyId, usersLinkedListPolicyId, issuancePolicyId) {
      return parameterize(BAFIN_VALIDATORS.THIRD_PARTY_TRANSFER_LOGIC, [
        Data.bytearray(securityAssetName),
        Data.bytearray(powerUsersLinkedListPolicyId),
        Data.bytearray(usersLinkedListPolicyId),
        Data.bytearray(issuancePolicyId),
      ]);
    },

    // -- Global state --

    buildGlobalStateMint(initInputOutRef) {
      // global_state_mint_validator(tx0: ByteArray, index0: Int)
      return parameterize(BAFIN_VALIDATORS.GLOBAL_STATE_MINT, [
        Data.bytearray(initInputOutRef.txHash),
        Data.int(BigInt(initInputOutRef.outputIndex)),
      ]);
    },

    buildGlobalStateSpend(ownerCredentialHash, securityAssetName, configPolicyId, globalStatePolicyId) {
      return parameterize(BAFIN_VALIDATORS.GLOBAL_STATE_SPEND, [
        Data.bytearray(ownerCredentialHash),
        Data.bytearray(securityAssetName),
        Data.bytearray(configPolicyId),
        Data.bytearray(globalStatePolicyId),
      ]);
    },

    // -- Linked lists --

    buildPowerUsersMint(ownerCredentialHash, initInputOutRef) {
      return parameterize(BAFIN_VALIDATORS.POWER_USERS_MINT, [
        Data.bytearray(ownerCredentialHash),
        outputReference(initInputOutRef),
      ]);
    },

    buildPowerUsersSpend(ownerCredentialHash, powerUsersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.POWER_USERS_SPEND, [
        Data.bytearray(ownerCredentialHash),
        Data.bytearray(powerUsersLinkedListPolicyId),
      ]);
    },

    buildUsersMint(initInputOutRef, powerUsersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.USERS_MINT, [
        outputReference(initInputOutRef),
        Data.bytearray(powerUsersLinkedListPolicyId),
      ]);
    },

    buildUsersSpend(powerUsersLinkedListPolicyId, usersLinkedListPolicyId) {
      return parameterize(BAFIN_VALIDATORS.USERS_SPEND, [
        Data.bytearray(powerUsersLinkedListPolicyId),
        Data.bytearray(usersLinkedListPolicyId),
      ]);
    },
  };
}
