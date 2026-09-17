/**
 * Does the Conway ledger accept a legacy type-0 `StakeRegistration` for a
 * SCRIPT credential with NO witness?
 *
 * WHY IT MATTERS. A CIP-113 bootstrap has to register six script stake
 * credentials. Conway's `RegCert` runs each credential's script under the
 * PUBLISH purpose, so every script body must travel in the witness set —
 * measured at 10,721 bytes against a 16,384-byte limit, which is why
 * registration and reference-script publication are two transactions today.
 * The Shelley `stake_registration` certificate (type 0) historically required
 * no witness at all; that permissiveness is exactly why Conway introduced
 * `RegCert` with an explicit deposit. Whether the old certificate was
 * retroactively restricted when the new one was added is the kind of question
 * that is answered one way in a specification and another way in an
 * implementation, so it is answered here by submission.
 *
 * ⛔ WHAT MAKES A VERDICT HERE MEAN ANYTHING. Three arms, not one:
 *
 *   ASSEMBLER CONTROL   a hand-assembled transaction with NO certificate. Must
 *                       be accepted. Without it, a rejection of the subject
 *                       cannot be told apart from "the assembler is broken" —
 *                       the transaction is built outside Evolution's builder,
 *                       so its fee, balance, signing and CBOR are all suspect
 *                       until something proves otherwise.
 *
 *   SUBJECT             type-0 `StakeRegistration`, script credential, no
 *                       script witness.
 *
 *   NEGATIVE CONTROL    `RegCert` for a script credential, ALSO with no script
 *                       witness. Must be REFUSED. Without it, acceptance of the
 *                       subject cannot be told apart from "this devnet accepts
 *                       anything". A control that fails the same way as the
 *                       subject would prove nothing, so the assertion is on the
 *                       ledger's specific refusal code and on the script hash
 *                       it names.
 *
 * And because "accepted" is not the same as "took effect", two further arms
 * establish that the credential is genuinely registered, both of them enforced
 * by the ledger rather than read out of an index:
 *
 *   DOUBLE SUBMIT       re-registering the SAME credential must be refused as
 *                       already known. The ledger answering 3145 and naming the
 *                       credential as `"from": "script"` is the registry itself
 *                       confirming the entry.
 *
 *   DEPOSIT ARITHMETIC  the same certificate, balanced WITHOUT the 2 ADA
 *                       deposit, must be refused for value conservation. Cardano
 *                       balances exactly, so a transaction that is accepted only
 *                       when 2 ADA is subtracted proves the ledger charged the
 *                       deposit — i.e. the certificate did something.
 *
 * ⚠ Every arm uses a FRESH script hash from a randomly-nonced `always_fail`, so
 * no arm can be perturbed by a credential a previous run registered. Sharing a
 * hash between the subject and the negative control would turn the control's
 * expected 3102 into a 3145 and quietly destroy the discrimination.
 *
 * ⚠ `always_fail` HAS NO PUBLISH HANDLER, and that is deliberate. Its blueprint
 * declares `always_fail.always_fail.spend` and `always_fail.always_fail.else`
 * and nothing more, so the PUBLISH purpose a registration runs under falls to
 * the `else` arm and aborts. A type-0 registration that succeeds against a
 * script which would ABORT if it ran is evidence that the script is not merely
 * unwitnessed but never executed at all.
 *
 * ⛔ RUN SERIALLY. These probes drive ONE devnet wallet and each partitions its
 * UTxO set at `before` time. Two probe files running CONCURRENTLY snapshot the same
 * wallet and hand overlapping inputs to two builders, and the loser is refused with
 * ledger code 3117 ("unknown UTxO references as inputs") — which arrives as a
 * REFUSAL of whichever arm was unlucky and reads exactly like that arm's verdict.
 * MEASURED: `npx tsx --test <both probe files>` fails the subject arm; the same two
 * files with `--test-concurrency=1` pass 9/9. `npm run test:devnet` already passes
 * that flag, so the suite is safe; an ad-hoc invocation is not.
 *
 * There is no skip path: see test/harness/yaci.mjs.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { requireDevnet, makeClient, topupAddress, settleWallet, OGMIOS_URL } from "../harness/yaci.mjs";
import {
  adaOnly,
  bech32,
  buildRawTx,
  ogmiosParams,
  regCertType7,
  rewardAccountSummary,
  scriptCredential,
  stakeRegistrationType0,
  submitToOgmios,
  type RawTxParams,
  type SpendableUtxo,
} from "../harness/raw-tx.js";
import { createStandardScripts } from "../../dist/standard/scripts.js";
import { loadStandardBlueprint } from "../harness/bootstrap.js";

/** Ledger failure codes this file asserts on, by the name Ogmios gives them. */
const LEDGER = {
  MISSING_SCRIPT_WITNESSES: 3102,
  VALUE_NOT_CONSERVED: 3123,
  ALREADY_REGISTERED: 3145,
} as const;

/** Enough to cover six deposits plus a fee with room to spare. */
const MIN_INPUT_LOVELACE = 20_000_000n;

interface Fixture {
  client: any;
  addr: any;
  utxos: ReadonlyArray<any>;
  params: RawTxParams;
  freshScriptHash: () => string;
  /** Hands out a distinct wallet UTxO per arm so no two arms double-spend. */
  nextInput: () => SpendableUtxo[];
}

let fx: Fixture;

/** The credential the subject arm registers; reused by the double-submit arm. */
let subjectHash = "";

before(async () => {
  await requireDevnet();

  const params = await ogmiosParams(OGMIOS_URL);
  const client = await makeClient();
  const addr = await client.address();

  let utxos = await client.getUtxos(addr);
  let big = adaOnly(utxos).filter((u) => u.lovelace >= MIN_INPUT_LOVELACE);
  if (big.length < 8) {
    await topupAddress(bech32(addr), 10_000);
    await settleWallet(client, addr);
    utxos = await client.getUtxos(addr);
    big = adaOnly(utxos).filter((u) => u.lovelace >= MIN_INPUT_LOVELACE);
  }
  assert.ok(
    big.length >= 8,
    `need at least 8 wallet UTxOs of >= ${MIN_INPUT_LOVELACE} lovelace, found ${big.length}`,
  );

  const builders = createStandardScripts(loadStandardBlueprint());
  let cursor = 0;

  fx = {
    client,
    addr,
    utxos,
    params,
    freshScriptHash: () => builders.alwaysFail(randomBytes(32).toString("hex")).hash,
    nextInput: () => [big[cursor++]!],
  };

  // Pin the era in the run's own output. A verdict about "the Conway ledger"
  // that never recorded which ledger answered is a verdict about nothing.
  console.error(
    `  [ledger] protocol version ${params.protocolVersion}, ` +
      `stakeCredentialDeposit ${params.stakeCredentialDeposit}, ` +
      `maxTxSize ${params.maxTransactionSize}`,
  );
});

/** Assemble, sign and submit one arm; report what the ledger said, verbatim. */
async function submitArm(
  label: string,
  certificates: ReadonlyArray<any>,
  deposit: bigint,
) {
  const built = await buildRawTx({
    client: fx.client,
    walletUtxos: fx.utxos,
    inputs: fx.nextInput(),
    changeAddress: fx.addr,
    certificates,
    certificateDeposit: deposit,
    params: fx.params,
  });
  const verdict = await submitToOgmios(OGMIOS_URL, built.cborHex);
  console.error(
    `  [${label}] ${built.txSizeBytes} bytes, fee ${built.fee} (min ${built.minRequiredFee}), ` +
      `deposit ${deposit} -> ${verdict.accepted ? `ACCEPTED ${verdict.txId}` : "REFUSED"}`,
  );
  if (!verdict.accepted) console.error(`  [${label}] ${verdict.raw.replace(/\n/g, "\n  ")}`);
  return { built, verdict };
}

const codeOf = (verdict: { error?: unknown }) => (verdict.error as any)?.code;

// ---------------------------------------------------------------------------
// Arm 1 — the assembler control
// ---------------------------------------------------------------------------

test("assembler control: a hand-assembled script-free transaction is accepted", async () => {
  const built = await buildRawTx({
    client: fx.client,
    walletUtxos: fx.utxos,
    inputs: fx.nextInput(),
    changeAddress: fx.addr,
    params: fx.params,
  });
  const verdict = await submitToOgmios(OGMIOS_URL, built.cborHex);
  console.error(`  [assembler control] ${built.txSizeBytes} bytes -> ${verdict.accepted}`);

  assert.equal(
    verdict.accepted,
    true,
    "the hand-assembled transaction carrying NO certificate was refused, so every " +
      "certificate arm below is uninterpretable — the fee, balance, signing or CBOR " +
      `is wrong, not the certificate type. Ledger said: ${verdict.raw}`,
  );
});

// ---------------------------------------------------------------------------
// Arm 2 — the negative control
// ---------------------------------------------------------------------------

test("negative control: RegCert for a script credential with no witness is REFUSED", async () => {
  const hash = fx.freshScriptHash();
  const { verdict } = await submitArm(
    "control RegCert",
    [regCertType7(scriptCredential(hash), fx.params.stakeCredentialDeposit)],
    fx.params.stakeCredentialDeposit,
  );

  assert.equal(
    verdict.accepted,
    false,
    "a Conway RegCert for a SCRIPT credential was accepted with no script witness. " +
      "That would mean this devnet does not enforce the script-witness rule at all, " +
      "and the subject arm's acceptance would prove nothing about the certificate type.",
  );
  assert.equal(
    codeOf(verdict),
    LEDGER.MISSING_SCRIPT_WITNESSES,
    `expected ${LEDGER.MISSING_SCRIPT_WITNESSES} (missing script witnesses); got ${verdict.raw}`,
  );
  // Assert on the hash the ledger NAMED, not merely on the code. The code alone
  // would also fire for a script missing for some unrelated reason.
  assert.deepEqual(
    (verdict.error as any)?.data?.missingScripts,
    [hash],
    "the refusal must name this arm's own script credential as the missing script",
  );
});

// ---------------------------------------------------------------------------
// Arm 3 — the subject
// ---------------------------------------------------------------------------

test("SUBJECT: type-0 StakeRegistration for a script credential with NO witness", async () => {
  subjectHash = fx.freshScriptHash();
  const { verdict } = await submitArm(
    "subject type-0",
    [stakeRegistrationType0(scriptCredential(subjectHash))],
    fx.params.stakeCredentialDeposit,
  );

  assert.equal(
    verdict.accepted,
    true,
    "the Conway ledger REFUSED a type-0 StakeRegistration for a script credential. " +
      "If this has gone red, the one-transaction bootstrap rests on a behaviour the " +
      `ledger no longer has. Ledger said: ${verdict.raw}`,
  );
  assert.ok(verdict.txId, "an accepted submission must return a transaction id");
});

// ---------------------------------------------------------------------------
// Arm 4 — effectiveness, by the ledger's own registry
// ---------------------------------------------------------------------------

test("the registration took effect: re-registering the same credential is REFUSED", async () => {
  assert.ok(subjectHash, "subject arm must have run first");

  const { verdict } = await submitArm(
    "double submit",
    [stakeRegistrationType0(scriptCredential(subjectHash))],
    fx.params.stakeCredentialDeposit,
  );

  assert.equal(
    verdict.accepted,
    false,
    "the same credential registered twice. Acceptance without registration would mean " +
      "the certificate was a no-op the ledger tolerated rather than an entry it recorded.",
  );
  assert.equal(
    codeOf(verdict),
    LEDGER.ALREADY_REGISTERED,
    `expected ${LEDGER.ALREADY_REGISTERED} (already registered); got ${verdict.raw}`,
  );
  const data = (verdict.error as any)?.data;
  assert.equal(data?.knownCredential, subjectHash, "the ledger must name the subject's credential");
  // The ledger classifying it as a SCRIPT closes the last gap: it did not
  // silently record a key credential.
  assert.equal(data?.from, "script", "the recorded credential must be a SCRIPT credential");
});

// ---------------------------------------------------------------------------
// Arm 5 — effectiveness, by arithmetic
// ---------------------------------------------------------------------------

test("the deposit is charged: the same certificate balanced WITHOUT it is REFUSED", async () => {
  const hash = fx.freshScriptHash();
  const { verdict } = await submitArm(
    "no-deposit balance",
    [stakeRegistrationType0(scriptCredential(hash))],
    0n, // deliberately omit the deposit from the balance
  );

  assert.equal(
    verdict.accepted,
    false,
    "a type-0 registration balanced with no deposit was accepted, which would mean the " +
      "ledger charges nothing for it — and the subject arm's 2 ADA went somewhere " +
      "unexplained.",
  );
  assert.equal(
    codeOf(verdict),
    LEDGER.VALUE_NOT_CONSERVED,
    `expected ${LEDGER.VALUE_NOT_CONSERVED} (value not conserved); got ${verdict.raw}`,
  );
  // The size of the gap is the measurement: it must be the deposit exactly.
  const data = (verdict.error as any)?.data;
  const produced = BigInt(data?.valueProduced?.ada?.lovelace ?? 0);
  const consumed = BigInt(data?.valueConsumed?.ada?.lovelace ?? 0);
  assert.equal(
    produced - consumed,
    fx.params.stakeCredentialDeposit,
    "the out/in gap must equal stakeCredentialDeposit exactly — that difference IS the " +
      "deposit the ledger takes for a type-0 registration",
  );
});

// ---------------------------------------------------------------------------
// Arm 6 — the shape the bootstrap actually needs
// ---------------------------------------------------------------------------

test("six script credentials register in ONE witnessless transaction", async () => {
  const hashes = Array.from({ length: 6 }, () => fx.freshScriptHash());
  const { built, verdict } = await submitArm(
    "six type-0",
    hashes.map((h) => stakeRegistrationType0(scriptCredential(h))),
    fx.params.stakeCredentialDeposit * 6n,
  );

  assert.equal(verdict.accepted, true, `six-certificate registration refused: ${verdict.raw}`);

  // The whole point is the size. Six witnessed RegCerts measured 10,721 bytes;
  // an assertion that merely says "accepted" would stay green if the transaction
  // quietly grew back to the size that forced the split in the first place.
  assert.ok(
    built.txSizeBytes < 1_000,
    `expected the witnessless form to be far under the 16,384-byte limit, got ${built.txSizeBytes}`,
  );

  console.error(
    `  [six type-0] ${built.txSizeBytes} bytes for six registrations ` +
      `(the witnessed RegCert form measures 10,721)`,
  );

  // Reported, never asserted on. Measured on this devnet: this query answered
  // {} for the devnet's own stake-pool reward account, which is necessarily
  // registered — so it cannot distinguish "absent" from "this query does not
  // see it", and a verdict must not rest on it. The ledger's own 3145 refusal
  // in arm 4 is the registration evidence.
  console.error(
    `  [reward query, NOT load-bearing] ` +
      JSON.stringify(await rewardAccountSummary(OGMIOS_URL, hashes[0]!)),
  );
});
