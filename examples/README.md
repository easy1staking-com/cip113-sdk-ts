# CIP-113 SDK examples

Runnable end-to-end scripts for the BaFin, Freeze-and-Seize, and Dummy substandards.

## Setup

```bash
cd examples
cp .env.example .env    # edit as needed
npm install
```

## Picking a network

Set `NETWORK` in `.env` to one of:

| `NETWORK` | Provider | Funding | Bootstrap |
|-----------|----------|---------|-----------|
| `preprod` / `preview` | Blockfrost | public faucet | pre-deployed, in `deployment-<network>.json` |
| `mainnet` | Blockfrost | real ADA | pre-deployed |
| `yaci` | Kupmios (Yaci DevKit) | Yaci admin API | run `npm run yaci:bootstrap` once |

For preprod/preview/mainnet also set `BLOCKFROST_PROJECT_ID` and `WALLET_MNEMONIC`.

## Local dev with Yaci DevKit

A fresh local devnet gives instant confirmation, unlimited funds, and a clean slate every reset — no faucet drip, no indexing lag, no flaky Blockfrost. The CIP-113 standard has not been deployed on a Yaci devnet out of the box, so the first step is running the bootstrap once.

### Install

Pick one (NPM is simplest on macOS):

```bash
# NPM
npm install -g @bloxbean/yaci-devkit

# Docker
curl --proto '=https' --tlsv1.2 -LsSf https://devkit.yaci.xyz/install.sh | bash
```

### Launch

In a dedicated terminal — leave it running:

```bash
yaci-devkit up --enable-yaci-store
```

Default ports: node 3001, Yaci Store 8080, Ogmios 1337, Kupo 1442, Admin API 10000, Viewer 5173. If any are taken, edit `config/env` (Docker) or `application.properties` (Zip).

### Configure the SDK

```bash
# examples/.env
NETWORK=yaci
WALLET_MNEMONIC="test test test test test test test test test test test test test test test test test test test test test test test sauce"
# defaults — uncomment only to override
# YACI_ADMIN_URL=http://localhost:10000
# YACI_PROVIDER=kupmios           # or "blockfrost" to hit Yaci Store's Blockfrost-compat API
# KUPO_URL=http://localhost:1442
# OGMIOS_URL=http://localhost:1337
# BLOCKFROST_URL=http://localhost:8080/api/v1
```

The mnemonic above is Yaci's pre-funded default (20 addresses × 10k ADA). Any other mnemonic works too — the bootstrap script will auto-topup via the admin API.

### Bootstrap the CIP-113 standard

Once per fresh devnet:

```bash
npm run yaci:bootstrap
```

This spends two wallet UTxOs as one-shot seeds, mints the three sentinel NFTs (`ProtocolParams`, registry, `IssuanceCborHex`), publishes the two programmable-logic reference scripts, registers the global stake credential, and writes `shared/deployment-yaci.json`. That file is gitignored and regenerated every run — treat it like `node_modules`.

### Run a flow

```bash
npm run yaci:bafin        # full BaFin lifecycle (~30s)
# or step-by-step:
npx tsx bafin/00-setup.ts
npx tsx bafin/01-init-linked-lists.ts
npx tsx bafin/02-add-power-user.ts
npx tsx bafin/03-add-user.ts
npx tsx bafin/04-register.ts
```

Same flows work for Freeze-and-Seize: `npm run fes:setup`, `fes:init-compliance`, etc.

### Reset

```bash
npm run yaci:reset              # wipe chain state — devnet keeps running
npm run yaci:bootstrap          # redeploy standard
```

Any pending `deployment-yaci.json` is invalidated by a reset; re-run bootstrap before any substandard script. Balance-low errors? `npm run yaci:topup <addr> <ada>`.

### Troubleshooting

- **`Is yaci-devkit running?`** — the admin API is unreachable. Confirm `yaci-devkit up` is still alive in the other terminal and that `YACI_ADMIN_URL` matches.
- **`Protocol params UTxO not found`** — you haven't run `yaci:bootstrap`, or you reset without re-bootstrapping.
- **Transactions rejected with "missing required signers"** — the mnemonic in `.env` doesn't derive to the pre-funded address. Set `WALLET_MNEMONIC` to the default sauce phrase, or use `yaci:topup` to fund your own address first.
- **Script evaluation errors** — Yaci Store requires Ogmios to be running for `/utils/txs/evaluate`. `--enable-yaci-store` starts both.

Logs and live chain state: visit `http://localhost:5173` (Yaci Viewer).

## Public testnet flow (preprod / preview)

1. Get a Blockfrost key at [blockfrost.io](https://blockfrost.io) and set `BLOCKFROST_PROJECT_ID`.
2. Fund `WALLET_MNEMONIC`'s first address from the public faucet.
3. `NETWORK=preprod npm run fes:setup` (and the rest of the sequence). Deployment params ship in `shared/deployment-<network>.json`.

## Script index

| Command | What it does |
|---------|--------------|
| `fes:setup` → `fes:transfer-unfrozen` | Freeze-and-Seize full lifecycle |
| `dummy:setup` / `dummy:transfer` | Minimal transfer demo |
| `yaci:reset` / `yaci:topup` / `yaci:bootstrap` / `yaci:bafin` | Yaci DevKit devnet helpers |
| `npx tsx bafin/run-all.ts` | BaFin full lifecycle (no shortcut script yet) |
