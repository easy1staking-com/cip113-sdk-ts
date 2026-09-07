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
  assetName: "0014df1044454d4f",          // raw hex, CIP-68 prefix included
  quantity: 1000n,
  substandardId: "freeze-and-seize",      // always specify for direct routing
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

## Migrating to 0.8.0 (CIP-113 0.5.0-alpha.3)

**0.8.0 targets a different protocol version and breaks every consumer.** It is a minor bump
because this package is pre-1.0; treat it as major.

⛔ **The one that will not announce itself.** `programmable_logic_base`'s redeemer went from a
three-constructor enum to a single record:

```
0.5.0-alpha.2   SpendViaTransfer(params_idx, wdrl_idx)   = Constr(0, [Int, Int])
0.5.0-alpha.3   BaseSpendRedeemer{params_idx, wdrl_idx}  = Constr(0, [Int, Int])
```

Those are **byte-identical**. A stale builder emitting `SpendViaTransfer` produces a redeemer that
decodes cleanly and fails later on a credential check — because `wdrl_idx` now indexes the
**dispatcher's** withdrawal, not the delegate's. `SpendViaThirdParty` and `SpendViaUnfracking`
(constructors 1 and 2) fail loudly instead, so **the silence lands on the transfer path — the common
one**. This SDK refuses the stale call shape at the API surface, because nothing downstream can.

| what changed | before | after |
|---|---|---|
| params NFT policy vs address | two derivations | **one hash serves both** (`protocolParams.policyId`) |
| registry node policy vs address | `directoryMint` / `directorySpend` | **one hash serves both** (`registry.scriptHash`) |
| protocol-params datum | 7 fields | **4** — `(plg_cred, transfer_cred, third_party_cred, upgrade_cred)` |
| PLB redeemer | `SpendVia*` enum | `BaseSpendRedeemer` record; the act moved to the dispatcher |
| `transferRedeemer` | `(params_idx, proofs)` | `(proofs)` |
| `thirdPartyRedeemer` / `unfrackingRedeemer` | `(params_idx, node_idx, outputs_start_idx)` | `(node_idx, outputs_start_idx)` |
| every programmable tx | delegate withdraw-0 | **plus the dispatcher's** — every `wdrl_idx` shifts |
| new deployment input | — | `maxInlineDatumBytes`, a **choice**, baked into three script hashes |
| gone | `coordinationNonce`, `coordination`, `directoryMint`, `directorySpend` | — |

⚠ **`max_inline_datum_bytes` changed KIND, not just place.** It was a mutable datum field
(re-tunable by an in-place upgrade) and is now a compile-time parameter of all three delegates —
changing it is a redeployment.

⚠ **A 0.5.0-alpha.2 deployment cannot be represented by this SDK**, and a 7-field params datum is
refused rather than read positionally: old index 1 was `prog_logic_cred`, new index 1 is
`transfer_cred`, and **both are Credentials** — a shifted read returns a well-formed value with the
wrong meaning. Point an alpha.2 instance at an 0.7.x release.

## Examples

> ### ⚠ The examples do not currently run. Do not follow this section yet.
>
> Two things are wrong with it, both known and neither hidden:
>
> 1. **The scripts target a superseded protocol.** They are written against a CIP-113 **0.3.x**
>    deployment on preprod. This SDK now targets **0.5.0-alpha.3**, in which `DeploymentParams`
>    has a different shape again — see the migration note below.
>    The scripts cannot work against that deployment, and the deployment cannot be represented
>    by this SDK.
> 2. **`.env.example` does not exist.** The `cp` below has never worked.
>
> **Nothing here is covered by CI** — `examples/` is a separate package, outside the root
> typecheck and outside the test suite, so neither defect can fail a build.
>
> Choosing a replacement target is an open decision (a local devnet, or a freshly deployed
> preprod instance); it is tracked in `PLAN.md` under workstream **W-E, slice S-7**. Until it is
> made, the working end-to-end reference is the **devnet suite** — `npm run test:devnet` — which
> exercises bootstrap, register, mint, transfer, third-party transfer and an in-place upgrade
> against a live chain. See `docs/devnet.md`.

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

- [Provenance: CIP-171 and blueprint pins](docs/provenance.md) — what ships, how to build a record, and why `compilerVersion` must come from the artefact

- [Getting Started](docs/getting-started.md) — prerequisites, setup, first token
- [API Reference](docs/api-reference.md) — all types, methods, utilities
- [Freeze-and-Seize](docs/substandards/freeze-and-seize.md) — compliance substandard
- [Dummy](docs/substandards/dummy.md) — minimal test substandard

## Peer Dependencies

- `@evolution-sdk/evolution` ^0.5.2
- `effect` ^3.0.0

## License

Apache-2.0
