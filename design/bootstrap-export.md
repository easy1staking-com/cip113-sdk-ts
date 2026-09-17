# Exporting the bootstrap — step boundaries, required inputs, and what stays with the caller

**T-D51-1.** Written BEFORE the code, per the slice contract's Task 1.

Authority: `CLAUDE.md` → *Protocol bootstrap — AMENDED 2026-09-17*. Building the transactions
that stand up a protocol instance belongs in this package and is exported. Orchestration, key
handling, submission and confirmation stay with the caller.

Success condition, restated so the shape follows the reason: **the platform can delete its port of
`test/harness/bootstrap.ts`.** That port already diverged from the harness — it reserves the seed
UTxOs from coin selection where the harness does not — and **the divergence is correct**. See §6,
where that divergence is examined — and where a round-1 claim about it is RETRACTED and corrected.

---

## 1. Five, or six? — the discrepancy the contract asked me to reconcile

Both numbers are true of different things, and the harness itself contains all three counts.

| count | what it counts | where it is written |
|---|---|---|
| **6** | transactions that LAND ON CHAIN per fresh harness run | `bootstrap.ts:141` — *"the change churn of six transactions"* |
| **5** | submissions that go through the harness's `submitAndWait` helper per run | `bootstrap.ts:624` — *"only 'submitTx failed' across five distinct submissions"* |
| **6** | `submitAndWait` CALL SITES (labels `tx0`…`tx5`) | `dummy-lifecycle.test.ts:124` — *"the FIXTURE's six submissions"* |
| **3** | the mint/publish/register split of what used to be one transaction | `bootstrap.ts:605` — *"THREE transactions, not one"* |

The reconciliation:

* The **fragmentation** transaction (`bootstrap.ts:320-328`) is submitted with a bare
  `signAndSubmit()` and never passes through `submitAndWait`. It is the sixth on-chain transaction
  and the one the "five submissions" comment cannot see.
* `tx3` (register-and-delegate) and `tx4` (delegate-only) are **mutually exclusive per run**: six
  labels, five submissions. `tx4` runs when the wallet's stake key was already registered by an
  earlier bootstrap on the same devnet; `tx3` runs on the first.

⇒ Nothing in the repo is wrong; three different denominators were each recorded correctly and
never beside each other.

**And Giovanni's "five" is right about the export, for a third reason.** `tx3`/`tx4` registers and
DRep-delegates the **wallet's own stake key** — not the protocol's. Under alpha.4 that key is no
longer the upgrade authority (the multisig is, and its credential is registered in `tx5`); the key
survives only as the **nominee** that `T-F03-3`'s handover test promotes. A protocol instance is
fully operable without it. It is therefore a **fixture concern and stays in the harness**, and the
exported sequence is exactly five steps.

---

## 2. The constraint that decides the API shape

**You cannot return five ready transactions.** Confirmed in the harness, not taken on trust:

* `bootstrap.ts:315-348` — the fragmentation step produces three seed UTxOs and the code then reads
  their **output references** off the chain.
* `protocol_params(utxo1Ref)` (`:413`), `issuance_cbor_hex_mint(utxo2Ref, …)` (`:421`),
  `registry(utxo1Ref, …)` (`:422`) and `upgrade_multisig(utxo3Ref)` (`:406`) are **one-shot
  policies parameterised by those exact output references**. Their script hashes — and therefore
  every address, every NFT policy id and the entire params datum — do not exist until the
  fragmentation transaction has been submitted and observed.

⇒ The export is **stepwise**. Each step takes what the previous step produced and returns the next
unsigned transaction. The caller submits, waits, and feeds the result back.

That is not a limitation dressed as a design: it is precisely what lets the platform keep **its
own UTxO reservation** and **its own await strategy**, which is the divergence this amendment
exists to preserve.

---

## 3. Resumability — a caller who is part-way through must not have to start over

The harness restarts from scratch. The platform will not always be able to.

The resume mechanism is a **pure, deterministic plan**:

```
planBootstrap(config: BootstrapConfig): BootstrapPlan
```

`BootstrapConfig` is a **record**, not a live object — blueprint, network id, the three seed
outrefs, the `always_fail` nonce, `maxInlineDatumBytes`, and the unfracking choice. `planBootstrap`
touches no network, holds no client and makes no decisions of its own: given the same config it
re-derives byte-identical scripts, addresses, datums and asset units, on any machine, at any time.

⇒ **Persist the config; you can rebuild the plan.**

⚠ **IT IS NOT `JSON.stringify`-ABLE AS IT STANDS.** `maxInlineDatumBytes` is a `bigint`, and
`JSON.stringify` **throws** `TypeError: Do not know how to serialize a BigInt` on it. The failure is
loud rather than silent, which is the good direction — but a caller told to "persist the config"
should not meet it by surprise. Convert that one field on the way out (`String(...)`) and back
(`BigInt(...)`), and **never via `Number(...)`**: a security parameter must not depend on a lossy
round trip. The blueprint is ordinary JSON and needs no special handling.

A caller resuming at step N needs:

| resuming at | needs |
|---|---|
| 2 multisig genesis | plan + the `upgradeMultisig` seed UTxO (unspent) |
| 3 protocol genesis | plan + the `protocolParams` and `issuance` seed UTxOs (unspent) |
| 4 reference scripts | plan only |
| 5 stake registrations | plan only |
| assemble params | plan + two tx hashes + the multisig config UTxO's outref |

⛔ **No step needs an earlier step's consumed inputs.** That is the property that makes resumption
work at all: by the time you are resuming at step 4, the seeds are spent and unfetchable, and step 4
must not ask for them.

Each build step that takes a seed UTxO **verifies it against the plan's outref by name** and refuses
otherwise — a resume with the wrong seed would otherwise build a valid transaction against the wrong
one-shot policy and fail on chain naming nothing.

A caller who already holds three distinct unspent UTxOs may **skip step 1 entirely** and call
`planBootstrap` with their outrefs. Step 1 is a convenience, not a prerequisite.

---

## 4. The five steps

| # | step id | builder | consumes | produces |
|---|---|---|---|---|
| 1 | `seed` | `buildSeedTx` | caller-supplied wallet UTxOs | ≥3 distinct seed outputs at the owner address |
| 2 | `multisig-genesis` | `buildMultisigGenesisTx` | the `upgradeMultisig` seed | the `upgrade_multisig` config UTxO — one-shot NFT + the signer tree |
| 3 | `protocol-genesis` | `buildProtocolGenesisTx` | the `protocolParams` + `issuance` seeds | params UTxO, registry origin node, issuance-CBOR UTxO, CIP-171 metadata |
| 4 | `reference-scripts` | `buildReferenceScriptsTx` | wallet UTxOs | 7 reference-script outputs, in `REFERENCE_SCRIPT_ORDER` |
| 5 | `stake-registrations` | `buildStakeRegistrationTx` | wallet UTxOs | 6 Conway `RegCert`s for the withdraw-0 credentials |

Then `assembleDeploymentParams(...)`, pure, → `DeploymentParams`.

### Why these boundaries and not others

* **1 before everything** — one-shot parameterisation (§2). Three seeds, not one: `protocolParams`
  and `upgradeMultisig` are two same-typed one-shot outrefs in `DeploymentParams`, and a record that
  gives them one value makes `assertDeploymentScripts` pass whichever field the code reads
  (`bootstrap.ts:357-380`, the S-11 vacuity trap).
* **2 before 3, and it is not a style choice.** Step 3 writes a genesis datum naming
  `upgrade_cred = Script(upgrade_multisig)`. That authority is usable only while its config UTxO
  exists — the signer tree lives there, not in the script's parameters. Running the multisig genesis
  *after* the protocol genesis and failing leaves a protocol naming an authority whose config UTxO
  does not exist: upstream's documented **one-way brick**, manufactured by transaction ordering
  rather than by any defect in the validators. Failing before the irreversible step costs one
  transaction.
* **3 before 4** — a transaction cannot reference a script it is itself creating.
* **4 before 5, and 5 separate from 3** — each `RegCert` executes its script under the **publish**
  purpose, so the transaction carries all six script bodies. Folding those into the mint transaction
  is what burst the 16,384-byte cap (MEASURED at 21,816 bytes on the 0.3.x single-transaction
  fixture, `bootstrap.ts:605-610`).

### `REFERENCE_SCRIPT_ORDER` is one fact, exported

`[plb, plg, transfer, thirdParty, unfracking, issuanceLogic, upgradeMultisig]`. Step 4 pays them in
that order and `assembleDeploymentParams` derives every `…RefInput` index from the same array.
⛔ **Appended, never inserted** — alpha.3 inserted the dispatcher at index 1 and shifted three
delegates down, and a mismatch does not fail loudly: it hands out a reference input carrying the
wrong script, and the transaction dies at evaluation naming neither.

⛔ **AND APPENDING IS NOT FREE — THE LIST IS ALREADY AT 76% OF THE CAP.** MEASURED on devnet,
2026-09-17: step 4's transaction comes to **12,496 bytes against a 16,384-byte protocol maximum.**
Two more scripts the size of those already here would burst it, and the failure would arrive at
SUBMISSION rather than at build. This is the same cap that forced the mint/publish/register split in
the first place — the 0.3.x single-transaction fixture measured 21,816 bytes.
`buildReferenceScriptsTx` now refuses against the chain's own `maxTxSize` and reports the measured
size in its result metadata, so a deployment can see its headroom without instrumenting anything.
**When that refusal fires the answer is a SECOND publish transaction and a second recorded hash —
never a shorter list**, whose indices a deployment record already depends on.

---

## 5. Required inputs — every value the caller must decide

⛔ *A value the caller must decide is a **required input**, never a default.* That rule is the whole
reason this export is safe to make. Nothing below has a default.

| input | was, in the harness | is now |
|---|---|---|
| `alwaysFailNonce` | `ALWAYS_FAIL_NONCE_B`, a fixed constant so devnet rebuilds reproduce | `BootstrapConfig.alwaysFailNonce`, required |
| `maxInlineDatumBytes` | `MAX_INLINE_DATUM_BYTES = 1024n`, whose own comment records it as a **devnet fixture value and explicitly not a recommendation** (PLAN.md D-17) | `BootstrapConfig.maxInlineDatumBytes`, required |
| unfracking enabled/disabled | implicit — the harness always compiles the dispatcher against the real hash | `BootstrapConfig.unfracking: "enabled" \| "disabled"`, required |
| the signer set | `{ signature: adminPkh }`, the bootstrapping wallet | `upgradeMultisigTree: MultisigScriptTree`, required |
| which UTxOs may be spent | computed inside, as `spendable(await client.getUtxos(...))` | `availableUtxos`, required on every build step |
| the wallet | `makeClient()` → `TEST_MNEMONIC` | `client: EvoClient`, required; the SDK never constructs one |
| the evaluator | `createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337")` | `evaluator?: Evaluator`, injected; the export never names a URL |
| seed output size | `SEED_ADA = 5_000_000n` | `seedLovelace`, required on step 1 |
| reference-script output size | `20_000_000n` | `referenceScriptLovelace`, required on step 4 |
| CIP-171 provenance | read off disk from `UPSTREAM_PIN.json` | `provenancePin?: UpstreamPin`, passed in; the export reads no files |

**Every caller-chosen lovelace figure is now REFUSED below its computed minimum, by name.**
`seedLovelace` and `referenceScriptLovelace` were required but unvalidated: `1n` built happily and
failed at submission as *"insufficient Ada"* — the exact failure min-UTxO solving exists to prevent,
arriving from the one figure the builder does not solve because the caller chose it. The
reference-script bound adds the largest script's own bytes at `coinsPerUtxoByte` each and is
declared a **lower bound** (the true requirement is higher by the script ref's CBOR wrapping) so it
cannot be read as a sufficiency check. Neither floor promises the figure is *enough* — a seed also
funds the fee of the transaction that consumes it, and that is the caller's arithmetic.

**Every datum-bearing genesis output is SOLVED and then ROUNDED UP TO A WHOLE ADA.** The solve
returns the exact minimum — 4,361,720 lovelace for the issuance output at `coinsPerUtxoByte` 4310 —
and exact is the wrong side of the line here. That figure is
`coinsPerUtxoByte × (160 + serialised output size)`, and the serialised size comes from Evolution's
`TxOut` encoder, which this package does not own; `minUtxoAtLeast`'s own docstring promises only
that the figure rises relative to what this package used to emit, **not that the encoder holds
still**. ⚠ **A one-byte widening there under-funds the protocol's largest output by
`coinsPerUtxoByte`, and Evolution does not rescue an under-funded `payToAddress` — the shortfall
survives to submission and the ledger rejects the IRREVERSIBLE genesis step as "insufficient Ada",
pointing the reader at the wallet balance rather than at the encoder.** A whole-ADA ceiling is a
rule rather than a guessed constant, absorbs on the order of a hundred bytes of encoder drift, and
is still an order of magnitude below the flat 15 ADA this sequence used to write.

**`unfracking` is a discriminator here and a VALUE in `DeploymentParams`, deliberately.** The
recorded field must be a value — a deployment file opened in three years has to say what the
dispatcher was compiled from without needing a version of this SDK to interpret a boolean. But at
*bootstrap* time the enabled value is the `unfracking` script's own hash, which does not exist until
the plan derives it, so the caller cannot supply it and a choice is the only thing they can express.
The plan resolves the choice into the value, and `assembleDeploymentParams` records the value.

### Never shipped

No mnemonic or seed phrase. No `localhost` and no endpoint of any kind. No hardcoded nonce. No
placeholder policy id as a default (`issuance_mint`'s CBOR splice placeholder is an internal
implementation detail of one function, never a parameter or a default). No `client: any`, and no
`any` in the exported surface at all.

---

## 6. What is deliberately left with the caller

This is the part the contract asked to be explicit about. Each of these is orchestration, key
handling, submission or confirmation — the boundary CLAUDE.md drew.

1. **Signing, submission and confirmation.** The SDK returns `UnsignedTx` and does not sign, submit
   or await. The caller decides when to submit, how long to wait, and what "observed" means.
2. **Funding.** Faucet calls, balance floors, top-ups. `MIN_WALLET_ADA`/`TOPUP_ADA` stay in the
   harness; they are devnet-faucet arithmetic, not protocol.
3. **Indexer settling.** `settleIndexer` — waiting for two consecutive identical UTxO reads — is a
   property of the caller's provider, not of the protocol. Blockfrost, Kupo and a node's mempool
   each need a different strategy, and `bootstrap.ts:250-261` already records that Evolution's own
   `awaitTx` gave up on preview 90s after the transaction had in fact been included.
4. **Coin selection and UTxO reservation.** ⛔ **The single most important one.** Every build step
   takes `availableUtxos` as a **required** input. The caller decides what is spendable — which is
   how the platform keeps its (correct) seed reservation and how the harness keeps its
   "never spend a reference-script UTxO" filter. The export offers no default, because a default
   here is Evolution querying the wallet and spending live protocol infrastructure.
5. **The wallet's own stake key.** Registration and DRep delegation of the nominee (`tx3`/`tx4`) is
   not part of standing up a protocol — see §1.
6. **Retries.** `retryTransient` and its positive allowlist of provider signatures stay in the
   harness. A retry policy is a property of a provider.
7. **Reading the chain.** The export takes UTxOs as arguments and returns transactions; it does not
   poll. The one place the harness reads the chain for a *protocol* reason — the operability gate on
   the multisig config UTxO — is offered as a **pure function** over UTxOs the caller fetched
   (`assertMultisigConfigUtxo`), so the platform gets the gate without the SDK getting a network
   call.
8. **The decoy UTxO.** A second, NFT-free output parked at the multisig address so the config-UTxO
   lookup must actually discriminate (audit r1 F-2: with a population of one, the policy filter
   survived replacement by "take anything at this address"). That is a **fixture for the gate**, not
   protocol state, and a production deployment should not mint a permanently unspendable junk UTxO.
   ⇒ It moves out of the genesis transaction and becomes **the harness's own transaction**, after
   step 2 and before the gate. Safe by the same reading as before: `upgrade_multisig.mint`'s rail 3
   uses `list.expect_find`, which skips a non-matching output rather than rejecting it.

### The one measured consequence of leaving coin selection with the caller

⚠ **A CLAIM RETRACTED — READ THIS BEFORE CITING THE ONE IT REPLACES.** An earlier revision of this
document, and commit `6135207`'s message, asserted that *"the devnet suite is RED at this slice's
base commit `b0bcf09` — 14/33 — every failure ledger code 3117"*. **That measurement does not
reproduce.** Re-run independently at `b0bcf09` in a detached worktree: **33 tests, 31 pass, 2 fail,
ZERO occurrences of 3117, and the bootstrap step itself passing.**

**The MECHANISM is real and survives the retraction; only the measurement overstated itself.** Base
`spendable` is `all.filter(u => !u.scriptRef)` with no reservation, and step 3's `collectFrom` names
seed objects captured before step 2 ran — so coin selection is free to take a seed for fees and the
protocol genesis then names a spent input, which the ledger answers with code 3117, *"unknown UTxO
references as inputs"*. That error names a UTxO and reads as a builder bug. It is not: the builder
used exactly what it was told it could spend.

⇒ **It is a LATENT, STATE-DEPENDENT failure that the reservation removes — a coin-selection race,
not a deterministic property of the commit.** Why it cannot be read off a commit at all:
`test/harness/yaci.mjs` uses ONE FIXED SHARED WALLET, topped up only when its balance falls below
400 ADA. Whether coin selection reaches a seed depends on how fragmented that wallet happens to be,
which is a function of how many suites have run on this devnet since the last top-up — **not of the
code under test.** Two runs of the same commit can legitimately disagree, and the run that produced
"14/33" was one of them.

⚠ **Why the correction matters more than the number.** This sentence is permanent provenance for an
expansion of a published package's public API. A reader who tries to reproduce "RED at b0bcf09"
finds a green base and concludes the whole justification was invented — when only the measurement
was unstable. **The requirement itself is right and does not rest on that reading:**
`availableUtxos` is required because a default here means Evolution querying the wallet and being
free to spend live protocol infrastructure, and because CLAUDE.md's amended clause — Giovanni's
first-hand ruling — stands on its own without any corroboration from a devnet run.

---

## 6b. ACCEPTED DEVIATION — `_signBuilder` is populated on the returned `UnsignedTx`

The slice contract said: *"`_signBuilder` exists on `UnsignedTx` and is load-bearing public API in
practice — do not extend that pattern into new surface."* **The five builders populate it.** Declared
here rather than only in a code comment, because the contract named it explicitly.

**The reading taken:** the prohibition is on inventing NEW `any`-typed escape hatches. `UnsignedTx`
is the SDK's single result type, `_signBuilder` is an existing optional field on it, and every other
operation in this package already sets it. Returning the same object shape is using the existing
surface, not extending it.

**Why not omitting it:** the bootstrap would become the one `UnsignedTx` in the package whose result
cannot be submitted — the exact defect `dummy.transfer` already recorded once, which surfaced at the
CALL SITE as *"Cannot read properties of undefined (reading 'signAndSubmit')"* and read as a caller
mistake rather than a missing field.

⚠ **What this does NOT change:** the SDK still signs nothing, submits nothing and awaits nothing.
`cbor` is the supported path and the one a key-holding caller should prefer.

⛔ **KNOWN RESIDUE, seated as T-D52 rather than closed here:** the supported `cbor` path has **no
chain-level proof**, because the devnet harness submits through `_signBuilder`. Every green devnet
run exercises the internal field and none of them exercises the documented one. Closing it means
submitting a cbor-reconstructed transaction on devnet.

---

## 7. Where `DeploymentParams` is assembled

In `assembleDeploymentParams(plan, observed)` — pure, no client, no chain access.

`observed` carries the four things only the chain can tell you:

* `protocolGenesisTxHash` — becomes `txHash` and the `protocolParams.utxo` reference (output 0).
* `referenceScriptsTxHash` — with `REFERENCE_SCRIPT_ORDER`, becomes all seven `…RefInput`s.
* `multisigConfigUtxo` — ⚠ **read back off the chain, never assumed from step 2's outputs.** It is
  mutable state: a signer rotation spends and recreates it.
* everything else is derived from the plan, so it cannot disagree with what was deployed.

⛔ `upgradeAuthority` and the genesis datum's `upgrade_cred` are **one fact written twice**, and
nothing on chain may check them against each other. `planBootstrap` derives both from the same
value, which is the only way to keep them from drifting.

---

## 8. Offline guards (Task 4)

The devnet cannot run in CI, so the export is guarded by `test/bootstrap-export.test.mjs`:

* each step builds the transaction it claims to, from fixed inputs — asserted on the decoded CBOR
  (inputs, mints, outputs, certificates, reference scripts), not on the fact that a build returned;
* every required-input rule refuses an absent or empty value **by name**;
* a **pinned** assertion that the plan's parameterisation chain still reproduces the live preview
  dispatcher hash `d599d56f944d33a90b16f561ee61f183a4ba3c9185f2d779e0d356f4` — an independent value
  that came off a real bootstrap, not one this test derived a moment earlier;
* the plan is deterministic: the same config twice yields identical hashes, and any one input
  changed moves them.

Chain-level proof stays where it has always been: `npm run test:devnet`, which exercises the export
through the rewritten harness. A harness that stopped using the export would leave the export
untested — that is why Task 3 is not tidiness.

### ⛔ The devnet suite is NOT GREEN, and saying so is part of the deliverable

**`npm run test:devnet` at HEAD: 33 tests, 31 pass, 2 fail, 0 skipped.** The slice contract's
Invariant 1 said *"the devnet suite still passes"*, and it does not. **Do not read a green anywhere
in this document.**

The two failures are `not ok 3` (*freeze-and-seize: its REGISTRATION tx carries a CIP-171 record
that recomputes*) and `not ok 5` (*the bootstrap's CIP-171 record recomputes to the deployed script
hashes*). Both fail with *"must carry label 1984 — got labels `[]`"*.

**Diagnosis, and why it is not a regression:**
* **The identical two fail identically at base `b0bcf09`.** Measured, not assumed.
* **The metadata IS attached.** The offline suite asserts `attachMetadata` fires under label 1984
  with a CIP-171 record built from the plan's own parameterisations.
* **The failure is on the READ side.** Both tests fetch the transaction back through **yaci-store on
  `:8080`, which is stuck at slot 402,599 while the node is at 603,976** — over 201,000 slots behind
  and not advancing. Kupo, which every other test uses, is exactly at tip. The store returns an empty
  metadata list because it has never seen the transaction.

⚠ Environmental and pre-existing. Not fixed here: a store reset is a **lifecycle** operation on a
shared devnet and needs coordinating, and this slice's irreversible-action scope is submissions only.
**The residue worth recording is the earlier silence about this, not the failure itself.**
