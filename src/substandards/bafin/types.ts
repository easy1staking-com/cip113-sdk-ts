/**
 * BaFin securities substandard — deployment parameters and shared types.
 *
 * Under the Track 4 hybrid KYC design:
 *   - Admin credential lives inside GlobalStateDatum (rotatable via RotateAdmin).
 *   - Trusted-entity list (TEL) also lives inside GlobalStateDatum.
 *   - Denylist is a separate linked-list validator (replaces the old users LL).
 */

import type { HexString, TxInput } from "../../types.js";

// ============================================================================
// Deployment parameters
// ============================================================================

export interface BaFinDeploymentParams {
  /**
   * Initial admin credential hash written to GlobalStateDatum at deploy time.
   * This key can be rotated via the RotateAdmin spend action (dual-signature
   * with the incoming admin).
   */
  initialAdminCredentialHash: HexString;

  /** Hex-encoded asset name of the security token */
  securityAssetName: HexString;

  /**
   * Initial maximum mintable amount. GlobalStateDatum.mintable_amount starts
   * at this value and decrements on each MintSecurity; increases on burn.
   * Must be non-negative.
   */
  initialMintableAmount: bigint;

  /** Initial set of trusted-entity vkeys seeded into GlobalStateDatum */
  initialTrustedEntities?: TrustedEntity[];

  /** Arbitrary security-info payload for GlobalStateDatum (CBOR-encoded) */
  initialSecurityInfo?: HexString;

  /** Bootstrap UTxO for global_state_mint initialization (one-shot) */
  globalStateInitTxInput: TxInput;

  /** Bootstrap UTxO for power_users linked list initialization (one-shot) */
  powerUsersInitTxInput: TxInput;

  /** Bootstrap UTxO for denylist linked list initialization (one-shot) */
  denylistInitTxInput: TxInput;
}

// ============================================================================
// Trusted Entity List (TEL) — stored inside GlobalStateDatum
// ============================================================================

export interface TrustedEntity {
  /** 32-byte Ed25519 verification key — directly indexes the TEL */
  vkey: HexString;
  /**
   * Free-form metadata (jurisdiction, provider URL, tier, etc.).
   * Not inspected by on-chain validators; kept for off-chain indexing.
   * CBOR-encoded hex. Pass `"80"` (empty list) for no metadata.
   */
  metadata: HexString;
}

// ============================================================================
// KYC proof (per-transfer ephemeral attestation signed by a TEL entity)
// ============================================================================

/** Values of the user_kyc_tier byte in a KYC proof payload. */
export const KycTier = {
  Invalid: 0x00,
  User: 0x01,
  Institutional: 0x02,
  VLei: 0x03,
} as const;
export type KycTier = (typeof KycTier)[keyof typeof KycTier];

/** Byte offsets and widths within the 66-byte KYC-proof payload. */
export const KYC_PAYLOAD = {
  LENGTH: 66,
  OFFSET_USER_PKH: 0,
  WIDTH_USER_PKH: 28,
  OFFSET_TIER: 28,
  OFFSET_VALID_UNTIL_MS: 29,
  WIDTH_VALID_UNTIL_MS: 8,
  OFFSET_SECURITY_POLICY_ID: 37,
  WIDTH_SECURITY_POLICY_ID: 28,
  OFFSET_NETWORK_ID: 65,
} as const;

export const KYC_SIGNATURE_LENGTH = 64;
export const KYC_ISSUER_VKEY_LENGTH = 32;

export interface KycProof {
  /** Exactly 66 bytes, hex-encoded */
  payload: HexString;
  /** Exactly 64 bytes, hex-encoded — raw Ed25519 signature over payload */
  signature: HexString;
  /** Exactly 32 bytes, hex-encoded — issuer's Ed25519 vkey */
  issuerVkey: HexString;
}

/** Parameters for constructing a KYC proof off-chain. */
export interface KycProofParams {
  /** 28-byte PKH of the user this proof is for */
  userPkh: HexString;
  /** KYC tier (see `KycTier`) */
  tier: KycTier;
  /** Proof validity expiry (POSIX milliseconds, big-endian) */
  validUntilMs: bigint;
  /** 28-byte security-token policy id this proof is bound to */
  securityPolicyId: HexString;
  /** Network id byte — 0x00 preview, 0x01 preprod, 0x02 mainnet, 0x03 yaci */
  networkId: number;
  /** Issuer's 32-byte Ed25519 private key (seed) */
  issuerPrivateKey: HexString;
}

// ============================================================================
// Denylist node (on-chain linked-list validator)
// ============================================================================

export interface DenylistEntry {
  /** 28-byte PKH of the denied user */
  userPkh: HexString;
  /** Free-form metadata (reason hash, added_at, etc.). CBOR hex. `"80"` = empty. */
  metadata: HexString;
}

// ============================================================================
// Power-user flags (for building PowerUser datums)
// ============================================================================

export interface PowerUserFlags {
  isAdmin: boolean;
  canMint: boolean;
  canBurn: boolean;
  canPause: boolean;
  canForceTransfer: boolean;
}

export interface PowerUser extends PowerUserFlags {
  credentialHash: HexString;
}
