# Type-0 stake registration for script credentials

Investigation, 2026-09-17. Branch `feat/type0-stake-registration`, off `main` @ `f42758e`.

**Status: Q3 AND THE GATE (Q4) BOTH SETTLED ON CHAIN.** Every verdict below was
obtained by submitting a transaction to a live Conway ledger and reading its answer.
Nothing here is derived from a specification, a changelog, or a reading of ledger
source.

| | Verdict |
|---|---|
| **Q3** — does the ledger accept a witnessless type-0 `StakeRegistration` for a SCRIPT credential? | **YES** |
| **Q4** — is a withdraw-0 accepted against a credential registered that way? | **YES** |
| **Q1** — is there a route to a pre-built certificate in Evolution 0.5.2? | a route exists, and it is a dead end |
| **Q2** — upstream change or SDK-side assembler? | assembler now; the upstream patch has an API break in it |

Q4 is the one that matters. Q3 alone establishes only that the ledger *records* the
registration; the six credentials exist solely to carry a withdraw-0, so if Q4 had
been "no", Q3 would have been a curiosity and the bootstrap would stay at five
transactions. It is not "no".

---

## The question

A CIP-113 bootstrap must register six script stake credentials. Conway's `RegCert`
runs each credential's script under the PUBLISH purpose, so every script body has to
travel in the witness set — measured at 10,721 bytes against a 16,384-byte limit,
which is why registration and reference-script publication are two separate
transactions today.

The legacy Shelley `stake_registration` certificate (type 0) historically required no
witness at all. That permissiveness is exactly why Conway introduced `RegCert` with an
explicit deposit. **Does a Conway ledger still accept a witnessless type-0
registration for a SCRIPT credential?**

## Environment

Local Yaci DevKit devnet, the only chain used. No preview, no preprod, no mainnet.

| | |
|---|---|
| Ogmios | `http://localhost:1337`, era `conway` |
| Protocol version | **10.2** |
| `stakeCredentialDeposit` | 2,000,000 lovelace |
| `maxTransactionSize` | 16,384 bytes |
| `minFeeCoefficient` / `minFeeConstant` | 44 / 155,381 |

Probes: `test/devnet/type0-stake-registration.test.ts` (Q3) and
`test/devnet/type0-withdraw.test.ts` (Q4). Assembler: `test/harness/raw-tx.ts`.

⛔ **Run them serially.** Both drive the same devnet wallet and partition its UTxO set
at `before` time; run concurrently they hand overlapping inputs to two builders and
the loser is refused with 3117, which arrives as a refusal of whichever arm was
unlucky and reads like that arm's verdict. Measured: `npx tsx --test <both files>`
fails the subject arm, and the same two files with `--test-concurrency=1` pass 9/9.
`npm run test:devnet` already passes that flag.

---

## Q3 — the verdict

### **YES.** The Conway ledger accepts a type-0 `StakeRegistration` for a script credential with no witness.

**SUBJECT.** 268-byte transaction. One key-locked input, one change output, fee
169,173, balance including a 2 ADA deposit. Certificate:

```json
{"_tag":"StakeRegistration","stakeCredential":{"_tag":"ScriptHash","hash":"31e4e464f73f44530a3c46fccabc233d21e3fc019b88e91250686ead"}}
```

No script in the witness set. No redeemers. No script data hash. No collateral.
Ledger response, verbatim:

```json
{
  "transaction": {
    "id": "86270d6b5f256c296d62f1af758fb05977628eb9cf637e6375f86d5eff5dd281"
  }
}
```

### The control arm — it does NOT accept anything

**NEGATIVE CONTROL.** Identical transaction, identical script credential *kind*, the
same absent witness — differing only in the certificate: Conway `RegCert` (type 7)
instead of `StakeRegistration` (type 0). Verbatim:

```json
{
  "code": 3102,
  "message": "Some script witnesses are missing. Indeed, any script used in a transaction (when spending, minting, etc...) must be provided in full with the transaction. Scripts must therefore be added either to the witness set or provided as a reference input should you use plutus:v2 or higher and a format from Babbage and beyond. The field 'data.missingScripts' contain hash digests of required but missing script.",
  "data": {
    "missingScripts": [
      "6e2397056f679d8209356b2db947686be1542c11255416de8cd2f3e5"
    ]
  }
}
```

The control fails, and it fails *differently* — naming the exact script hash the
ledger wanted and did not get. The two arms differ in the certificate type and in
nothing else, so the acceptance above is attributable to the certificate type.

**ASSEMBLER CONTROL.** Because the subject is assembled outside Evolution's builder,
a third arm submits a hand-assembled transaction with no certificate at all. Accepted
(229 bytes). Without it, a rejection of the subject could not be told apart from a
broken assembler.

### It is not merely tolerated — it takes effect

Two further arms, both enforced by the ledger rather than read out of an index.

**DOUBLE SUBMIT.** Re-registering the same credential:

```json
{
  "code": 3145,
  "message": "Trying to re-register some already known credentials. Stake credentials can only be registered once. This is true for both keys and scripts. The field 'data.knownCredential' points to an already known credential that's being re-registered by this transaction.",
  "data": {
    "from": "script",
    "knownCredential": "31e4e464f73f44530a3c46fccabc233d21e3fc019b88e91250686ead"
  }
}
```

The ledger's own registry naming the credential, and classifying it as `"from":
"script"`. That is the registration confirming itself.

**DEPOSIT ARITHMETIC.** The same certificate, balanced *without* the 2 ADA deposit:

```json
{
  "code": 3123,
  "message": "In and out value not conserved. ...",
  "data": {
    "valueConsumed": { "ada": { "lovelace": 10000000000 } },
    "valueProduced": { "ada": { "lovelace": 10002000000 } }
  }
}
```

Out exceeds in by exactly 2,000,000 — `stakeCredentialDeposit` to the lovelace.
Cardano balances exactly, so the subject transaction being accepted *only* when 2 ADA
is subtracted proves the ledger charged the deposit. **The legacy certificate takes
the deposit from the protocol parameter**, which is what the Conway `RegCert`'s
explicit `coin` field was introduced to make visible.

### The script is not executed at all

The credential used is a randomly-nonced `always_fail`. Its blueprint declares
`always_fail.always_fail.spend` and `always_fail.always_fail.else` — no publish
handler — so a PUBLISH invocation falls to `else` and aborts. The registration
succeeded anyway. The type-0 path therefore does not merely skip the *witness*; it
skips *script execution*, and a credential can be registered for a script that has no
publish handler and would refuse if it had one.

### The shape the bootstrap needs

Six script credentials registered in **one** witnessless transaction:

```
438 bytes, fee 176,653 (min 174,653), deposit 12,000,000 -> ACCEPTED
  tx 4b71c058100922f44fd93413da282fe3679bd6745b75660b77c094e991a1c631
```

**438 bytes, against 10,721 for the witnessed `RegCert` form.** The six-`RegCert`
control, witnessless, is refused at 468 bytes with `3102` naming all six hashes.

### Proof of harness

Each guard was made to go red by mutation before being accepted as green (all five
arms; the controls stayed green in each case, which is what makes the mutation
informative rather than a blanket failure):

| Mutation | Expected red | Observed |
|---|---|---|
| subject emits `RegCert` instead of type-0 | arms 3, 4 | 4 pass / 2 fail |
| negative control emits type-0 instead of `RegCert` | arm 2 | 4 pass / 2 fail |
| deposit arm pays the deposit after all | arm 5 | (same run) |
| assembler control off by 1 lovelace | arm 1 | 5 pass / 1 fail |

Unmutated: `# tests 6 / # pass 6 / # fail 0 / # skipped 0`.

---

## Q4 — the gate: does a withdraw-0 work against such a credential?

### **YES.** A withdraw-0 against a type-0-registered script credential is accepted.

This is the operational question. The six credentials a CIP-113 bootstrap registers
exist only so that `programmable_logic_global`, `transfer`, `third_party`,
`unfracking`, `issuance_logic` and `upgrade_multisig` can each carry a withdraw-0 on
every programmable transaction. A registration that cannot be withdrawn against is
worth nothing.

Probe: `test/devnet/type0-withdraw.test.ts`.

**The instrument.** `example_transfer_logic.issuer_admin_contract` from the
freeze-and-seize blueprint — a real Plutus V3 validator this repo ships, not a
stand-in, and deliberately *not* a native script. It is the only shipped validator
that reaches a SUCCEEDING withdraw with no protocol state: its handler is satisfied
by the admin signature alone (`permitted_cred` = this wallet's payment key hash, plus
an `addSigner`), and its unused-but-hashed `_asset_name` parameter yields unlimited
fresh credentials so no arm can be perturbed by one another arm already registered.
It also has a `publish` handler, which the `RegCert` control arm needs in order to
register at all.

Measured while selecting it: the dummy substandard's `transfer.transfer` withdraw
*refuses* (3010/3012, empty trace list), and the standard validators all require
registry or protocol state. Neither could serve.

All three arms build the **identical** withdrawal transaction. The only thing that
varies is what happened to the credential beforehand.

**NEGATIVE CONTROL — never registered.** Reproduces the failure mode `bootstrap.ts`
documents, verbatim:

```json
{
  "code": 3141,
  "message": "The transaction contains incomplete or invalid rewards withdrawals. When present, rewards withdrawals must consume rewards in full, there cannot be any leftover. The field 'data.incompleteWithdrawals' contains a map of withdrawals and their current rewards balance.",
  "data": {
    "incompleteWithdrawals": {
      "stake_test17z5gdhgge2acmecw88ywsneemrkrh708ztqfgdzkcsxk2sch920y3": { "ada": { "lovelace": 0 } }
    }
  }
}
```

Worth noting for anyone who meets it: the message talks about *leftover rewards* and
reads as a balance problem. It means the credential is not registered. That is why
the probe asserts on the reward account the ledger names, not merely on the code.

**CONTROL — registered by `RegCert` with the script witness**, publish handler
executed, i.e. exactly what `bootstrap.ts` does today:

```
withdraw-0 ACCEPTED  00a43da429179ac43f001f2584d055b62f7fbc39540e0d8eb9b9b4135e2aef03
```

**SUBJECT — registered by a witnessless type-0 `StakeRegistration`:**

```
register type-0  268 bytes, witnessless -> accepted
withdraw-0 ACCEPTED  0aca004046b2c7be029aeb00202b5dc1030ee73e08ed97da367e97ab15cd62b4
```

The control and the subject are accepted alike. The ledger keeps one registration map
and does not record which certificate populated it.

### Proof of harness

| Mutation | Expected red | Observed |
|---|---|---|
| subject registers a *different* credential than it withdraws against | arm 3 | red with 3141 |
| control registers a *different* credential than it withdraws against | arm 2 | red with 3141 (same run) |
| negative control registers its credential after all | arm 1 | red |

Unmutated: `# tests 3 / # pass 3 / # fail 0 / # skipped 0`.

### One confound met and fixed, not reported as the answer

The first run of this file returned ledger code **3117**, "unknown UTxO references as
inputs", on the subject arm — because the builder had been handed one shared UTxO
snapshot for all four of its builds and selected one an earlier arm had already spent.

That is worth recording because of how it fails: a 3117 is a *refusal of the subject
arm's withdrawal*, so the subject assertion fired and reported "THE GATE IS SHUT" —
a false negative on the only question the file exists to settle, caused by coin
selection. Re-reading the wallet between arms does not fix it either, since Kupo
trails the node. Each build now gets a disjoint, pre-selected slice of inputs.

The same class is why the probe blocks on `awaitTxOnChain` between registering and
withdrawing: a submission id means the mempool accepted the transaction, not that the
ledger applied it, and a withdrawal raced against its own registration fails with
3141 — which reads exactly like the answer.

---

## Q1 — is there a route to a pre-built certificate in Evolution 0.5.2?

Verified independently, not inherited. Two findings, and the second contradicts the
brief's premise.

**There is no generic `addCertificate`.** `operations/Operations.d.ts` exports exactly
25 `...Params` interfaces and `TxBuilder` exposes exactly 25 matching chainable
methods; none is generic over `Certificate`. `state.certificates` is written in
**three** files, not two — `operations/Stake.js`, `operations/Governance.js` and
`operations/Pool.js` (the brief missed `Pool.js`) — and each pushes one hardcoded
certificate class. `createRegisterStakeProgram` unconditionally builds
`new Certificate.RegCert({ stakeCredential, coin: keyDeposit })` and fails outright
for a script credential with no redeemer.

**But there IS an injection route, and it works.** `getPrograms()` returns a *copy*
(`() => [...programs]`), so mutating its result is inert — however:

```js
// dist/sdk/builders/internal/factory.js
compose: other => {
  const otherPrograms = other.getPrograms();
  if (otherPrograms.length > 0) programs.push(...otherPrograms);
  return txBuilder;
},
```

`compose` accepts anything with a `getPrograms()` method, and `TxContext` is exported
from the public module path `@evolution-sdk/evolution/sdk/builders/TransactionBuilder`.
So an arbitrary certificate can be written into builder state:

```ts
const injectCert = Effect.gen(function* () {
  const ctx = yield* TxContext;
  yield* Ref.update(ctx, (state) => ({
    ...state, certificates: [...state.certificates, cert],
  }));
});
await client.newTx().compose({ getPrograms: () => [injectCert] } as any).build({ ... });
```

**Verified on chain, not from a reading.** The build succeeds and the certificate
reaches the body:

```json
[{"_tag":"StakeRegistration","stakeCredential":{"_tag":"ScriptHash","hash":"19a175c021f3eb05cd63e3f515f3f50b7df8e35b3af51d4da6e8bc7b"}}]
```

**And the ledger refuses it**, for a second and entirely independent reason:

```json
{
  "code": 3123,
  "message": "In and out value not conserved. ...",
  "data": {
    "valueConsumed": { "ada": { "lovelace": 14277496 } },
    "valueProduced": { "ada": { "lovelace": 16277496 } }
  }
}
```

Off by exactly 2,000,000 — one deposit. The cause is in
`dist/sdk/builders/phases/Balance.js`:

```js
// Delegation certificates with no deposit/refund
case "StakeRegistration":
case "StakeDeregistration":
...
  // No deposit or refund
  break;
```

**Evolution classifies `StakeRegistration` as charging no deposit. Against the Conway
ledger that is wrong**, as the 3123 above measures directly — and
`StakeDeregistration` is symmetrically wrong about the refund. So the injection route
gets the certificate into the body but cannot balance it, and no compensation is
available from inside the builder: the shortfall is always exactly `n × keyDeposit`
regardless of how inputs, outputs or leftover-folding are arranged, because the
builder's model of the transaction simply does not contain the deposit.

**Conclusion for Q1: a route exists, it is a duck-typed `compose` hole rather than an
API, and it is defeated by a separate defect. It is not usable today.**

## Q2 — upstream change, or an SDK-side assembler?

**The SDK-side assembler is the tractable answer now**, and the reason is the one the
brief identified: with no script witnesses there are no redeemers, therefore no script
data hash, therefore no evaluation, no collateral, and no coin-selection/evaluation
fixed point. `test/harness/raw-tx.ts` is ~380 lines including its commentary and it
worked on the first live submission. Fee is `44 × size + 155,381`; balancing is one
subtraction. Signing goes through `client.signTx`, so no key handling is
reimplemented.

Two traps that route has, both now handled and both worth carrying into any SDK
version:

- **Sign the hex, not the object.** Evolution's seed wallet hashes
  `Transaction.extractBodyBytes(fromHex(hex))` for a string argument but re-serialises
  `tx.body` for an object argument. Hand-assembled bodies are exactly where those can
  disagree, and the disagreement surfaces as a missing-signature rejection that blames
  the key. Merging with `addVKeyWitnessesHex` preserves the original body bytes.
- **Pass `context.utxos`.** The signer derives its required-key set by intersecting
  the transaction's inputs with `context.utxos`. With none, the set is empty and it
  returns `TransactionWitnessSet.empty()` — a *successful* call that signs nothing.
  Measured indirectly: the compose experiment's first attempt produced ledger code
  3101, `missingSignatories`. `buildRawTx` now fails loudly on a zero-witness result.

**The upstream change is larger than it looks, and that is the real finding.** Emitting
the certificate is the small half — `createRegisterStakeProgram` already branches on
`isScriptControlled && !params.redeemer`, so returning a `StakeRegistration` on that
branch instead of failing is a few lines. The large half is the deposit: fixing
`calculateCertificateBalance` means `StakeRegistration`/`StakeDeregistration` must
consult the protocol parameter, and that function currently receives only
`(certificates, poolDeposits)` — it has no access to protocol parameters at all. So
the fix is a signature change to an exported function plus updates at both call sites
(`ChangeCreation.js`, `Balance.js`). That is a genuine upstream patch with an API
break in it, not a one-line tweak, and it should be reported upstream on its own
merits: **Evolution 0.5.2 mis-balances any transaction containing a type-0
registration or deregistration, whatever route put it there.**

Recommendation: build on the SDK-side assembler for the bootstrap.

**And report the balance bug upstream regardless of what we decide here.** It is a
correctness defect in Evolution 0.5.2 with nothing to do with CIP-113: any consumer
who gets a `StakeRegistration` or `StakeDeregistration` into a transaction by any
route will have it mis-balanced by exactly one deposit and refused by the ledger with
3123. The type layer models both certificates, so a consumer has every reason to
think they are supported. Measured here twice — once through the `compose` injection
route (valueProduced exceeding valueConsumed by 2,000,000) and once by deliberately
omitting the deposit from a hand-assembled transaction, which produced the identical
gap. Filing it does not depend on this investigation's outcome.

---

## What this does NOT establish

- **The full six-credential protocol end to end.** Q4 was settled with FES
  `issuer_admin` credentials, not with the actual `programmable_logic_global` /
  `transfer` / `third_party` / `unfracking` / `issuance_logic` / `upgrade_multisig`
  set, because those need a bootstrapped protocol to reach a succeeding withdraw. The
  ledger rule exercised is credential-generic and the arms are controlled, so the
  result should carry — but nobody has yet run `bootstrap.ts` with its tx5 switched to
  the type-0 route and watched a real programmable transfer succeed. That is the
  obvious next slice, and it is now a build task rather than an open question.
- **Whether such a credential can later be deregistered**, and by which certificate
  (`StakeDeregistration` type 1, or `UnregCert` type 8 with an explicit refund). Note
  that Evolution mis-balances both of those too, per Q2.
- **Whether the three-into-one merge actually fits.** 438 bytes for six registrations
  is measured; the merged registration-plus-reference-script-publication transaction
  was never built, and reference script outputs are large.
- **Behaviour on preprod or mainnet.** Devnet only, at protocol version 10.2, by
  instruction. The rule exercised lives in `cardano-ledger`'s Conway witness and certs
  rules rather than in devnet configuration, but that is an inference, not a
  measurement.
- **Whether a future hard fork keeps this.** A deliberately-retained legacy path is a
  reasonable candidate for removal. The probe is written as a regression guard so the
  removal would surface as a red test rather than as a broken bootstrap.

## An instrument that was pointed at nothing

The obvious way to check whether a credential is registered is
`queryLedgerState/rewardAccountSummaries`. **It does not work for this, and the next
person will reach for it.**

Asked about a freshly-registered script credential it answered `{}`. That reads as
"not registered" and would have contradicted the registration finding. Before
believing it, it was pointed at a control: the devnet's OWN stake-pool reward account,
taken from `queryLedgerState/stakePools` and therefore necessarily registered. It
answered `{}` for that too.

So the empty result is a fact about the query, not about the ledger — it cannot
distinguish "absent" from "not visible to this query", and any verdict resting on it
would have been backwards. The probes log it and never assert on it.

What replaced it is evidence the ledger is forced to produce, by refusing transactions
it would otherwise accept: the **3145** on a double registration (which also names the
credential as `"from": "script"`), the **3123** whose gap is exactly the deposit, and
the **3141** on an unregistered withdrawal. A rule the ledger enforces is a better
instrument than a query the ledger merely offers.

## Files

| Path | What |
|---|---|
| `test/harness/raw-tx.ts` | Assembler, Ogmios transport, certificate constructors the builder cannot emit. Investigation scaffolding — deliberately not exported from `src/`. |
| `test/devnet/type0-stake-registration.test.ts` | Q3: the six-arm registration probe. |
| `test/devnet/type0-withdraw.test.ts` | Q4: the three-arm withdraw-0 probe. |
