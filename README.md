# @easy1staking/cip113-sdk-ts

TypeScript SDK for [CIP-113 Programmable Tokens](https://cips.cardano.org/cip/CIP-0113) on Cardano.

## Install

```bash
npm install @easy1staking/cip113-sdk-ts @evolution-sdk/evolution effect
```

## Quick Start

```typescript
import { CIP113 } from "@easy1staking/cip113-sdk-ts";
import { freezeAndSeizeSubstandard } from "@easy1staking/cip113-sdk-ts/freeze-and-seize";

// Initialize the protocol
const protocol = CIP113.create({
  blueprint,
  deployment,
  client,
  substandards: [fes],
});

// Transfer programmable tokens
const { cbor, txHash } = await protocol.transfer({
  senderAddress: "addr1...",
  recipientAddress: "addr1...",
  tokenPolicyId: "abcd1234...",
  assetName: "0014df10...", // raw hex, CIP-68 prefix included
  quantity: 1000n,
});
```

## Substandards

The SDK supports pluggable substandards:

- **Dummy** — minimal substandard for testing
- **Freeze-and-Seize** — compliance substandard with blacklisting, freezing, and seizing

## Peer Dependencies

- `@evolution-sdk/evolution` ^0.4.0
- `effect` ^3.0.0

## License

Apache-2.0
