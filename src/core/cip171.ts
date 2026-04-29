/**
 * CIP-171 — On-chain Smart Contract Bytecode Verification.
 *
 * Builds the transaction metadata payload (label 1984) that links one or more
 * deployed script hashes back to a source repository + commit, so verifiers can
 * reproduce the on-chain script hashes by re-compiling the source.
 *
 * Wire format per the CIP and the uplc-link reference impl:
 *
 *   { 1984: [ <chunk1>, <chunk2>, ..., <chunkN> ] }   ; each chunk ≤ 64 bytes
 *
 * Concatenated chunks decode to a single CBOR PlutusData:
 *
 *   Constr <compilerId>
 *     [ sourceUrl       : ByteArray (UTF-8)
 *     , commitHash      : ByteArray (20 or 32 raw bytes)
 *     , sourcePath      : ByteArray (UTF-8, "" for repo root)
 *     , compilerVersion : ByteArray (UTF-8)
 *     , parameters      : Map<ScriptHash(28b), List<PlutusData>>
 *     ]
 *
 * The `parameters` map keys are the **un-parameterised** (raw) script hashes —
 * i.e. Aiken's `validators[].hash` straight out of plutus.json. The `params`
 * list contains the PlutusData that, when applied to the raw script via
 * `applyParamsToScript`, reproduces the deployed hash.
 *
 * Limitation: each raw script can appear at most once in `parameters`. Deploying
 * the same raw script twice with different params (e.g. two `always_fail`
 * instances with distinct nonces) cannot be fully described in a single record.
 */

import { Data, Bytes } from "@evolution-sdk/evolution";
import type { HexString, ScriptHash, PlutusData } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CIP-10 metadata label registered for CIP-171. */
export const CIP171_METADATA_LABEL = 1984n;

/** Maximum size of any single metadata bytestring (Cardano protocol limit). */
export const CIP171_MAX_CHUNK_BYTES = 64;

/**
 * PlutusData constructor IDs identifying the compiler + schema version.
 * Sourced from the CIP-0171 README. Constructor 0 is Aiken (schema v1).
 */
export const CompilerType = {
  AIKEN: 0,
  PLUTARCH: 1,
  PLUTUS_TX: 2,
  SCALUS: 3,
  PLU_TS: 4,
  OPSHIN: 5,
} as const;
export type CompilerType = (typeof CompilerType)[keyof typeof CompilerType];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in the CIP-171 parameters map. */
export interface Cip171ScriptEntry {
  /** 28-byte hex Blake2b-224 hash of the **un-parameterised** compiled script. */
  rawScriptHash: ScriptHash;
  /** PlutusData arguments applied to that raw script to produce the deployed hash. */
  params: PlutusData[];
}

export interface Cip171Record {
  compilerType: CompilerType;
  /** Git-clone-compatible repo URL. */
  sourceUrl: string;
  /** Raw git commit hash hex (40 chars for SHA-1, 64 for SHA-256). */
  commitHash: HexString;
  /** Path inside the repo. Empty string for root. */
  sourcePath?: string;
  /** Exact compiler version string (e.g. "v1.1.21+42babe5"). */
  compilerVersion: string;
  /** Map keyed by raw script hash. */
  scripts: Cip171ScriptEntry[];
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Build the CIP-171 PlutusData record (the structure stored under metadata 1984
 * once chunks are reassembled and decoded).
 */
export function buildCip171PlutusData(record: Cip171Record): PlutusData {
  const seen = new Set<string>();
  const entries: Array<[PlutusData, PlutusData]> = [];
  for (const e of record.scripts) {
    const k = e.rawScriptHash.toLowerCase();
    if (seen.has(k)) {
      throw new Error(
        `CIP-171: duplicate raw script hash ${k}. Each raw script may appear at most once.`,
      );
    }
    seen.add(k);
    entries.push([Data.bytearray(e.rawScriptHash), Data.list(e.params)]);
  }

  return Data.constr(BigInt(record.compilerType), [
    Data.bytearray(utf8ToHex(record.sourceUrl)),
    Data.bytearray(record.commitHash),
    Data.bytearray(utf8ToHex(record.sourcePath ?? "")),
    Data.bytearray(utf8ToHex(record.compilerVersion)),
    Data.map(entries),
  ]);
}

/**
 * Encode a CIP-171 record to the chunked metadatum value (a list of byte
 * chunks ≤ 64 bytes each). Drop the result straight into Evolution's
 * `attachMetadata({ label: CIP171_METADATA_LABEL, metadata: chunks })`.
 */
export function buildCip171Metadatum(
  record: Cip171Record,
  chunkSize: number = CIP171_MAX_CHUNK_BYTES,
): Uint8Array[] {
  if (chunkSize < 1 || chunkSize > CIP171_MAX_CHUNK_BYTES) {
    throw new Error(`CIP-171: chunk size must be in [1, ${CIP171_MAX_CHUNK_BYTES}]`);
  }
  const cbor = Data.toCBORBytes(buildCip171PlutusData(record));
  return chunkBytes(cbor, chunkSize);
}

/** Slice a byte array into ≤ chunkSize pieces in order. */
export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, Math.min(i + chunkSize, bytes.length)));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

// ---------------------------------------------------------------------------
// Decoding (round-trip helper for tests & verifiers)
// ---------------------------------------------------------------------------

/** Reassemble a chunked metadatum and decode the embedded CIP-171 record. */
export function decodeCip171Metadatum(chunks: ReadonlyArray<Uint8Array>): Cip171Record {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const data = Data.fromCBORBytes(merged);
  return decodeCip171PlutusData(data);
}

export function decodeCip171PlutusData(data: PlutusData): Cip171Record {
  if (!(data instanceof Data.Constr)) {
    throw new Error("CIP-171: expected Constr at top level");
  }
  const compilerType = Number(data.index) as CompilerType;
  const fields = data.fields;
  if (fields.length < 5) {
    throw new Error(`CIP-171: expected ≥5 fields, got ${fields.length}`);
  }
  const sourceUrl = bytesToUtf8(asBytes(fields[0]));
  const commitHash = Bytes.toHex(asBytes(fields[1]));
  const sourcePath = bytesToUtf8(asBytes(fields[2]));
  const compilerVersion = bytesToUtf8(asBytes(fields[3]));
  const paramsField = fields[4];
  if (!(paramsField instanceof globalThis.Map)) {
    throw new Error("CIP-171: expected Map for parameters field");
  }
  const scripts: Cip171ScriptEntry[] = [];
  for (const [k, v] of paramsField.entries()) {
    const rawScriptHash = Bytes.toHex(asBytes(k));
    if (!Array.isArray(v)) {
      throw new Error(`CIP-171: expected List for params of ${rawScriptHash}`);
    }
    scripts.push({ rawScriptHash, params: [...v] });
  }
  return { compilerType, sourceUrl, commitHash, sourcePath, compilerVersion, scripts };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asBytes(d: PlutusData): Uint8Array {
  if (!(d instanceof Uint8Array)) {
    throw new Error("CIP-171: expected ByteArray (Uint8Array)");
  }
  return d;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return bytes.length === 0 ? "" : new TextDecoder().decode(bytes);
}

function utf8ToHex(s: string): HexString {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
