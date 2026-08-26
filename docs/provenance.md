# Provenance: CIP-171 and blueprint pins

Two related questions this package answers, and several it deliberately does not.

## What ships, and what does not

| | ships in the npm package | where it lives |
|---|---|---|
| CIP-171 **encoder** — build, chunk, decode a record | **yes** | `src/core/cip171.ts`, re-exported from the root |
| Parameterisation **recorder** — capture what was applied to what | **yes** | optional callback on `createStandardScripts` / `createFESScripts` |
| **Emission** — attaching a record to a real transaction | **no** | `test/harness/`, excluded from the tarball |
| **Deployment** of a protocol instance | **no** | `test/harness/`, and see the constitution |

> **The package cannot publish a CIP-171 record.** It can build one. Publishing is the
> deploying system's job — the record's content (this repo, this commit, this compiler, *these*
> parameters) only exists at deploy time. `DeploymentParams` is an input to this SDK.

## Building a record

```ts
import { buildCip171Metadatum, cip171Param, CompilerType } from "@easy1staking/cip113-sdk-ts";

const events = [];
const scripts = createStandardScripts(blueprint, (e) => events.push(e));
// ... parameterise as usual; `events` now holds every (rawScriptHash, params) pair

const chunks = buildCip171Metadatum({
  compilerType: CompilerType.AIKEN,
  sourceUrl, commitHash, sourcePath,
  compilerVersion: blueprint.preamble.compiler.version,   // ← see below
  env: "",                                                 // "" = built without --env
  scripts: events.map((e) => ({
    rawScriptHash: e.rawScriptHash,
    params: e.params.map(cip171Param),
  })),
});
// attach `chunks` at metadata label 1984
```

**Derive the record from the recorder, never transcribe it.** The map is keyed by the
**unapplied** script hash and its values are in **application order** — both are properties of
the parameterisation call and of nothing else. A hand-maintained second list agrees with the
deployment right up until it doesn't, and the disagreement surfaces only as a hash that verifies
to nothing.

## Three things that will bite

**1. `compilerVersion` comes from the artefact, never from your machine.** Read
`blueprint.preamble.compiler.version`. Aiken is typically installed machine-globally, and the
blueprints in this repo were built by **four different versions** — `v1.1.23+8949565` (standard
v0.5.0-alpha.2), `v1.1.21+42babe5` (freeze-and-seize, dummy v0.2.0, standard v0.3.0),
`v1.1.19+e525483` (dummy v0.1.0). A record naming your local toolchain is a false provenance
claim, and it fails *worse* than an absent one: the verifier rebuilds with the wrong compiler and
reports the resulting hash mismatch as **your** defect.

**2. Six fields, not five.** Constructor 0 (Aiken) carries
`[sourceUrl, commitHash, sourcePath, compilerVersion, env, parameters]`. The **merged** CIP-0171
text documents five and omits `env`; the six-field layout is the amendment (PR #1252, open at time
of writing) and it is what the reference implementation's parser requires. A five-field record is
**discarded silently** — no error, no rejection, no registry entry. This encoder emits six.

**3. `parameters` values are bytestring-wrapped.** The published CDDL says
`parameter_list = [ * plutus_data ]` and is wrong; each element is a bytestring whose *contents*
are the parameter's CBOR. Use `cip171Param`. Emitting inline `PlutusData` is not rejected — the
registry reads `.bytes` on each element, gets nothing, and stores a record whose parameters have
silently vanished while the record itself still parses.

## Verifying a record you built

**"It submitted" is not evidence.** Acceptance has three levels and only the third is acceptance:

1. the transaction submitted — consistent with success *and* total failure
2. a lookup by tx hash returns 200 — proves **ingestion only**; `PENDING` and `REJECTED` rows
   both return 200
3. **`status == "VERIFIED"`, and every covered script is `COMPLETE` or `NONE_REQUIRED` — never
   `PARTIAL` — with a `finalHash` matching the deployed hash**

The per-script half is load-bearing, not belt-and-braces: a record can report `VERIFIED` while a
script inside it has no final hash and proves nothing.

Offline, the strongest check is **recomputation**: parameterise the raw script with the recorded
arguments, hash it, and compare against the hash actually deployed. See
`test/devnet/cip171-provenance.test.ts`.

## Where a record may live

CIP-0171 associates a record with a script **by script hash, not by transaction** — verifiers
scan for label 1984, rebuild from source, and match against on-chain script hashes. A record may
therefore be published **later, by anyone, in any transaction**. This repo uses both shapes:

- **attached** to the bootstrap transaction, for a core deployment — one artefact to inspect
- **standalone**, in its own metadata-only transaction, for substandard registration, where the
  transaction is built by SDK API rather than by the deployer

Neither is more valid than the other.

## Blueprint provenance pins

Every directory under `blueprints/` carries an `UPSTREAM_PIN.json` beside its `plutus.json`,
recording the upstream repo, the **commit** (never a tag — the upstream repo publishes none), the
compiler required to reproduce it, and a `provenance` field:

| value | meaning |
|---|---|
| `VERIFIED` | reproduced byte-identically from the named commit |
| `UNVERIFIED` | not reproducible today — the named commit is unreachable, or reproduction has not been done |
| `UNKNOWN` | provenance was never established |

**Current state of shipped blueprints:**

| blueprint | provenance |
|---|---|
| `standard/v0.5.0-alpha.2` | **VERIFIED** |
| `substandards/freeze-and-seize/v0.1.0` | **VERIFIED** |
| `standard/v0.3.0` | `UNVERIFIED` — **not recoverable by pushing**: its pin names *no commit at all*, because the artefact matches no commit in upstream's history. A legacy blueprint; `src/` does not load it |
| `substandards/dummy/v0.2.0` | `UNVERIFIED` — **recoverable**: its pin names a real commit that is simply not reachable upstream yet |
| `substandards/dummy/v0.1.0` | `UNKNOWN` — **PERMANENT**: `upstream.repo` and `upstream.commit` are both null; the source project was never recorded anywhere in this repo, so there is no origin to recover and no push or rebuild can manufacture one |

> **Do not emit a CIP-171 record for a blueprint that is not `VERIFIED`.** A record is a
> permanent, public claim that named scripts came from a named commit; if nobody can fetch that
> commit, the claim cannot be checked and should not be made. Unlike a file, a metadatum cannot
> be deleted. The record builder in this repo's harness refuses non-`VERIFIED` blueprints for
> exactly this reason.
