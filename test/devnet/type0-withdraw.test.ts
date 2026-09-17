/**
 * Is a withdraw-0 accepted against a script credential that was registered by a
 * type-0 `StakeRegistration` rather than by a Conway `RegCert`?
 *
 * ⛔ THIS IS THE GATE, NOT A FOLLOW-UP. `type0-stake-registration.test.ts`
 * establishes that the ledger accepts and records a witnessless type-0
 * registration for a script credential. That result is worth nothing on its own:
 * the six credentials a CIP-113 bootstrap registers exist ONLY so that
 * `programmable_logic_global`, `transfer`, `third_party`, `unfracking`,
 * `issuance_logic` and `upgrade_multisig` can each carry a withdraw-0 on every
 * programmable transaction. If a credential registered the cheap way cannot then
 * be withdrawn against, the registration finding collapses and the bootstrap
 * stays at five transactions.
 *
 * THE INSTRUMENT. `example_transfer_logic.issuer_admin_contract` from the
 * freeze-and-seize blueprint — a REAL Plutus V3 validator this repo ships, not a
 * stand-in. It was chosen because it is the only shipped validator that reaches
 * a SUCCEEDING withdraw with no protocol state at all:
 *
 *   - its withdraw handler is satisfied by the admin signature alone, so
 *     `permitted_cred` set to this wallet's payment key hash plus an
 *     `addSigner` is the entire precondition;
 *   - its second parameter `_asset_name` is unused by the logic but part of the
 *     hash, so a random value per arm yields UNLIMITED fresh credentials — no
 *     arm can be perturbed by a credential another arm or an earlier run
 *     already registered;
 *   - it has a `publish` handler, which the `RegCert` control arm needs in order
 *     to register at all.
 *
 * Measured while selecting it: the dummy substandard's `transfer.transfer`
 * withdraw REFUSES (ogmios 3010/3012, empty trace list) and the standard
 * validators all require registry or protocol state, so neither could serve.
 *
 * ⛔ THE THREE ARMS, AND WHY EACH EXISTS.
 *
 *   NEGATIVE CONTROL  withdraw-0 against a credential NEVER registered. Must be
 *                     refused with 3141. Without it, an acceptance in the
 *                     subject arm could just mean the ledger does not check
 *                     registration for withdrawals at all.
 *
 *   CONTROL           the same withdraw-0 against a credential registered the
 *                     ORTHODOX way — `RegCert` with the script witness attached,
 *                     publish handler executed. Must be accepted. If the subject
 *                     arm succeeds and this one fails, the fault is in this rig,
 *                     not in the ledger.
 *
 *   SUBJECT           the same withdraw-0 against a credential registered by a
 *                     witnessless type-0 `StakeRegistration`.
 *
 * The three arms differ ONLY in how the credential was registered. The
 * withdrawal transaction itself is built by the same function in all three.
 *
 * ⚠ REGISTRATION MUST BE ON CHAIN BEFORE THE WITHDRAWAL IS BUILT. A submission
 * id means the mempool accepted it, not that the ledger applied it; a withdrawal
 * raced against its own registration fails with 3141 and reads exactly like the
 * answer this file exists to find. `awaitTxOnChain` blocks on the LEDGER's own
 * UTxO set, not on Kupo, which trails it.
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
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  Bytes as EvoBytes,
  Credential as EvoCredential,
  KeyHash as EvoKeyHash,
  Transaction as EvoTransaction,
  TransactionWitnessSet as EvoWitnessSet,
} from "@evolution-sdk/evolution";

import { requireDevnet, makeClient, topupAddress, settleWallet, OGMIOS_URL } from "../harness/yaci.mjs";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";
import {
  adaOnly,
  awaitTxOnChain,
  bech32,
  buildRawTx,
  ogmiosParams,
  scriptCredential,
  stakeRegistrationType0,
  submitToOgmios,
  type RawTxParams,
  type SpendableUtxo,
  type SubmitVerdict,
} from "../harness/raw-tx.js";
import { fesBlueprintPath } from "../harness/paths.js";
import { createFESScripts } from "../../dist/substandards/freeze-and-seize/scripts.js";
import { buildEvoScript, paymentCredentialHash, rewardAddress, voidData } from "../../dist/index.js";

/** Ledger failure codes this file asserts on, by the name Ogmios gives them. */
const LEDGER = {
  /** "rewards withdrawals must consume rewards in full" — the unregistered case. */
  INCOMPLETE_WITHDRAWALS: 3141,
} as const;

const MIN_INPUT_LOVELACE = 20_000_000n;

interface Fixture {
  client: any;
  addr: any;
  networkId: number;
  pkh: string;
  params: RawTxParams;
  evaluator: any;
  /** A fresh issuer_admin credential, unique per call. */
  freshAdmin: () => { hash: string; compiledCode: string };
  /** A distinct wallet UTxO per raw-assembled transaction. */
  nextRawInput: () => SpendableUtxo[];
  /** A distinct slice of wallet UTxOs per BUILDER build. */
  nextBuilderUtxos: () => ReadonlyArray<any>;
  walletUtxos: ReadonlyArray<any>;
}

let fx: Fixture;

before(async () => {
  await requireDevnet();

  const params = await ogmiosParams(OGMIOS_URL);
  const client = await makeClient();
  const addr = await client.address();
  const bech = bech32(addr);

  let utxos = await client.getUtxos(addr);
  let big = adaOnly(utxos).filter((u) => u.lovelace >= MIN_INPUT_LOVELACE);
  if (big.length < 20) {
    await topupAddress(bech, 10_000);
    await settleWallet(client, addr);
    utxos = await client.getUtxos(addr);
    big = adaOnly(utxos).filter((u) => u.lovelace >= MIN_INPUT_LOVELACE);
  }
  assert.ok(big.length >= 20, `need >= 20 fat wallet UTxOs, found ${big.length}`);

  // ⛔ EVERY BUILD GETS ITS OWN UTxOs, AND THAT IS NOT TIDINESS.
  //
  // MEASURED, first run of this file: handing the builder ONE shared snapshot
  // for all four of its builds produced ledger code 3117, "unknown UTxO
  // references as inputs", on the SUBJECT arm — because an earlier arm's
  // accepted transaction had already spent the UTxO the builder then selected.
  // Re-reading the wallet between arms does not fix it either: Kupo trails the
  // node, so the refreshed view still offers spent UTxOs (this is the hazard
  // `settleWallet` exists for).
  //
  // ⚠ AND A 3117 IS INDISTINGUISHABLE FROM THE ANSWER unless you look: it is a
  // REFUSAL of the subject arm's withdrawal, so the subject assertion fires and
  // reports "THE GATE IS SHUT" — a false negative on the one question this file
  // exists to settle. Disjoint, pre-selected inputs remove the whole class.
  //
  // Three per build: one to spend, one for the builder's collateral selection,
  // one of slack so coin selection is never the thing that fails.
  const rawPool = big.slice(0, 4);
  const builderPool = big.slice(4);
  const byOutRef = new Map(utxos.map((u: any) => [`${txIdHex(u)}#${Number(u.index)}`, u]));
  const builderUtxoObjs = builderPool.map((u) => {
    const found = byOutRef.get(`${u.txHash}#${u.index}`);
    assert.ok(found, `wallet UTxO ${u.txHash}#${u.index} vanished between views`);
    return found;
  });
  const BUILDER_UTXOS_PER_BUILD = 3;
  let builderCursor = 0;

  const fes = createFESScripts(JSON.parse(readFileSync(fesBlueprintPath(), "utf-8")));
  const pkh = paymentCredentialHash(bech);
  let cursor = 0;

  fx = {
    client,
    addr,
    networkId: 0,
    pkh,
    params,
    evaluator: createOgmiosEvaluator(OGMIOS_URL),
    freshAdmin: () => fes.buildIssuerAdmin(pkh, randomBytes(28).toString("hex")),
    nextRawInput: () => [rawPool[cursor++]!],
    nextBuilderUtxos: () => {
      const slice = builderUtxoObjs.slice(builderCursor, builderCursor + BUILDER_UTXOS_PER_BUILD);
      builderCursor += BUILDER_UTXOS_PER_BUILD;
      assert.equal(
        slice.length,
        BUILDER_UTXOS_PER_BUILD,
        "ran out of pre-partitioned wallet UTxOs; raise the pool rather than reusing any, " +
          "because reuse returns as ledger code 3117 disguised as the subject's verdict",
      );
      return slice;
    },
    walletUtxos: utxos,
  };

  console.error(
    `  [ledger] protocol version ${params.protocolVersion}, ` +
      `stakeCredentialDeposit ${params.stakeCredentialDeposit}`,
  );
});

/** Hex transaction id of an Evolution UTxO. */
function txIdHex(u: any): string {
  const id = u.transactionId?.hash ?? u.transactionId;
  return id instanceof Uint8Array
    ? Array.from(id, (b: number) => b.toString(16).padStart(2, "0")).join("")
    : String(id);
}

// ---------------------------------------------------------------------------
// The two registration routes
// ---------------------------------------------------------------------------

/** Register a script credential with a witnessless type-0 StakeRegistration. */
async function registerType0(hash: string): Promise<SubmitVerdict> {
  const built = await buildRawTx({
    client: fx.client,
    walletUtxos: fx.walletUtxos,
    inputs: fx.nextRawInput(),
    changeAddress: fx.addr,
    certificates: [stakeRegistrationType0(scriptCredential(hash))],
    certificateDeposit: fx.params.stakeCredentialDeposit,
    params: fx.params,
  });
  const verdict = await submitToOgmios(OGMIOS_URL, built.cborHex);
  console.error(`  [register type-0] ${built.txSizeBytes} bytes -> ${verdict.accepted}`);
  return verdict;
}

/**
 * Register a script credential the orthodox way: Conway `RegCert` with the
 * script attached, so the ledger runs its PUBLISH handler. This is what
 * `bootstrap.ts` does today, and what the whole investigation is trying to
 * avoid paying for.
 */
async function registerRegCert(script: { hash: string; compiledCode: string }): Promise<SubmitVerdict> {
  const built = await fx.client
    .newTx()
    .registerStake({
      stakeCredential: EvoCredential.makeScriptHash(EvoBytes.fromHex(script.hash)),
      redeemer: voidData(),
    })
    .attachScript({ script: buildEvoScript(script.compiledCode) })
    .build({
      changeAddress: fx.addr,
      evaluator: fx.evaluator,
      availableUtxos: fx.nextBuilderUtxos(),
    });
  const verdict = await submitBuilt(built);
  console.error(`  [register RegCert] -> ${verdict.accepted}`);
  return verdict;
}

// ---------------------------------------------------------------------------
// The withdrawal, identical in all three arms
// ---------------------------------------------------------------------------

/**
 * A withdraw-0 against a script credential, with the script witness attached as
 * a normal withdrawal requires. Identical in all three arms — the ONLY thing
 * that varies between them is what happened to the credential beforehand.
 */
async function withdrawZero(script: { hash: string; compiledCode: string }): Promise<SubmitVerdict> {
  const built = await fx.client
    .newTx()
    .withdraw({
      stakeCredential: EvoCredential.makeScriptHash(EvoBytes.fromHex(script.hash)),
      amount: 0n,
      redeemer: voidData(),
    })
    .attachScript({ script: buildEvoScript(script.compiledCode) })
    // issuer_admin's withdraw handler checks the admin is an extra signatory.
    // Spending from the admin's own address is NOT enough — Aiken reads
    // `extra_signatories`, which is the requiredSigners field.
    .addSigner({ keyHash: EvoKeyHash.fromHex(fx.pkh) })
    .build({
      changeAddress: fx.addr,
      evaluator: fx.evaluator,
      availableUtxos: fx.nextBuilderUtxos(),
    });
  return submitBuilt(built);
}

/**
 * Sign a built transaction and submit it straight to Ogmios.
 *
 * Direct rather than through the builder's own `submit()`, for the reason the
 * whole investigation runs this way: Evolution's provider replaces the ledger's
 * reason with "Kupmios submitTx failed" and buries the cause, and a question
 * about what the ledger does must be answered in the ledger's words.
 */
async function submitBuilt(built: any): Promise<SubmitVerdict> {
  const signed = await built.sign();
  const unsigned = await built.toTransaction();
  const hex = EvoTransaction.addVKeyWitnessesHex(
    EvoTransaction.toCBORHex(unsigned),
    EvoWitnessSet.toCBORHex(signed.witnessSet),
  );
  return submitToOgmios(OGMIOS_URL, hex);
}

const codeOf = (v: SubmitVerdict) => (v.error as any)?.code;

const report = (label: string, v: SubmitVerdict) => {
  console.error(`  [${label}] ${v.accepted ? `ACCEPTED ${v.txId}` : "REFUSED"}`);
  if (!v.accepted) console.error(`  [${label}] ${v.raw.replace(/\n/g, "\n  ")}`);
};

// ---------------------------------------------------------------------------
// Arm 1 — negative control: never registered
// ---------------------------------------------------------------------------

test("negative control: withdraw-0 against an UNREGISTERED credential is REFUSED (3141)", async () => {
  const admin = fx.freshAdmin();
  const verdict = await withdrawZero(admin);
  report("unregistered", verdict);

  assert.equal(
    verdict.accepted,
    false,
    "a withdraw-0 against a credential that was never registered was ACCEPTED. That would " +
      "mean the ledger does not gate withdrawals on registration at all, and the subject " +
      "arm's acceptance would say nothing about the type-0 route.",
  );
  assert.equal(
    codeOf(verdict),
    LEDGER.INCOMPLETE_WITHDRAWALS,
    `expected ${LEDGER.INCOMPLETE_WITHDRAWALS}; got ${verdict.raw}`,
  );
  // Assert on the account the ledger NAMED. bootstrap.ts records this exact
  // failure mode as reading like a balance problem when it is really an
  // unregistered credential; pinning the account is what tells the two apart.
  const named = Object.keys((verdict.error as any)?.data?.incompleteWithdrawals ?? {});
  assert.deepEqual(
    named,
    [rewardAddress(fx.networkId, admin.hash)],
    "the refusal must name this arm's own reward account",
  );
});

// ---------------------------------------------------------------------------
// Arm 2 — control: registered the orthodox way
// ---------------------------------------------------------------------------

test("control: withdraw-0 after a RegCert registration is ACCEPTED", async () => {
  const admin = fx.freshAdmin();

  const reg = await registerRegCert(admin);
  assert.equal(reg.accepted, true, `the orthodox RegCert registration itself failed: ${reg.raw}`);
  await awaitTxOnChain(OGMIOS_URL, reg.txId!);

  const verdict = await withdrawZero(admin);
  report("RegCert-registered", verdict);

  assert.equal(
    verdict.accepted,
    true,
    "a withdraw-0 against a credential registered the ORTHODOX way was refused. The fault " +
      `is in this rig, not in the ledger, and the subject arm below is uninterpretable. ` +
      `Ledger said: ${verdict.raw}`,
  );
});

// ---------------------------------------------------------------------------
// Arm 3 — the subject
// ---------------------------------------------------------------------------

test("SUBJECT: withdraw-0 after a witnessless type-0 registration is ACCEPTED", async () => {
  const admin = fx.freshAdmin();

  const reg = await registerType0(admin.hash);
  assert.equal(reg.accepted, true, `the type-0 registration itself failed: ${reg.raw}`);
  await awaitTxOnChain(OGMIOS_URL, reg.txId!);

  const verdict = await withdrawZero(admin);
  report("type-0-registered", verdict);

  assert.equal(
    verdict.accepted,
    true,
    "THE GATE IS SHUT: a credential registered by a witnessless type-0 StakeRegistration " +
      "cannot be withdrawn against. The registration finding does not carry, and the " +
      `one-transaction bootstrap is not viable. Ledger said: ${verdict.raw}`,
  );
  assert.ok(verdict.txId, "an accepted withdrawal must return a transaction id");
});
