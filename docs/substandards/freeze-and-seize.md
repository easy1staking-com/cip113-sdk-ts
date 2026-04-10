# Freeze-and-Seize Substandard

The Freeze-and-Seize (FES) substandard adds compliance capabilities to programmable tokens: blacklisting addresses, freezing transfers, and seizing tokens from frozen addresses.

## Architecture

FES maintains an on-chain **blacklist** as a sorted linked list of staking credential hashes. Each node is a UTxO at the blacklist spend address containing an NFT keyed by the staking hash.

Transfers include a **non-membership proof**: the SDK finds the covering node (where `node.key < sender_staking_hash < node.next`) to prove the sender is not blacklisted.

### Validators

| Validator | Purpose |
|-----------|---------|
| `issuer_admin_contract` | Admin authorization (parameterized with `adminPkh` + `assetName`) |
| `transfer` | Transfer logic with blacklist non-membership check |
| `blacklist_mint` | Mint/burn blacklist node NFTs (one-shot policy) |
| `blacklist_spend` | Spend blacklist node UTxOs for insert/remove |

## Setup

```typescript
import { freezeAndSeizeSubstandard, createFESScripts } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";

const fes = freezeAndSeizeSubstandard({
  blueprint: fesBlueprint,
  deployment: {
    adminPkh: "payment_key_hash_hex",      // admin's payment credential
    assetName: "hex_asset_name",            // raw hex (CIP-68 prefix if applicable)
    blacklistNodePolicyId: "policy_id_hex", // from initCompliance
    blacklistInitTxInput: {                 // bootstrap UTxO (one-shot)
      txHash: "tx_hash_hex",
      outputIndex: 0,
    },
  },
});
```

## Operations

### Init Compliance

Creates the blacklist origin node (empty linked list head). Must be called before any freeze/unfreeze/seize operations.

```typescript
const result = await protocol.compliance.init("freeze-and-seize", {
  feePayerAddress: adminAddress,
  adminAddress: adminAddress,
  assetName: "DEMO",             // human-readable name
  bootstrapUtxo: largestUtxo,    // one-shot minting policy input
});
```

**Returns:** `blacklistNodePolicyId`, stake registration info in `metadata`.

**Example:** [01-init-compliance.ts](../../examples/freeze-and-seize/01-init-compliance.ts)

### Register

First mint + registry insert. Creates the token with an initial supply.

```typescript
const result = await protocol.register("freeze-and-seize", {
  feePayerAddress: adminAddress,
  assetName: "DEMO",
  quantity: 1_000_000n,
  recipientAddress: adminAddress,
  // Optional CIP-68 metadata:
  // cip68Metadata: { name: "Demo Token", ticker: "DEMO", decimals: 6 },
});
console.log("Token policy:", result.tokenPolicyId);
```

**Returns:** `tokenPolicyId`, `metadata` with script hashes.

**Example:** [02-register.ts](../../examples/freeze-and-seize/02-register.ts)

### Transfer

Transfer tokens between addresses. Includes blacklist non-membership proof for the sender.

```typescript
const result = await protocol.transfer({
  senderAddress: "addr_test1...",
  recipientAddress: "addr_test1...",
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",  // raw hex
  quantity: 100n,
});
```

If the sender is blacklisted, throws: `"Sender ... is blacklisted — transfer denied"`.

**Example:** [03-transfer.ts](../../examples/freeze-and-seize/03-transfer.ts)

### Mint

Mint additional tokens. Requires issuer admin (the wallet that created the token).

```typescript
const result = await protocol.mint({
  feePayerAddress: adminAddress,
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",
  quantity: 500_000n,
  recipientAddress: adminAddress,
});
```

**Example:** [04-mint.ts](../../examples/freeze-and-seize/04-mint.ts)

### Burn

Burn tokens from a specific UTxO. Requires issuer admin.

```typescript
const result = await protocol.burn({
  feePayerAddress: adminAddress,
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",
  utxoTxHash: "tx_hash_of_utxo",
  utxoOutputIndex: 0,
  holderAddress: holderAddr,  // optional, defaults to feePayerAddress
});
```

**Example:** [05-burn.ts](../../examples/freeze-and-seize/05-burn.ts)

### Freeze

Add an address to the blacklist. The address will no longer be able to transfer tokens.

```typescript
const result = await protocol.compliance.freeze({
  feePayerAddress: adminAddress,
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",
  targetAddress: "addr_test1_to_freeze",
});
```

**Example:** [06-freeze.ts](../../examples/freeze-and-seize/06-freeze.ts)

### Unfreeze

Remove an address from the blacklist.

```typescript
const result = await protocol.compliance.unfreeze({
  feePayerAddress: adminAddress,
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",
  targetAddress: "addr_test1_to_unfreeze",
});
```

**Example:** [09-unfreeze.ts](../../examples/freeze-and-seize/09-unfreeze.ts)

### Seize

Take tokens from a frozen address and send them to a destination.

```typescript
const result = await protocol.compliance.seize({
  feePayerAddress: adminAddress,
  tokenPolicyId: "abcd...",
  assetName: "hex_asset_name",
  utxoTxHash: "tx_hash_of_target_utxo",
  utxoOutputIndex: 0,
  destinationAddress: adminAddress,
  holderAddress: "addr_test1_frozen_holder",
});
```

**Example:** [08-seize.ts](../../examples/freeze-and-seize/08-seize.ts)

## Asset Name Convention

Asset names are always **raw hex** — the full on-chain byte representation:

- Non-CIP-68: `stringToHex("DEMO")` = `"44454d4f"`
- CIP-68 FT: `labeledAssetName(333, stringToHex("DEMO"))` = `"0014df1044454d4f"`

The CIP-68 prefix is part of the raw name. Only strip it for display purposes.

## Transaction Chaining

`initCompliance` returns `chainAvailable` UTxOs that can be passed to `register` via `chainedUtxos` for single-approval flows (CIP-30 wallets). The examples run scripts sequentially and wait for confirmation between steps.

## Full Lifecycle

See the [examples/freeze-and-seize/](../../examples/freeze-and-seize/) directory for the complete 11-step lifecycle from setup to post-unfreeze transfer.
