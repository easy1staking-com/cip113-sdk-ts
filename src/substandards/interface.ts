/**
 * Substandard plugin interface.
 *
 * Each substandard (dummy, freeze-and-seize, CMTAT, etc.) implements this
 * interface to provide transaction builders for its operations.
 *
 * Substandards receive the Evolution SDK client directly — no adapter layer.
 */

import type { Cip171Record } from "../core/cip171.js";
import type { ReadOnlyClient, SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
import type { ResolvedStandardScripts } from "../standard/scripts.js";
import type {
  Address,
  DeploymentParams,
  HexString,
  PlutusBlueprint,
  PolicyId,
  ScriptHash,
} from "../types.js";

// ---------------------------------------------------------------------------
// Client type — either ReadOnlyClient or SigningClient
// ---------------------------------------------------------------------------

/**
 * The SDK accepts either a ReadOnlyClient (for CIP-30 wallets) or a
 * SigningClient (for seed-phrase / private-key wallets).
 *
 * Both have getUtxos(), getUtxosWithUnit(), newTx(), chain, etc.
 * The difference is build() return type: TransactionResultBase vs SignBuilder.
 */
export type EvoClient = ReadOnlyClient | SigningClient;

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface SubstandardPlugin {
  /** Unique identifier (e.g., "dummy", "freeze-and-seize") */
  readonly id: string;

  /** Version of this substandard implementation */
  readonly version: string;

  /** The substandard's blueprint */
  readonly blueprint: PlutusBlueprint;

  /**
   * Initialize the plugin with the protocol context.
   * Called once when the substandard is registered with CIP113.init().
   */
  init(context: SubstandardContext): void;

  // -- Core operations (required) --

  /** Register a new programmable token with this substandard */
  register(params: RegisterParams): Promise<UnsignedTx>;

  /** Mint additional tokens (already registered) */
  mint(params: MintParams): Promise<UnsignedTx>;

  /** Burn tokens */
  burn(params: BurnParams): Promise<UnsignedTx>;

  /** Transfer tokens between addresses */
  transfer(params: TransferParams): Promise<UnsignedTx>;

  /**
   * Administrative transfer of a holder's tokens without the holder's signature.
   *
   * OPTIONAL: a substandard with no administrative authority should simply not
   * implement it, and callers get a refusal naming the substandard rather than
   * a silent no-op. Implementing it is a claim that this substandard HAS such an
   * authority and has wired its registry node's
   * `third_party_transfer_logic_script` to something meaningful.
   */
  thirdPartyTransfer?(params: ThirdPartyTransferParams): Promise<UnsignedTx>;

  // -- Optional capabilities --

  /** Freeze an address (blacklist) */
  freeze?(params: FreezeParams): Promise<UnsignedTx>;

  /** Unfreeze an address (remove from blacklist) */
  unfreeze?(params: UnfreezeParams): Promise<UnsignedTx>;

  /** Seize tokens from an address */
  seize?(params: SeizeParams): Promise<UnsignedTx>;

  /** Initialize compliance infrastructure (e.g., blacklist) */
  initCompliance?(params: InitComplianceParams): Promise<UnsignedTx>;
}

// ---------------------------------------------------------------------------
// Context provided to plugins at init
// ---------------------------------------------------------------------------

export interface SubstandardContext {
  /**
   * Optional transaction evaluator.
   *
   * Without one, the client's default provider evaluates — and on Kupmios that
   * reports a bare "evaluateTx failed" with no indication of WHICH script died
   * or why. An Ogmios evaluator returns the validator's own trace list, which is
   * the difference between a diagnosis and a guess. Consumers running against a
   * local devnet should supply one.
   */
  evaluator?: unknown;

  /** Evolution SDK client (ReadOnlyClient or SigningClient) */
  client: EvoClient;
  standardScripts: ResolvedStandardScripts;
  deployment: DeploymentParams;
  network: string;
  /** Check if a stake address is registered on-chain. If not provided, assumes not registered. */
  checkStakeRegistration?: (stakeAddress: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// CIP-68 metadata
// ---------------------------------------------------------------------------

/** CIP-68 FT metadata fields provided by the caller. */
export interface CIP68MetadataInput {
  /** Display name (required, stored as byte string in datum) */
  name: string;
  /** Token description */
  description?: string;
  /** Short ticker symbol, e.g. "MYTKN" */
  ticker?: string;
  /** Number of decimal places for display (default: 0) */
  decimals?: number;
  /** Project or token URL */
  url?: string;
  /** URI pointing to the token logo image */
  logo?: string;
}

// ---------------------------------------------------------------------------
// Operation parameters
// ---------------------------------------------------------------------------

export interface RegisterParams {
  feePayerAddress: Address;
  /**
   * Raw asset name HEX, CIP-67 label included — the convention at every API
   * boundary in this SDK (see CLAUDE.md).
   *
   * ⚠ This was typed `string` while every sibling field was `HexString`, and the
   * two shipped substandards read it DIFFERENTLY as a result: `dummy` used it
   * as hex, `freeze-and-seize` ran `stringToHex` over it and double-encoded
   * anything already hex. Both were internally consistent, which is why neither
   * looked wrong; the mismatch only appeared when the same value was passed to
   * both. The type now says what the convention always did.
   */
  assetName: HexString;
  quantity: bigint;
  recipientAddress?: Address;
  /** Substandard-specific config (e.g., adminPkh for FES) */
  config?: Record<string, unknown>;
  /** Available UTxOs from a chained transaction (e.g., initCompliance) */
  chainedUtxos?: unknown[];
  /** Optional CIP-68 metadata. When provided, mints ref token (label 100) + FT user token (label 333). */
  cip68Metadata?: CIP68MetadataInput;
  /**
   * Optional CIP-171 provenance. When provided, the registration transaction
   * carries the record at metadata label 1984.
   *
   * Registration is the right seam for it: this is the transaction that
   * PARAMETERISES the token's scripts, so the record and the thing it
   * describes are produced by the same act. A standalone record is equally
   * valid to a verifier — association is by script hash, not by transaction —
   * but it has to be REMEMBERED to be published, and this cannot be forgotten.
   *
   * ⚠ Build it from the parameterisation itself (see the `onParameterize`
   * recorder on the script factories), and only for a blueprint whose
   * provenance is established. A record is a permanent public claim that named
   * scripts came from a named commit; unlike a file, a metadatum cannot be
   * deleted.
   */
  cip171Record?: Cip171Record;
}

export interface MintParams {
  feePayerAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  quantity: bigint;
  recipientAddress?: Address;
  /** Optional: route directly to this substandard instead of trying all */
  substandardId?: string;
}

export interface BurnParams {
  feePayerAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  utxoTxHash: HexString;
  utxoOutputIndex: number;
  /** Address of the token holder (where the UTxO sits). Defaults to feePayerAddress if omitted. */
  holderAddress?: Address;
  /** Optional: route directly to this substandard instead of trying all */
  substandardId?: string;
}

export interface TransferParams {
  senderAddress: Address;
  recipientAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  quantity: bigint;
  /** Optional: route directly to this substandard instead of trying all */
  substandardId?: string;
}

/**
 * A THIRD-PARTY transfer: an administrator moves a holder's tokens WITHOUT the
 * holder signing.
 *
 * This is the seize / clawback / freeze-enforcement path. It is authorised by
 * the registry node's `third_party_transfer_logic_script` withdraw-0 — the
 * issuer's own logic — not by the holder, which is the entire point and the
 * entire risk.
 *
 * On chain it takes a different route from `transfer`: programmable_logic_base
 * dispatches via `SpendViaThirdParty` to the standalone `third_party` validator,
 * so a third-party transaction never loads the `transfer` reference script at
 * all. The two paths share no redeemer.
 */
export interface ThirdPartyTransferParams {
  /**
   * The current holder, whose tokens are being moved. **This address does NOT
   * sign the transaction** — that is what makes this a third-party transfer.
   */
  holderAddress: Address;
  /** Where the tokens go. */
  recipientAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  quantity: bigint;
  /** The administrator: pays fees and provides the authorising signature. */
  feePayerAddress: Address;
  /** Optional: route directly to this substandard instead of trying all */
  substandardId?: string;
}

export interface FreezeParams {
  /**
   * REQUIRED. Which substandard performs this.
   *
   * Deliberately not optional-with-fallback: this is an administrative
   * operation over someone else's tokens, and selecting the authority by trial
   * is not a convenience worth having. It also keeps a real validator failure
   * legible — a try-all reports "no substandard can handle this" when the truth
   * is "it was handled and the chain refused".
   */
  substandardId: string;
  feePayerAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  targetAddress: Address;
}

export interface UnfreezeParams {
  /**
   * REQUIRED. Which substandard performs this.
   *
   * Deliberately not optional-with-fallback: this is an administrative
   * operation over someone else's tokens, and selecting the authority by trial
   * is not a convenience worth having. It also keeps a real validator failure
   * legible — a try-all reports "no substandard can handle this" when the truth
   * is "it was handled and the chain refused".
   */
  substandardId: string;
  feePayerAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  targetAddress: Address;
}

export interface SeizeParams {
  /**
   * REQUIRED. Which substandard performs this.
   *
   * Deliberately not optional-with-fallback: this is an administrative
   * operation over someone else's tokens, and selecting the authority by trial
   * is not a convenience worth having. It also keeps a real validator failure
   * legible — a try-all reports "no substandard can handle this" when the truth
   * is "it was handled and the chain refused".
   */
  substandardId: string;
  feePayerAddress: Address;
  tokenPolicyId: PolicyId;
  /** Raw asset name hex (including CIP-67 label if CIP-68) */
  assetName: HexString;
  utxoTxHash: HexString;
  utxoOutputIndex: number;
  destinationAddress: Address;
  /** Address of the token holder whose tokens are being seized. */
  holderAddress?: Address;
}

export interface InitComplianceParams {
  feePayerAddress: Address;
  adminAddress: Address;
  assetName: string;
  /** The bootstrap UTxO to consume (one-shot). If provided, skips fetching. */
  bootstrapUtxo?: unknown;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UnsignedTx {
  /** Unsigned transaction CBOR hex */
  cbor: HexString;
  /** Transaction hash (derived from body) */
  txHash: HexString;
  /** Policy ID of the minted token (for register/mint operations) */
  tokenPolicyId?: PolicyId;
  /** Additional metadata from the operation */
  metadata?: Record<string, unknown>;
  /** Available UTxOs for chaining (from SignBuilder.chainResult().available) */
  chainAvailable?: unknown[];
  /** Internal: the SignBuilder for direct sign+submit (seed wallets) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _signBuilder?: any;
}

// ---------------------------------------------------------------------------
// Factory function type
// ---------------------------------------------------------------------------

export type SubstandardFactory = (config: {
  blueprint: PlutusBlueprint;
}) => SubstandardPlugin;
