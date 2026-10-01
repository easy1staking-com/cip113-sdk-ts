/**
 * M-of-N witness assembly — the open item that blocked the rotation, settled
 * offline rather than discovered on a chain.
 *
 * ⛔ THE QUESTION NOBODY HAD ANSWERED. A 2-of-3 authority needs two witnesses
 * on one transaction. Every existing call site in this repo merged exactly ONE
 * witness set from ONE client, so whether successive merges ACCUMULATE or
 * REPLACE was unknown — and a caller who assumed wrongly would submit a
 * transaction carrying one witness and read `MissingVKeyWitnessesUTXOW`, which
 * names a key rather than the merge that dropped it.
 *
 * ⛔ AND THE SILENT FAILURE UNDERNEATH IT, recorded first-hand in
 * `test/harness/raw-tx.ts`: Evolution's signer looks each required key hash up
 * in its derivation keystore and ON A MISS RETURNS
 * `TransactionWitnessSet.empty()` — a SUCCESSFUL call that signs nothing. So
 * "every signer returned something" is not evidence that every signer signed,
 * and an M-of-N assembly that does not COUNT cannot tell the difference.
 *
 * ⚑ FIXTURES ARE HAND-BUILT CBOR, DELIBERATELY. The first draft sampled
 * `Transaction.arbitrary`, which works — and drags in `fast-check`, a
 * TRANSITIVE dependency of `effect` that this package does not declare. Relying
 * on it would be an undeclared dependency, and declaring it would be a
 * constitution change for a test that does not need one. Hand-built CBOR also
 * makes the fixtures deterministic: there is no sampler that can quietly stop
 * producing witnesses and leave every assertion below vacuous.
 *
 * The shapes, so a reader can check them rather than trust them:
 *   transaction  = [ body, witness_set, isValid, auxiliary_data ]
 *   body         = { 0: [[txid, index]], 1: [outputs], 2: fee }
 *   witness_set  = { 0: [ [vkey(32 bytes), signature(64 bytes)] ] }
 *
 * Signature validity is irrelevant here: every property under test is about the
 * MERGE, not about whether a signature verifies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction as EvoTx, TransactionWitnessSet as EvoWitnessSet } from "@evolution-sdk/evolution";

import {
  assembleMultiSignedTx,
  assembleSignedTx,
  assertVKeyWitnessCount,
  countVKeyWitnesses,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Hand-built fixtures
// ---------------------------------------------------------------------------

const rep = (n, byte) => byte.repeat(n);

/** `[ {0:[[txid,0]], 1:[], 2:0}, {}, true, null ]` — a witnessless transaction. */
const BASE =
  "84" +
  ("a3" + "00" + "81" + "82" + "5820" + rep(32, "11") + "00" + "01" + "80" + "02" + "00") +
  "a0" +
  "f5" +
  "f6";

/** `{0: [[vkey, signature]]}` — one vkey witness, distinguishable by its bytes. */
const witnessSet = (vkeyByte, sigByte) =>
  "a1" + "00" + "81" + "82" + "5820" + rep(32, vkeyByte) + "5840" + rep(64, sigByte);

const WS_A = witnessSet("aa", "a1");
const WS_B = witnessSet("bb", "b1");
const WS_C = witnessSet("cc", "c1");

const bodyOf = (hex) =>
  Buffer.from(EvoTx.extractBodyBytes(EvoTx.toCBORBytes(EvoTx.fromCBORHex(hex)))).toString("hex");

// ---------------------------------------------------------------------------
// Proof of harness — the fixtures must be real, and really witnessless
// ---------------------------------------------------------------------------

test("the hand-built base transaction PARSES and carries zero vkey witnesses", () => {
  // ⚠ Everything below is vacuous if this is not a real transaction or if the
  // base already carried witnesses. Asserted, not assumed.
  const parsed = EvoTx.fromCBORHex(BASE);
  assert.ok(parsed, "the hand-built CBOR must decode as a Transaction");
  assert.equal(countVKeyWitnesses(BASE), 0, "and start with no witnesses at all");
});

test("the three witness sets are DISTINCT, so a count of 3 cannot be one set thrice", () => {
  assert.equal(new Set([WS_A, WS_B, WS_C]).size, 3);
  for (const ws of [WS_A, WS_B, WS_C]) {
    assert.equal(
      countVKeyWitnesses(assembleSignedTx(BASE, ws)),
      1,
      "and each one is a well-formed single-witness set",
    );
  }
});

// ---------------------------------------------------------------------------
// The property the rotation depends on
// ---------------------------------------------------------------------------

test("successive merges ACCUMULATE — this is what makes an M-of-N rotation possible", () => {
  const one = assembleSignedTx(BASE, WS_A);
  const two = assembleSignedTx(one, WS_B);
  assert.equal(countVKeyWitnesses(one), 1);
  assert.equal(
    countVKeyWitnesses(two),
    2,
    "if this were 1, successive merges would REPLACE, every M-of-N transaction built this way " +
      "would be short a witness, and it would fail on chain with an error naming a key",
  );
});

test("the transaction BODY is byte-identical after merging — signatures stay valid over it", () => {
  // ⛔ A merge that re-encoded the body would invalidate every signature over
  // it, and the failure would present as an INVALID witness rather than as a
  // re-encoding. Nothing else in this suite would notice.
  const merged = assembleMultiSignedTx(BASE, [WS_A, WS_B, WS_C]);
  assert.equal(bodyOf(merged), bodyOf(BASE), "the body must survive the merge untouched");
});

test("three witnesses accumulate too — the count is not capped at two", () => {
  assert.equal(countVKeyWitnesses(assembleMultiSignedTx(BASE, [WS_A, WS_B, WS_C])), 3);
});

test("assembleMultiSignedTx is exactly a loop over assembleSignedTx, in order", () => {
  const sequential = assembleSignedTx(assembleSignedTx(BASE, WS_A), WS_B);
  assert.equal(
    assembleMultiSignedTx(BASE, [WS_A, WS_B]),
    sequential,
    "the helper is a loop, not a different operation — so anything proven of one holds of the other",
  );
});

// ---------------------------------------------------------------------------
// The count assertion — the guard against a silently-unsigned transaction
// ---------------------------------------------------------------------------

test("assertVKeyWitnessCount passes on the expected count and REFUSES a short one", () => {
  assertVKeyWitnessCount(assembleMultiSignedTx(BASE, [WS_A, WS_B]), 2);

  let err;
  try {
    assertVKeyWitnessCount(assembleSignedTx(BASE, WS_A), 2);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "a 2-of-3 transaction carrying one witness must be refused");
  assert.match(err.message, /carries 1 vkey witness\(es\), expected 2/);
  assert.match(err.message, /DOES NOT HOLD THE KEY/, "and names the silent failure that causes it");
  assert.match(err.message, /extra_signatories/, "and the required_signers trap beside it");
});

test("assertVKeyWitnessCount also refuses MORE than expected", () => {
  assert.throws(
    () => assertVKeyWitnessCount(assembleMultiSignedTx(BASE, [WS_A, WS_B]), 1),
    /expected 1/,
    "more than expected means the assembly did something other than intended — usually a set merged twice",
  );
});

test("REFUSED: an empty witness-set STRING — the shape a keyless signer returns", () => {
  assert.throws(
    () => assembleMultiSignedTx(BASE, [WS_A, ""]),
    /DOES NOT HOLD THE KEY/,
    "merging it is silent, so it is refused by name instead",
  );
  assert.throws(() => assembleMultiSignedTx(BASE, []), /non-empty array/);
});

test("A TRULY EMPTY witness set merges to NOTHING — the measurement behind that refusal", () => {
  // ⚠ This is why the string check above is worth having. An empty
  // `TransactionWitnessSet` is valid CBOR, merging it reports success, and
  // nothing downstream can distinguish it from a signer that was never called.
  const empty = EvoWitnessSet.toCBORHex(EvoWitnessSet.empty());
  const merged = assembleSignedTx(BASE, empty);
  assert.equal(countVKeyWitnesses(merged), 0, "a successful merge that added no witness at all");
  assert.throws(
    () => assertVKeyWitnessCount(merged, 1),
    /carries 0 vkey/,
    "and the COUNT is the only thing that catches it",
  );
});
