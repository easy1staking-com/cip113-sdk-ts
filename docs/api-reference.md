# API Reference

## CIP113

### `CIP113.init(config: CIP113Config): CIP113Protocol`

Initialize a CIP-113 protocol instance.

```typescript
const protocol = CIP113.init({
  client,                    // Evolution SDK client (ReadOnlyClient or SigningClient)
  standard: {
    blueprint,               // PlutusBlueprint — standard protocol validators
    deployment,              // DeploymentParams — on-chain deployment references
  },
  substandards: [fes],       // SubstandardPlugin[] — registered substandards
});
```

## CIP113Protocol

### Core Operations

| Method | Description |
|--------|-------------|
| `register(substandardId, params)` | Register a new token (first mint + registry insert) |
| `mint(params)` | Mint additional tokens |
| `burn(params)` | Burn tokens from a UTxO |
| `transfer(params)` | Transfer tokens between addresses |

### Compliance Operations

| Method | Description |
|--------|-------------|
| `compliance.init(substandardId, params)` | Initialize compliance infrastructure |
| `compliance.freeze(params)` | Add address to blacklist |
| `compliance.unfreeze(params)` | Remove address from blacklist |
| `compliance.seize(params)` | Seize tokens from frozen address |

### Runtime

| Method | Description |
|--------|-------------|
| `registerSubstandard(plugin)` | Register a substandard at runtime |
| `getSubstandard(id)` | Get a registered substandard by ID |
| `listSubstandards()` | List all registered substandard IDs |

---

## Parameter Types

### RegisterParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer |
| `assetName` | `string` | Yes | Human-readable asset name |
| `quantity` | `bigint` | Yes | Initial mint quantity |
| `recipientAddress` | `Address` | No | Token recipient (default: feePayerAddress) |
| `config` | `Record<string, unknown>` | No | Substandard-specific config |
| `chainedUtxos` | `unknown[]` | No | UTxOs from chained tx |
| `cip68Metadata` | `CIP68MetadataInput` | No | CIP-68 reference token metadata |

### MintParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer |
| `tokenPolicyId` | `PolicyId` | Yes | Token policy ID |
| `assetName` | `HexString` | Yes | Raw asset name hex |
| `quantity` | `bigint` | Yes | Amount to mint |
| `recipientAddress` | `Address` | No | Recipient (default: feePayerAddress) |
| `substandardId` | `string` | No | Route to specific substandard |

### BurnParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer |
| `tokenPolicyId` | `PolicyId` | Yes | Token policy ID |
| `assetName` | `HexString` | Yes | Raw asset name hex |
| `utxoTxHash` | `HexString` | Yes | UTxO transaction hash |
| `utxoOutputIndex` | `number` | Yes | UTxO output index |
| `holderAddress` | `Address` | No | Token holder address (default: feePayerAddress) |
| `substandardId` | `string` | No | Route to specific substandard |

### TransferParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `senderAddress` | `Address` | Yes | Sender's address |
| `recipientAddress` | `Address` | Yes | Recipient's address |
| `tokenPolicyId` | `PolicyId` | Yes | Token policy ID |
| `assetName` | `HexString` | Yes | Raw asset name hex |
| `quantity` | `bigint` | Yes | Amount to transfer |
| `substandardId` | `string` | No | Route to specific substandard |

### FreezeParams / UnfreezeParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer (admin) |
| `tokenPolicyId` | `PolicyId` | Yes | Token policy ID |
| `assetName` | `HexString` | Yes | Raw asset name hex |
| `targetAddress` | `Address` | Yes | Address to freeze/unfreeze |

### SeizeParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer (admin) |
| `tokenPolicyId` | `PolicyId` | Yes | Token policy ID |
| `assetName` | `HexString` | Yes | Raw asset name hex |
| `utxoTxHash` | `HexString` | Yes | Target UTxO tx hash |
| `utxoOutputIndex` | `number` | Yes | Target UTxO output index |
| `destinationAddress` | `Address` | Yes | Where to send seized tokens |
| `holderAddress` | `Address` | No | Holder's address (for UTxO lookup) |

### InitComplianceParams

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `feePayerAddress` | `Address` | Yes | Transaction fee payer |
| `adminAddress` | `Address` | Yes | Admin address |
| `assetName` | `string` | Yes | Human-readable asset name |
| `bootstrapUtxo` | `unknown` | No | One-shot bootstrap UTxO |

### CIP68MetadataInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Display name |
| `description` | `string` | No | Token description |
| `ticker` | `string` | No | Short ticker symbol |
| `decimals` | `number` | No | Decimal places (default: 0) |
| `url` | `string` | No | Project URL |
| `logo` | `string` | No | Logo image URI |

---

## Result Type

### UnsignedTx

| Field | Type | Description |
|-------|------|-------------|
| `cbor` | `HexString` | Unsigned transaction CBOR |
| `txHash` | `HexString` | Transaction hash |
| `tokenPolicyId` | `PolicyId?` | Minted token policy (register/mint) |
| `metadata` | `Record?` | Operation-specific metadata |
| `chainAvailable` | `unknown[]?` | UTxOs available for chaining |
| `_signBuilder` | `any?` | SignBuilder for `signAndSubmit()` |

---

## Deployment Types

### DeploymentParams

On-chain protocol deployment references. Obtained from the bootstrap transaction.

```typescript
interface DeploymentParams {
  txHash: TxHash;
  protocolParams: { txInput: TxInput; policyId: PolicyId; alwaysFailScriptHash: ScriptHash };
  programmableLogicGlobal: { policyId: PolicyId; scriptHash: ScriptHash };
  programmableLogicBase: { scriptHash: ScriptHash };
  issuance: { txInput: TxInput; policyId: PolicyId; alwaysFailScriptHash: ScriptHash };
  directoryMint: { txInput: TxInput; issuanceScriptHash: ScriptHash; scriptHash: ScriptHash };
  directorySpend: { policyId: PolicyId; scriptHash: ScriptHash };
  programmableBaseRefInput: TxInput;
  programmableGlobalRefInput: TxInput;
}
```

### FESDeploymentParams

```typescript
interface FESDeploymentParams {
  adminPkh: HexString;
  assetName: HexString;
  blacklistNodePolicyId: HexString;
  blacklistInitTxInput: TxInput;
}
```

---

## Utility Functions

### String/Hex

| Function | Description |
|----------|-------------|
| `stringToHex(str)` | Convert UTF-8 string to hex |
| `labeledAssetName(label, hex)` | Add CIP-67 label prefix (e.g., 333 for FT) |
| `stripCIP67Label(hex)` | Remove CIP-67 label prefix if present |
| `hasCIP67Label(hex)` | Check if hex starts with CIP-67 label |
| `buildCIP68FTDatum(metadata)` | Build CIP-68 FT metadata datum |

### Address

| Function | Description |
|----------|-------------|
| `paymentCredentialHash(addr)` | Extract payment key hash from bech32 address |
| `stakingCredentialHash(addr)` | Extract staking credential hash |
| `scriptAddress(networkId, hash)` | Build enterprise script address |
| `baseAddress(networkId, hash, userAddr)` | Build base address (script + user staking) |
| `rewardAddress(networkId, hash)` | Build reward/staking address |
| `addressHexToBech32(hex)` | Convert hex address to bech32 |

### Transaction

| Function | Description |
|----------|-------------|
| `assembleSignedTx(unsigned, witness)` | Merge witness set into unsigned tx CBOR |
| `sortTxInputs(inputs)` | Sort tx inputs in canonical (ledger) order |
| `findRefInputIndex(sorted, target)` | Find index of input in sorted list |

---

## Substandard Factories

### `dummySubstandard(config)`

```typescript
import { dummySubstandard } from "@easy1staking/cip113-sdk-ts/dummy";
const dummy = dummySubstandard({ blueprint });
```

### `freezeAndSeizeSubstandard(config)`

```typescript
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
const fes = freezeAndSeizeSubstandard({ blueprint, deployment: FESDeploymentParams });
```

### `createFESScripts(blueprint)`

Low-level script builders for pre-computing hashes:

```typescript
import { createFESScripts } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";
const scripts = createFESScripts(blueprint);
const blacklistMint = scripts.buildBlacklistMint(txInput, adminPkh);
```

---

## Evolution SDK Re-exports

| Export | Description |
|--------|-------------|
| `evoClient` | `Client.make` — create a chain-scoped client |
| `preprodChain` | Preprod chain config |
| `previewChain` | Preview chain config |
| `mainnetChain` | Mainnet chain config |
| `EvoAddress` | Address module |
| `EvoAssets` | Assets module |
| `EvoTransactionHash` | TransactionHash module |
| `EvoData` | Plutus Data module |
