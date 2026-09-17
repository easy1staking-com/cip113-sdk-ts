# Exporting the bootstrap — step boundaries, required inputs, and what stays with the caller

**T-D51-1.** Written BEFORE the code, per the slice contract's Task 1.

Authority: `CLAUDE.md` → *Protocol bootstrap — AMENDED 2026-09-17*. Building the transactions
that stand up a protocol instance belongs in this package and is exported. Orchestration, key
handling, submission and confirmation stay with the caller.

Success condition, restated so the shape follows the reason: **the platform can delete its port of
`test/harness/bootstrap.ts`.** That port already diverged from the harness — it reserves the seed
UTxOs from coin selection where the harness does not — and **the divergence is correct**. See
§6, where that divergence turns out to be a live devnet failure at this slice's own base commit.

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

⇒ **Persist the config; you can rebuild the plan.** A caller resuming at step N needs:

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

⚠ **The devnet suite is RED at this slice's base commit `b0bcf09`**, and the mechanism is exactly
the divergence the amendment names. Baseline run, 2026-09-17:

```
[submit error] tx1-protocol-state: ... code 3117, "The transaction contains unknown UTxO
references as inputs" ... unknownOutputReferences: [{ transaction: 0c9e19a3…, index: 1 }]
```

Step 2 is handed `availableUtxos = spendable(all wallet UTxOs)` — which **includes the two seeds
step 3 has not spent yet**. Coin selection is free to take one for fees. When it does, step 3's
`collectFrom` still names the stale seed object captured before step 2 ran, the builder faithfully
includes a spent input, and the ledger answers 3117 — an error that names a UTxO and reads as a
builder bug. It is not: the builder used what it was told.

⇒ The reservation is not an optimisation the platform happened to add. It is the fix for a live
failure, and the export's `availableUtxos` parameter is what lets a caller express it. The rewritten
harness reserves the seeds at its call site, exactly as the platform's port already does.

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
