# DRAFT upstream issue for `@evolution-sdk/evolution` — NOT SUBMITTED

⛔ **Giovanni's to send. Drafted here, not filed.** Two independent defects in the legacy
stake-registration path, both measured on chain rather than read from source.

Verified against **0.5.13** (latest at 2026-09-17). Ledger evidence from a local Yaci devnet,
**Conway, protocol version 10.2**, `stakeCredentialDeposit = 2,000,000` lovelace.

---

## Defect 1 — `registerStakeLegacy` refuses script credentials, which is the only case it is for

`dist/sdk/builders/operations/Stake.js:85-88` (and `deregisterStakeLegacy`, `:510-513`):

```js
const isScriptControlled = params.stakeCredential._tag === "ScriptHash";
if (isScriptControlled && !params.redeemer) {
  return yield* Effect.fail(new TransactionBuilderError({
    message: "Redeemer required for script-controlled stake credential registration"
  }));
}
```

**This guard is correct for `RegCert` and is a category error for `StakeRegistration`.** `RegCert`
runs the credential's script under the **PUBLISH** purpose, so it genuinely needs a redeemer and the
script body. The legacy type-0 `StakeRegistration` invokes **no script at all** — that is its entire
distinguishing property, and it is why Conway introduced `RegCert` with an explicit deposit to close
the permissive behaviour for *new* certificates.

⇒ **Demanding a redeemer for a certificate that never invokes a script asks the caller for something
the ledger will not consume.** The guard closes the legacy path to exactly the credentials it exists
to serve.

**MEASURED ON CHAIN — the ledger accepts what the builder refuses to construct:**

| arm | certificate | witness | result |
|---|---|---|---|
| subject | type-0 `StakeRegistration`, **script** credential | **none** | **ACCEPTED** — 268 bytes, tx `86270d6b5f256c296d62f1af758fb05977628eb9cf637e6375f86d5eff5dd281` |
| control | `RegCert` (type 7), same credential | none | **REJECTED 3102** *"Some script witnesses are missing"*, `missingScripts: ["6e2397056f679d8209356b2db947686be1542c11255416de8cd2f3e5"]` |
| control | no certificate at all | none | ACCEPTED — so a rejection could not be a malformed assembler |

The registration **takes effect**: re-registering the same credential is refused **3145** with
`"from": "script"`, and a subsequent **withdraw-0 against that credential is ACCEPTED**
(`0aca004046b2c7be029aeb00202b5dc1030ee73e08ed97da367e97ab15cd62b4`), identically to the same
credential registered via `RegCert` (`00a43da429179ac43f001f2584d055b62f7fbc39540e0d8eb9b9b4135e2aef03`),
while the same withdrawal against a never-registered credential is refused **3141**.

**Suggested fix:** drop the `isScriptControlled && !params.redeemer` guard from the two *legacy*
programs only. Leave it on `registerStake`/`deregisterStake`, where it is right.

---

## Defect 2 — the legacy certificate is balanced as though it carries no deposit. It does.

`dist/sdk/builders/phases/Balance.js:66-75`:

```js
case "StakeRegistration":
case "StakeDeregistration":
  // No deposit or refund
  break;
```

and `dist/sdk/builders/operations/Stake.js:127` logs
`"[RegisterStakeLegacy] Added StakeRegistration certificate (no deposit)"`.

**The ledger disagrees.** Type-0 takes the deposit **implicitly from protocol parameters** rather
than stating it in the certificate; `RegCert` states it explicitly. Same deposit, different encoding.

**MEASURED:** a transaction balanced on Evolution's assumption — no deposit for the type-0
certificate — is refused with **3123**, outputs exceeding inputs by **exactly 2,000,000 lovelace**,
which is precisely `stakeCredentialDeposit`. Adding the deposit by hand makes the identical
transaction succeed.

⚠ **This bites by every route, not only `registerStakeLegacy`.** `compose()` accepts any duck-typed
`{ getPrograms() }`, so a caller can inject a `StakeRegistration` certificate directly — and that
transaction is mis-balanced too, because the defect is in the balance phase rather than in the
operation. A caller cannot compensate from inside the builder.

**Suggested fix:** treat `StakeRegistration` as depositing `keyDeposit` and `StakeDeregistration` as
refunding it, reading protocol parameters as `RegCert` already does. Note
`calculateCertificateBalance` currently receives only `(certificates, poolDeposits)` and has no
access to protocol parameters, so this is an exported-signature change plus both call sites — larger
than it looks, which is worth saying in the report.

---

## Severity note for whoever triages

Defect 2 is the more serious of the two: **defect 1 makes a feature unreachable, defect 2 makes it
produce a transaction the ledger refuses.** A user who works around defect 1 — by `compose`, or by
assembling the body outside the builder — still hits defect 2 and will reasonably suspect their own
arithmetic before suspecting the library, because the library says "no deposit" in both a comment and
a log line.
