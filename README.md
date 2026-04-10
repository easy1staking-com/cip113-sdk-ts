# @easy1staking/cip113-sdk-ts

TypeScript SDK for [CIP-113 Programmable Tokens](https://cips.cardano.org/cip/CIP-0113) on Cardano.

Build, transfer, mint, burn, freeze, and seize programmable tokens with a clean, pluggable API.

## Install

```bash
npm install @easy1staking/cip113-sdk-ts @evolution-sdk/evolution effect
```

## Quick Start

```typescript
import { CIP113, evoClient, preprodChain } from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";

// 1. Create a client
const client = evoClient(preprodChain)
  .withBlockfrost({ projectId: "your_key", baseUrl: "https://cardano-preprod.blockfrost.io/api/v0" })
  .withSeed({ mnemonic: "your 24 word seed phrase" });

// 2. Initialize the protocol with a substandard
const protocol = CIP113.init({
  client,
  standard: { blueprint: standardBlueprint, deployment: deploymentParams },
  substandards: [fes],
});

// 3. Transfer programmable tokens
const result = await protocol.transfer({
  senderAddress: "addr_test1...",
  recipientAddress: "addr_test1...",
  tokenPolicyId: "abcd1234...",
  assetName: "0014df1044454d4f",  // raw hex, CIP-68 prefix included
  quantity: 1000n,
});

// 4. Sign and submit
const txHash = await result._signBuilder.signAndSubmit();
await client.awaitTx(txHash);
```

## Substandards

| Substandard | Import | Capabilities |
|-------------|--------|-------------|
| **Freeze-and-Seize** | `@easy1staking/cip113-sdk-ts/freeze-and-seize` | Register, Transfer, Mint, Burn, Freeze, Unfreeze, Seize |
| **Dummy** | `@easy1staking/cip113-sdk-ts/dummy` | Transfer (testing only) |

## Exports

| Path | Description |
|------|-------------|
| `@easy1staking/cip113-sdk-ts` | Core SDK: `CIP113`, types, utilities |
| `@easy1staking/cip113-sdk-ts/freeze-and-seize` | Freeze-and-Seize substandard |
| `@easy1staking/cip113-sdk-ts/dummy` | Dummy substandard |

## Examples

The `examples/` directory contains runnable scripts for the full token lifecycle:

```bash
cd examples
cp .env.example .env    # add your Blockfrost key + seed phrase
npm install
npm run fes:setup
npm run fes:init-compliance
npm run fes:register
npm run fes:transfer
npm run fes:mint
npm run fes:burn
npm run fes:freeze
npm run fes:transfer-blocked
npm run fes:seize
npm run fes:unfreeze
npm run fes:transfer-unfrozen
```

Each script is standalone — run them sequentially to walk through the complete Freeze-and-Seize lifecycle.

## Documentation

- [Getting Started](docs/getting-started.md) — prerequisites, setup, first token
- [API Reference](docs/api-reference.md) — all types, methods, utilities
- [Freeze-and-Seize](docs/substandards/freeze-and-seize.md) — compliance substandard
- [Dummy](docs/substandards/dummy.md) — minimal test substandard

## Peer Dependencies

- `@evolution-sdk/evolution` ^0.4.0
- `effect` ^3.0.0

## License

Apache-2.0
