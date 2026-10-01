/**
 * Transaction utilities — witness merging for CIP-103 stake registration flows.
 *
 * Previously contained a manual CBOR-level workaround for
 * https://github.com/IntersectMBO/evolution-sdk/issues/232
 * Fixed in @evolution-sdk/evolution — now delegates to the SDK.
 */

import { Transaction } from "@evolution-sdk/evolution";

/**
 * Assemble a signed transaction from an unsigned tx CBOR hex and a
 * CIP-30 witness set CBOR hex. Merges vkey witnesses into the transaction.
 *
 * This function will likely be removed once CIP-103 is fully implemented.
 */
export function assembleSignedTx(unsignedTxHex: string, witnessSetHex: string): string {
  return Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
}

// ---------------------------------------------------------------------------
// M-of-N assembly — several witnesses onto one transaction
// ---------------------------------------------------------------------------

/**
 * Merge SEVERAL witness sets onto one unsigned transaction, in order.
 *
 * ⛔ WHY THIS IS A NAMED FUNCTION AND NOT A LOOP THE CALLER WRITES. An M-of-N
 * authority needs M witnesses on one transaction, and every existing call site
 * in this repo merged exactly one set from exactly one client — so whether
 * successive merges ACCUMULATE or REPLACE was, until measured, unknown. A
 * caller who assumed wrongly would submit a transaction carrying one witness
 * and read `MissingVKeyWitnessesUTXOW`, which names a key rather than the
 * merge that dropped it.
 *
 * ⚑ MEASURED, OFFLINE: they ACCUMULATE. Two successive merges onto a
 * witnessless transaction yield 2, and the transaction BODY is byte-identical
 * afterwards — so the signatures stay valid over the thing they signed.
 * `test/upgrade-witnesses.test.mjs` pins both properties.
 *
 * ⚠ THIS SIGNS NOTHING. Each witness set comes from whoever holds that key,
 * through whatever signer they use. The SDK never holds a key.
 */
export function assembleMultiSignedTx(
  unsignedTxHex: string,
  witnessSetHexes: readonly string[]
): string {
  if (!Array.isArray(witnessSetHexes) || witnessSetHexes.length === 0) {
    throw new Error(
      `assembleMultiSignedTx: witnessSetHexes must be a non-empty array. An M-of-N transaction ` +
        `needs one witness set per signer; zero sets leaves the transaction unsigned, which is ` +
        `refused at submission as a missing witness rather than as an empty merge.`
    );
  }
  let acc = unsignedTxHex;
  for (const ws of witnessSetHexes) {
    if (typeof ws !== "string" || ws.length === 0) {
      throw new Error(
        `assembleMultiSignedTx: every witness set must be a non-empty CBOR hex string; got ` +
          `${JSON.stringify(ws)}. ⚠ AN EMPTY WITNESS SET IS THE SHAPE A SIGNER RETURNS WHEN IT ` +
          `DOES NOT HOLD THE KEY — a successful call that signed nothing. Merging it is silent, ` +
          `and the transaction then fails at submission naming the key rather than the miss.`
      );
    }
    acc = Transaction.addVKeyWitnessesHex(acc, ws);
  }
  return acc;
}

/** How many vkey witnesses a transaction currently carries. */
export function countVKeyWitnesses(txHex: string): number {
  const tx = Transaction.fromCBORHex(txHex);
  return tx.witnessSet?.vkeyWitnesses?.length ?? 0;
}

/**
 * Refuse a transaction that does not carry the expected number of vkey
 * witnesses, BEFORE it is submitted.
 *
 * ⛔ THE FAILURE THIS EXISTS FOR IS SILENT AND IS NOT HYPOTHETICAL. Evolution's
 * signer looks each required key hash up in its derivation keystore, and on a
 * miss it returns `TransactionWitnessSet.empty()` — a SUCCESSFUL call that
 * signs nothing (recorded first-hand in `test/harness/raw-tx.ts`). Merge that
 * and the transaction is short a witness with nothing anywhere reporting it;
 * the ledger then answers `MissingVKeyWitnessesUTXOW`, naming the hash and not
 * the empty context that caused it.
 *
 * ⇒ So an M-of-N assembly must COUNT before it submits. "Each signer returned
 * something" is not evidence that each signer signed.
 */
export function assertVKeyWitnessCount(txHex: string, expected: number): void {
  const actual = countVKeyWitnesses(txHex);
  if (actual === expected) return;
  throw new Error(
    `assertVKeyWitnessCount: this transaction carries ${actual} vkey witness(es), expected ` +
      `${expected}.\n` +
      (actual < expected
        ? `⚠ A SIGNER THAT DOES NOT HOLD THE KEY RETURNS AN EMPTY WITNESS SET AND DOES NOT ` +
          `FAIL — so "every signer returned something" is not evidence that every signer ` +
          `signed. Check that each key is actually in the signer you called, and that each ` +
          `required signer was named on the transaction (required_signers), since a tree's ` +
          `Signature leaf reads extra_signatories rather than the witness set.`
        : `More witnesses than expected is usually harmless on chain but means the assembly ` +
          `did something other than what was intended — most often the same set merged twice.`)
  );
}
