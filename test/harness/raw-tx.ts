/**
 * Raw transaction assembler — builds a Conway transaction OUTSIDE the Evolution
 * transaction builder.
 *
 * WHY THIS EXISTS. Evolution 0.5.2 models every Conway certificate in its TYPE
 * layer (`Certificate.Certificate` is a 17-arm union including the legacy
 * Shelley `StakeRegistration`) but its BUILDER can only emit the certificates
 * its 25 fixed operations construct. There is no generic `addCertificate`.
 * `state.certificates` is written in exactly three files — `operations/Stake.js`,
 * `operations/Governance.js`, `operations/Pool.js` — and each constructs one
 * hardcoded certificate class. So a transaction carrying a certificate the
 * builder does not know how to emit has to be assembled by hand.
 *
 * WHAT MAKES THAT TRACTABLE. A transaction with no script witnesses has no
 * redeemers, therefore no script data hash, therefore nothing to evaluate. The
 * fee collapses to the deterministic linear formula `a * size + b` and
 * balancing is arithmetic over the inputs. Removing the scripts removes most of
 * what the builder was needed for: coin selection, evaluation, collateral, and
 * the fee/change fixed point all disappear or become three lines.
 *
 * ⛔ THIS IS INVESTIGATION SCAFFOLDING, NOT SDK API. It lives under test/ and is
 * deliberately not exported from `src/`. It handles exactly the shape the
 * type-0 probe needs — ada-only inputs, ada-only outputs, no scripts, no mint,
 * no collateral — and will silently mis-build anything else.
 *
 * ⚠ SIGN THE HEX, NOT THE OBJECT. `client.signTx` accepts either, and the two
 * take DIFFERENT code paths inside Evolution's seed wallet
 * (`sdk/client/internal/Signing.js`, `makeSigningWalletEffect`):
 *
 *     const txHash = typeof txOrHex === "string"
 *       ? TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Bytes.fromHex(txOrHex)))
 *       : TransactionBody.toHash(tx.body);
 *
 * The string path hashes the LITERAL body bytes of the hex you hand it; the
 * object path re-serialises. Hand-assembled bodies are exactly where those two
 * can disagree, and the disagreement surfaces as a missing-vkey-witness
 * rejection that names the signature rather than the serialisation. Passing the
 * hex — and then merging witnesses with `addVKeyWitnessesHex`, which preserves
 * the original body bytes via the captured CBOR format tree — removes the
 * question entirely.
 *
 * ⚠ AND PASS `utxos`. The same function decides WHICH keys to sign with by
 * intersecting the transaction's inputs against `context.utxos`. With no
 * `utxos` the required-key set is empty and it returns
 * `TransactionWitnessSet.empty()` — a SUCCESSFUL call that signs nothing. The
 * transaction then fails at submission for a missing witness, pointing at the
 * key rather than at the empty context that caused it.
 */

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Bytes as EvoBytes,
  Certificate as EvoCertificate,
  Credential as EvoCredential,
  FeeValidation,
  Transaction as EvoTransaction,
  TransactionBody as EvoTransactionBody,
  TransactionHash as EvoTransactionHash,
  TransactionInput as EvoTransactionInput,
  TransactionWitnessSet as EvoWitnessSet,
  TxOut as EvoTxOut,
} from "@evolution-sdk/evolution";

// ---------------------------------------------------------------------------
// Protocol parameters
// ---------------------------------------------------------------------------

/** The subset of protocol parameters a script-free transaction actually needs. */
export interface RawTxParams {
  /** `a` in `fee = a * size + b`. */
  readonly minFeeCoefficient: bigint;
  /** `b` in `fee = a * size + b`. */
  readonly minFeeConstant: bigint;
  /** Deposit the ledger takes for a stake-credential registration. */
  readonly stakeCredentialDeposit: bigint;
  /** Ledger protocol version major.minor — recorded so a verdict names its era. */
  readonly protocolVersion: string;
  readonly maxTransactionSize: number;
}

/**
 * Read fee/deposit parameters straight from Ogmios.
 *
 * Deliberately NOT from Evolution's `getProtocolParameters`: the point of this
 * module is to depend on as little of the builder stack as possible, and the
 * three numbers below are the entire dependency.
 */
export async function ogmiosParams(ogmiosUrl: string): Promise<RawTxParams> {
  const res = await ogmiosRpc(ogmiosUrl, "queryLedgerState/protocolParameters", {});
  if (res.error) {
    throw new Error(`queryLedgerState/protocolParameters failed: ${JSON.stringify(res.error)}`);
  }
  const p = res.result;
  const version = p.version ? `${p.version.major}.${p.version.minor}` : "unknown";
  return {
    minFeeCoefficient: BigInt(p.minFeeCoefficient),
    minFeeConstant: BigInt(p.minFeeConstant.ada.lovelace),
    stakeCredentialDeposit: BigInt(p.stakeCredentialDeposit.ada.lovelace),
    protocolVersion: version,
    maxTransactionSize: Number(p.maxTransactionSize.bytes),
  };
}

// ---------------------------------------------------------------------------
// Ogmios transport
// ---------------------------------------------------------------------------

/**
 * One JSON-RPC round trip, returning the ENVELOPE rather than throwing.
 *
 * ⛔ THE VERDICT IS THE PAYLOAD. Every wrapper between this probe and the node
 * loses information: Evolution's Kupmios provider replaces the ledger's reason
 * with the string "Kupmios <operation> failed" and buries the cause, and the
 * repo has already been bitten by asserting on wrapper text that was
 * byte-identical across two completely different refusals. A question about
 * what the LEDGER does has to be answered in the ledger's own words, so this
 * returns `{ result }` or `{ error }` verbatim and lets the caller decide.
 */
export async function ogmiosRpc(
  ogmiosUrl: string,
  method: string,
  params: unknown,
): Promise<any> {
  const resp = await fetch(ogmiosUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: null }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Ogmios ${method}: non-JSON response ${resp.status}: ${text.slice(0, 500)}`);
  }
}

/** The ledger's answer to a submission, unedited. */
export interface SubmitVerdict {
  readonly accepted: boolean;
  /** Transaction id, when accepted. */
  readonly txId?: string;
  /** The raw `error` object from the JSON-RPC envelope, when rejected. */
  readonly error?: unknown;
  /** `error` pretty-printed — this is what gets pasted into the design note. */
  readonly raw: string;
}

/**
 * Submit CBOR hex directly to Ogmios `submitTransaction`.
 *
 * Direct rather than through `client.submitTx` so the JSON-RPC error object —
 * which carries the ledger's own discriminated failure, its code, and its
 * structured data — reaches the caller intact.
 */
export async function submitToOgmios(ogmiosUrl: string, cborHex: string): Promise<SubmitVerdict> {
  const res = await ogmiosRpc(ogmiosUrl, "submitTransaction", {
    transaction: { cbor: cborHex },
  });
  if (res.error) {
    return {
      accepted: false,
      error: res.error,
      raw: JSON.stringify(res.error, null, 2),
    };
  }
  return {
    accepted: true,
    txId: res.result?.transaction?.id,
    raw: JSON.stringify(res.result, null, 2),
  };
}

/**
 * Block until a submitted transaction is visible in the LEDGER's UTxO set.
 *
 * ⛔ A SUBMISSION IS NOT A STATE CHANGE. `submitTransaction` returning an id
 * means the node accepted the transaction into its mempool, not that the ledger
 * has applied it. Anything that depends on the effect — a withdrawal against a
 * credential the previous transaction registered, say — validates against a
 * ledger state that may not contain it yet, and fails in a way that looks
 * exactly like the effect never happening. That would turn a timing artefact
 * into a false verdict on the question under test.
 *
 * Asks the LEDGER (`queryLedgerState/utxo`) rather than an indexer: Kupo and
 * yaci-store both trail the node, and this has to be ahead of them, not behind.
 * Every transaction here produces at least a change output at index 0, so its
 * presence is the confirmation signal.
 */
export async function awaitTxOnChain(
  ogmiosUrl: string,
  txId: string,
  { timeoutMs = 60_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ogmiosRpc(ogmiosUrl, "queryLedgerState/utxo", {
      outputReferences: [{ transaction: { id: txId }, index: 0 }],
    });
    if (Array.isArray(res.result) && res.result.length > 0) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `awaitTxOnChain: ${txId} did not appear in the ledger UTxO set within ${timeoutMs}ms. ` +
      `It was accepted into the mempool but never applied, so anything downstream of its ` +
      `effect would be measuring the wrong ledger state.`,
  );
}

/**
 * Is a stake credential registered, as the LEDGER currently sees it?
 *
 * ⚠ TREAT AN EMPTY RESULT AS "NO ANSWER", NOT AS "NOT REGISTERED". Measured on
 * this devnet: `rewardAccountSummaries` returned `{}` for the devnet's own
 * stake-pool reward account, which is necessarily registered — so an empty
 * result from this query does NOT establish absence. It is reported for
 * interest and is never the basis of a verdict here; the load-bearing
 * effectiveness checks are the deposit arithmetic and the double-submit, both
 * of which are enforced by the ledger rather than read from an index.
 */
export async function rewardAccountSummary(
  ogmiosUrl: string,
  scriptHashHex: string,
): Promise<unknown> {
  const res = await ogmiosRpc(ogmiosUrl, "queryLedgerState/rewardAccountSummaries", {
    scripts: [scriptHashHex],
  });
  return res.error ?? res.result;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** A wallet UTxO reduced to what a script-free spend needs. */
export interface SpendableUtxo {
  readonly txHash: string;
  readonly index: number;
  readonly lovelace: bigint;
}

export interface RawTxSpec {
  /** Signing client — used ONLY for `signTx`. No building, no submission. */
  readonly client: any;
  /** Wallet UTxOs, in full Evolution form, for the signer's required-key set. */
  readonly walletUtxos: ReadonlyArray<any>;
  /** The inputs to spend. Must be a subset of `walletUtxos`. */
  readonly inputs: ReadonlyArray<SpendableUtxo>;
  /** Where the balance goes. */
  readonly changeAddress: any;
  /** Certificates to carry. Any arm of Evolution's `Certificate` union. */
  readonly certificates?: ReadonlyArray<EvoCertificate.Certificate>;
  /**
   * Lovelace the LEDGER will take for the certificates, over and above fee and
   * outputs. The caller states it explicitly rather than having it inferred,
   * because whether the ledger charges a deposit for a given certificate type
   * is precisely the thing under test.
   */
  readonly certificateDeposit?: bigint;
  readonly params: RawTxParams;
  /** Extra lovelace paid above the computed minimum fee. See `buildRawTx`. */
  readonly feeMargin?: bigint;
}

export interface RawTxResult {
  readonly cborHex: string;
  readonly txSizeBytes: number;
  readonly fee: bigint;
  readonly minRequiredFee: bigint;
  readonly changeLovelace: bigint;
  readonly bodyJson: unknown;
}

const FEE_FIXED_POINT_ROUNDS = 6;

/**
 * Assemble, balance and sign a script-free transaction.
 *
 * FEE. `fee = minFeeCoefficient * size + minFeeConstant`, where `size` is the
 * SIGNED transaction's CBOR length — the witnesses are part of what the ledger
 * measures. Size and fee are mutually dependent (a larger fee can occupy more
 * CBOR bytes, and the change output shrinks as the fee grows), so this iterates
 * to a fixed point and then overpays by `feeMargin`.
 *
 * ⚠ THE OVERPAYMENT IS DELIBERATE AND IT IS THE POINT. A fee that is one byte
 * short is rejected as `feeTooSmall`, which is a perfectly ordinary
 * transaction-construction failure that has NOTHING to do with the certificate
 * type under test — and it would be read as the answer. Overpaying is always
 * accepted by the ledger, so it converts a possible false verdict into a few
 * hundred lovelace. `minRequiredFee` is returned alongside so the margin is
 * visible rather than hidden, and the caller asserts `fee >= minRequiredFee`
 * through Evolution's own independent `FeeValidation`.
 */
export async function buildRawTx(spec: RawTxSpec): Promise<RawTxResult> {
  const {
    client,
    walletUtxos,
    inputs,
    changeAddress,
    certificates,
    params,
    certificateDeposit = 0n,
    feeMargin = 2_000n,
  } = spec;

  if (inputs.length === 0) throw new Error("buildRawTx: no inputs");

  const inputSum = inputs.reduce((acc, u) => acc + u.lovelace, 0n);

  const txInputs = inputs.map(
    (u) =>
      new EvoTransactionInput.TransactionInput({
        transactionId: EvoTransactionHash.fromHex(u.txHash),
        index: BigInt(u.index),
      }),
  );

  const certs = certificates && certificates.length > 0 ? [...certificates] : undefined;

  const assemble = (fee: bigint) => {
    const change = inputSum - fee - certificateDeposit;
    if (change <= 0n) {
      throw new Error(
        `buildRawTx: inputs (${inputSum}) cannot cover fee (${fee}) + deposit ` +
          `(${certificateDeposit}); fund the wallet or select more inputs`,
      );
    }
    const body = new EvoTransactionBody.TransactionBody({
      inputs: txInputs,
      outputs: [
        new EvoTxOut.TransactionOutput({
          address: changeAddress,
          assets: EvoAssets.fromLovelace(change),
        }),
      ],
      fee,
      // NOTE what is absent and why it is absent: no scriptDataHash (no
      // redeemers), no collateral (no Plutus scripts), no mint, no validity
      // interval. A script-free certificate transaction needs none of them, and
      // every one of them is a way to be rejected for a reason unrelated to the
      // certificate.
      certificates: certs as any,
    });
    const tx = new EvoTransaction.Transaction({
      body,
      witnessSet: EvoWitnessSet.empty(),
      isValid: true,
      auxiliaryData: null,
    });
    return { tx, change };
  };

  const sign = async (unsignedHex: string): Promise<string> => {
    // Hex in, hex out — see the module header for why neither end may be the
    // structured object.
    const ws = await client.signTx(unsignedHex, { utxos: walletUtxos });
    const vkeys = (ws as any).vkeyWitnesses ?? [];
    if (vkeys.length === 0) {
      throw new Error(
        "buildRawTx: the wallet produced ZERO vkey witnesses. This is the empty-context " +
          "trap, not a key problem: Evolution's signer derives its required-key set by " +
          "intersecting the transaction's inputs with `context.utxos`, and returns an " +
          "empty witness set rather than an error when that intersection is empty. " +
          `Inputs offered: ${inputs.length}; wallet UTxOs passed as context: ${walletUtxos.length}.`,
      );
    }
    return EvoTransaction.addVKeyWitnessesHex(unsignedHex, EvoWitnessSet.toCBORHex(ws));
  };

  const minFeeFor = (sizeBytes: number) =>
    params.minFeeCoefficient * BigInt(sizeBytes) + params.minFeeConstant;

  // Seed the iteration with a fee whose CBOR width matches the answer's, so the
  // first measurement is already close: anything in 65_536..4_294_967_295
  // encodes as five bytes, and the real fee lands around 175_000.
  let fee = 1_000_000n;
  let signedHex = "";
  let size = 0;
  let minRequired = 0n;

  for (let round = 0; round < FEE_FIXED_POINT_ROUNDS; round++) {
    const { tx } = assemble(fee);
    signedHex = await sign(EvoTransaction.toCBORHex(tx));
    size = signedHex.length / 2;
    minRequired = minFeeFor(size);
    const next = minRequired + feeMargin;
    if (next === fee) break;
    fee = next;
  }

  // Re-measure at the settled fee and make the final fee cover the FINAL size,
  // whatever that turned out to be. A fixed point that did not quite converge
  // must not silently ship a short fee.
  const { tx: finalTx, change } = assemble(fee);
  signedHex = await sign(EvoTransaction.toCBORHex(finalTx));
  size = signedHex.length / 2;
  minRequired = minFeeFor(size);
  if (fee < minRequired) {
    throw new Error(
      `buildRawTx: fee ${fee} did not converge above minFee ${minRequired} for ${size} bytes`,
    );
  }

  // Evolution's own fee check, run against the SIGNED transaction — an
  // independent implementation of the same formula, so a mistake in the
  // arithmetic above has to be made twice to get through.
  const decoded = EvoTransaction.fromCBORHex(signedHex);
  const validation = FeeValidation.validateTransactionFee(decoded, {
    minFeeCoefficient: params.minFeeCoefficient,
    minFeeConstant: params.minFeeConstant,
  });
  if (!validation.isValid) {
    throw new Error(
      `buildRawTx: FeeValidation rejected the assembled transaction — ` +
        `fee ${validation.actualFee} < min ${validation.minRequiredFee} at ` +
        `${validation.txSizeBytes} bytes`,
    );
  }
  if (size > params.maxTransactionSize) {
    throw new Error(`buildRawTx: ${size} bytes exceeds maxTransactionSize ${params.maxTransactionSize}`);
  }

  return {
    cborHex: signedHex,
    txSizeBytes: size,
    fee,
    minRequiredFee: minRequired,
    changeLovelace: change,
    bodyJson: JSON.parse(
      JSON.stringify(finalTx.body.toJSON(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Certificate constructors the builder cannot emit
// ---------------------------------------------------------------------------

/**
 * Legacy Shelley `stake_registration` — certificate type 0, `[0, credential]`.
 *
 * No `coin` field: the deposit, if the ledger takes one, comes from the
 * protocol parameter rather than from the certificate. That absence is the
 * whole reason Conway introduced `RegCert`, and the reason this certificate is
 * worth probing.
 */
export function stakeRegistrationType0(credential: EvoCredential.Credential) {
  return new EvoCertificate.StakeRegistration({ stakeCredential: credential });
}

/**
 * Conway `reg_cert` — certificate type 7, `[7, credential, coin]`. What
 * Evolution's `registerStake` emits, reproduced here so the control arm differs
 * from the subject in the certificate and in nothing else.
 */
export function regCertType7(credential: EvoCredential.Credential, deposit: bigint) {
  return new EvoCertificate.RegCert({ stakeCredential: credential, coin: deposit });
}

/** A script credential from a 28-byte script hash in hex. */
export function scriptCredential(scriptHashHex: string): EvoCredential.Credential {
  return EvoCredential.makeScriptHash(EvoBytes.fromHex(scriptHashHex));
}

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------

/** Ada-only wallet UTxOs, largest first — the spendable set for a raw build. */
export function adaOnly(utxos: ReadonlyArray<any>): SpendableUtxo[] {
  return utxos
    .filter((u) => {
      const multi = (u.assets as any)?.multiAsset;
      return !multi || multi.map?.size === 0 || Object.keys(multi.map ?? {}).length === 0;
    })
    .map((u) => ({
      txHash: EvoTransactionHash.toHex(u.transactionId),
      index: Number(u.index),
      lovelace: BigInt(EvoAssets.lovelaceOf(u.assets)),
    }))
    .sort((a, b) => (b.lovelace > a.lovelace ? 1 : b.lovelace < a.lovelace ? -1 : 0));
}

/** Bech32 of an Evolution address object. */
export function bech32(address: any): string {
  return EvoAddress.toBech32(address);
}
