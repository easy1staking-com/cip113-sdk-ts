# cip113-sdk-ts

TypeScript SDK for [CIP-113 Programmable Tokens](https://cips.cardano.org/cip/CIP-0113) on
Cardano. Published to npm as `@easy1staking/cip113-sdk-ts` (Apache-2.0, currently v0.3.1).

<!-- fabbrica:begin -->
## La Fabbrica
This repo is factory-operated (fabbrica plugin). Non-trivial requests go through
`intake` (never straight to code); tickets run as slice contracts with the
worker/auditor pair; before ending any significant work, run `distill` — "close
the circle" — even if Giovanni forgets to ask. State lives in PLAN.md + WORKLOG.md.
<!-- fabbrica:end -->

## Constitution

**Purpose.** One job: give TypeScript/JavaScript callers a clean, pluggable API for building
CIP-113 programmable-token transactions on Cardano. The SDK *builds and returns unsigned
transactions*; it does not run services, hold keys, index the chain, or provide UI.

**Boundaries — what belongs here:**
- The standard CIP-113 protocol layer: blueprint validation, script parameterization, the
  resolved-scripts object, registry/directory traversal.
- Substandard plugins implementing the `SubstandardPlugin` interface (today: `dummy`,
  `freeze-and-seize`), each behind its own package export path.
- CIP-57 blueprints (`blueprints/`) shipped with the package, versioned by directory.
- Documentation and runnable examples that exercise the public API.

**What does NOT belong here** — these signal code that wants its own repo:
- Aiken/Plutus validator *source*. This repo consumes compiled blueprints, it does not build
  them. A `.ak` file appearing here is an escalation.
- Backend services, indexers, schedulers, or anything with a database.
- Frontend/dApp code, wallet connectors, React components.
- Protocol *deployment/bootstrap* tooling, **with one scoped exception** (approved 2026-08-14):
  bootstrap code that exists solely to stand up a test fixture — deploying a protocol instance
  into a local devnet so the harness has a `DeploymentParams` to operate against — is permitted,
  provided it lives under the test/example tree, is excluded from the npm tarball, and is never
  presented as a supported way to deploy a production protocol. Deploying a real protocol
  instance remains another system's job: `DeploymentParams` is an input to this SDK.

**Allowed technologies.** TypeScript (strict, ES2022, ESM-only, `moduleResolution: bundler`),
compiled with `tsc` — no bundler, no transpiler, no build framework. Node 20+.

**Allowed dependencies.** Deliberately near-zero. Runtime deps are *peer* deps only, so the
consumer owns the version:
- `@evolution-sdk/evolution` ^0.5.2 — the sole Cardano toolchain. All UPLC application,
  hashing, address handling, CBOR, and tx building goes through it. Do not add a second
  Cardano library (no lucid, no MeshJS, no cardano-serialization-lib) — that is an escalation.
- `effect` ^3 — transitively required by Evolution SDK.

Dev-only: `typescript`, `@types/node`, and `tsx` (added 2026-08-14 so the devnet harness can be
written in TypeScript; never published — `files` is an allowlist of `dist` and `blueprints`).
The `examples/` package additionally uses `tsx` and `dotenv`, and talks to Blockfrost. Adding any
*non-peer* runtime dependency to the published package is an escalation to Giovanni, not a
judgment call — and adding even a dev dependency means updating this list in the same commit.

**Open question (deliberately undecided, 2026-08-14):** whether `examples/` should become its
own package or repo. It is already a separate npm package (`examples/package.json`, its own
lockfile, `file:..` link back to the root) and is excluded from the published tarball and from
root typechecking. For now it stays inside this repo's boundary. Do not split it without a
ruling from Giovanni.

## Commands

Verification here is **typecheck + build only**. Proven on 2026-08-14, Node v20.20.2 /
npm 10.8.2, from a clean `npm ci`:

| Command | Proves | Observed |
|---|---|---|
| `npm ci` | Lockfile installs cleanly | green — 43 packages, ~1s |
| `npm run typecheck` | `tsc --noEmit` over `src/**` — whole public surface typechecks | green — exit 0 |
| `npm run build` | `tsc` emits `dist/` (js + .d.ts + maps) — the published artifact compiles | green — exit 0 |
| `npm test` | build + `node --test test/` — blueprint provenance guard and the deployment hash assertion | green — 7 pass, 0 fail, 0 skipped |

Other scripts: `npm run dev` (`tsc --watch`), `npm run clean` (`rm -rf dist`),
`npm run prepublishOnly` (clean + build).

**Test coverage is narrow and deliberately so — know what it does and does not prove.**
`npm test` uses `node:test` (built into Node 20, zero dependencies) and covers exactly two
things: that every bundled blueprint matches its `UPSTREAM_PIN.json`, and that
`assertDeploymentScripts` reproduces the shipped deployment *and rejects a wrong value of the
correct type*. Both guards are proof-of-harness verified — each was made to go red before being
accepted as green.

Still absent: **no linter, no formatter, and no test that builds or submits a transaction.**
Consequences a ticket owner must plan around:

- Anything behavioural — does a transaction actually validate on-chain? — is verified today
  **only** by running `examples/` by hand against preprod with a funded seed phrase and a
  Blockfrost key. That is manual, costs real testnet ADA, is slow, and is not reproducible in
  CI. Treat any claim of "verified" that rests on it with proportionate scepticism.
- The devnet harness that closes this gap is PLAN.md workstream W-A.
- CI runs `typecheck` + `build` only; it does **not** yet run `npm test`. Wire that in with W-A.

CI (`.github/workflows/ci.yml`) runs `npm ci → typecheck → build` on Node 20 for pushes and PRs
to `main` — i.e. CI proves exactly what the table above proves, and nothing more.
`.github/workflows/publish.yml` publishes to npm on GitHub release, via npm 11 with OIDC
provenance (`id-token: write`).

## Layout

```
src/
  index.ts                    Public entry. CIP113.init() → CIP113Protocol; all re-exports.
  types.ts                    Primitives, CIP-57 blueprint shapes, DeploymentParams.
  core/
    evo-utils.ts              The workhorse. Evolution SDK wrappers: script build/parameterize/
                              hash, address derivation, Data constructors for every datum and
                              redeemer, UTxO accessors, CIP-67/68 helpers.
    registry.ts               Directory/registry node lookup, canonical input sorting,
                              reference-input index computation.
  standard/
    blueprint.ts              STANDARD_VALIDATORS titles, lookup, validateStandardBlueprint().
    scripts.ts                The parameterization chain (see below) → ResolvedStandardScripts.
    params.ts                 Type re-exports only.
  substandards/
    interface.ts              SubstandardPlugin + every *Params type + UnsignedTx.
    dummy/index.ts            Minimal substandard, transfer only, testing.
    freeze-and-seize/         Compliance substandard: register/mint/burn/transfer +
                              freeze/unfreeze/seize + initCompliance. ~1000 LOC, the bulk.
  provider/
    address-utils.ts          hex ↔ bech32 (CIP-30 wallets hand back hex).
    tx-utils.ts               assembleSignedTx — merges a CIP-30 witness set into an unsigned tx.
blueprints/                   Compiled CIP-57 blueprints, versioned by directory. Shipped.
  standard/v0.3.0/
  substandards/{dummy,freeze-and-seize}/v0.1.0/
examples/                     Separate npm package, 13 runnable preprod scripts. Not published.
docs/                         getting-started, api-reference, one page per substandard.
```

## Architecture

`CIP113.init(config)` validates the standard blueprint, runs the parameterization chain against
`DeploymentParams`, builds a `SubstandardContext`, and initialises each registered plugin. It
returns a `CIP113Protocol` whose operations *delegate to substandards* — the core owns no
transaction-building logic of its own.

**Routing.** `register()` and `compliance.init()` take an explicit `substandardId`. The others
(`mint`/`burn`/`transfer`) accept an optional `substandardId`; without it they fall through
`tryAllSubstandards`, calling each plugin in turn and returning the first that doesn't throw.
That fallback is a convenience, not a design goal — **always pass `substandardId`**. Without it
a genuine bug in plugin A is silently swallowed as "A can't handle this", and the error you
finally see is plugin B's, or an aggregate that names the wrong cause.

**The parameterization chain** (`src/standard/scripts.ts`) is order-dependent — each script's
hash feeds the next:

```
always_fail(nonce)                                        → hash
protocol_params_mint(utxo_ref, always_fail_hash)          → hash
programmable_logic_global(protocol_params_hash)           → hash
programmable_logic_base(Script(plg_hash))                 → hash
issuance_cbor_hex_mint(utxo_ref, always_fail_hash)        → hash
registry_mint(utxo_ref, issuance_cbor_hex_hash)           → hash
registry_spend(protocol_params_hash)                      → hash
issuance_mint(Script(plb_hash), registry_mint_hash, Script(minting_logic_hash))
```

`buildDeploymentScripts` parameterizes each script but then **overwrites the computed hash with
the one from `DeploymentParams`** — deployment is the source of truth, not re-derivation. If
you change parameterization and the on-chain hashes no longer match, this overwrite will hide
it from you locally and the failure will surface only as a script-hash mismatch at submission.
`issuanceMint` is deliberately *not* cached: it is parameterized per minting-logic hash via
`buildIssuanceMint(mintingLogicHash)`.

The FES chain (`src/substandards/freeze-and-seize/scripts.ts`) mirrors this shape for
`issuer_admin`, `transfer`, `blacklist_mint`, `blacklist_spend`.

## Conventions

- **ESM everywhere.** Every relative import carries a `.js` extension, including from `.ts`
  files (`"./types.js"`). This is required by `module: ES2022` — omitting it compiles but
  produces unresolvable output.
- **Evolution SDK is re-exported, not re-implemented.** `src/index.ts` re-exports the chain
  configs (`preprodChain`, `mainnetChain`, `previewChain`), `EvoAddress`, `EvoAssets`,
  `EvoData`, `EvoTransaction`, `EvoTransactionHash`, `EvoTransactionWitnessSet`, and
  `evoClient` (= `Client.make`) so consumers need no direct import. Add to this list rather
  than making callers reach into the peer dep.
- **No adapter layer.** Earlier iterations had one; it was removed. Substandards receive the
  Evolution SDK client directly. Do not reintroduce an abstraction over it.
- **`EvoClient = ReadOnlyClient | SigningClient`.** ReadOnly is the CIP-30/browser path,
  Signing is the seed-phrase path. They differ in `build()`'s return type. Anything that
  assumes it can sign must go through `_signBuilder`, which is only present on the signing path.
- **Asset names are raw hex, CIP-67 label included**, at every API boundary (e.g.
  `"0014df1044454d4f"` = label 333 + `DEMO`). Helpers: `labeledAssetName`, `stripCIP67Label`,
  `hasCIP67Label`.
- File-level block comments with `// ---` section rules are the house style. Match it.
- Errors are thrown `Error`s with actionable messages that list what *was* available
  (registered substandard ids, blueprint title/version). Keep that habit.

## Gotchas

- **`examples/` is not typechecked by anything.** Root `tsconfig.json` has
  `include: ["src/**/*.ts"]`, and CI only builds the root. The examples can break silently
  against an SDK change; nothing will tell you.
- **`examples/` consumes the built `dist/`,** via `"@easy1staking/cip113-sdk-ts": "file:.."`.
  Run `npm run build` at the root *before* running any example, or you will test stale code.
- **README drift, known and unfixed as of 2026-08-14:** README and docs instruct
  `cp .env.example .env` in `examples/`, but **no `.env.example` file exists** in the repo. A
  newcomer following the README cannot start. Seated in PLAN.md backlog; do not fix as a
  drive-by inside an unrelated slice.
- **`_signBuilder` on `UnsignedTx` is typed `any`** and marked internal, yet the README's
  quick-start uses it as the signing path (`result._signBuilder.signAndSubmit()`). It is
  load-bearing public API in practice. Treat changes to it as breaking.
- **Blueprint versions are directory names, not semver ranges.** `blueprints/standard/v0.3.0/`
  is pinned by path in `examples/shared/config.ts`. Adding a blueprint version means adding a
  directory and updating every explicit path.
- **`npm audit` reports 3 vulnerabilities (1 moderate, 2 high)** in the dev/transitive tree as
  of 2026-08-14. Not triaged. Not a build blocker.
- Two lockfiles exist (root and `examples/`); they are independent.

## Factory state

`PLAN.md`, `WORKLOG.md`, and `.fabbrica/` hold factory state. This repo is **public**, so per
the fabbrica tracking rule they are kept untracked via `.git/info/exclude` (never
`.gitignore` — the exclusion itself stays off the public record). They exist on disk; they will
not appear in `git status`. Orchestrators emit `.fabbrica/events.jsonl` (schema v1) at ticket
close; the directory is pre-excluded and ready.
