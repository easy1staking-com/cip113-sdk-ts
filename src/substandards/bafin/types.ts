/**
 * BaFin securities substandard deployment parameters.
 *
 * All policy IDs are derived at init time from bootstrap UTxOs.
 * Config is placeholder (empty) — will be removed.
 */

import type { HexString, TxInput } from "../../types.js";

export interface BaFinDeploymentParams {
  /** Owner credential hash — signs power user operations, parameterizes validators */
  ownerCredentialHash: HexString;

  /** Hex-encoded asset name of the security token */
  securityAssetName: HexString;

  /** Bootstrap UTxO for global_state_mint initialization (one-shot) */
  globalStateInitTxInput: TxInput;

  /** Bootstrap UTxO for power_users linked list initialization (one-shot) */
  powerUsersInitTxInput: TxInput;

  /** Bootstrap UTxO for users linked list initialization (one-shot) */
  usersInitTxInput: TxInput;
}
