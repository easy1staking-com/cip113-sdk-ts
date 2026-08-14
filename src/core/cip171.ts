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
 * Concatenated chunks decode to a single CBOR PlutusData, in the **six-field**
 * layout — NOT the five-field one in the currently published CIP text:
 *
 *   Constr <compilerId>
 *     [ 0: sourceUrl       : ByteArray (UTF-8)
 *     , 1: commitHash      : ByteArray (20 or 32 RAW bytes, not UTF-8)
 *     , 2: sourcePath      : ByteArray (UTF-8, "" for repo root)
 *     , 3: compilerVersion : ByteArray (UTF-8)
 *     , 4: env             : ByteArray (UTF-8, "" = built without --env)
 *     , 5: parameters      : Map<ScriptHash(28b), List<ByteString>>
 *     ]
 *
 * The six-field layout redefines constructor 0 IN PLACE. This matters more than
 * a version bump would: the reference registry (uplc-link) parses strictly on
 * `fields.size() == 6` and **drops anything else, log-only, by design**. A
 * five-field record is therefore not rejected loudly — it is silently ignored.
 * Encoder and decoder here are both strict on 6 for that reason.
 *
 * Byte-level compatibility is asserted against uplc-link's own cross-language
 * fixture (their FE `metadata-encoding.test.ts` / BE `SerdeTest`), which anchors
 * the TypeScript and Java implementations to the same bytes. See
 * CIP171_CBOR_OPTIONS: the encoding is indefinite-length arrays with a
 * DEFINITE-length, key-sorted map, which is not Evolution's default.
 *
 * The `parameters` map keys are the **un-parameterised** (raw) script hashes —
 * i.e. Aiken's `validators[].hash` straight out of plutus.json. Each value is a
 * list of **byte strings**, each wrapping the CBOR encoding of one parameter,
 * which applied to the raw script via `applyParamsToScript` reproduce the
 * deployed hash.
 *
 * The published CDDL says `parameter_list = [ * plutus_data ]` — inline. That is
 * wrong against the reference, and wrong in the worst way: an inline record
 * still parses and still shows six fields, but the registry reads `.bytes` on
 * each element, gets empty strings, and stores a record with its parameters
 * silently gone. Hence `Cip171ScriptEntry.params` is typed `HexString[]`, so the
 * mistake is unrepresentable rather than merely documented.
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
  /**
   * Arguments applied to that raw script to produce the deployed hash, each as
   * an **opaque byte string in hex** — NOT inline PlutusData.
   *
   * The published CDDL says `parameter_list = [ * plutus_data ]`, and it is
   * wrong. The reference wire shape is `[ * bytes ]`: every element is a
   * bytestring whose content is the parameter's CBOR encoding. Emitting inline
   * PlutusData is not rejected by the registry — its parser reads `.bytes` on
   * each element, gets an empty string, and stores a record whose parameters
   * have silently vanished while the record itself still parses.
   *
   * The type is `string[]` rather than `PlutusData[]` precisely so that mistake
   * cannot be made: use {@link cip171Param} to serialize PlutusData.
   */
  params: HexString[];
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
  /**
   * Build environment — the value passed to the compiler's `--env` flag.
   * Empty string (the default) means the script was built without `--env`;
   * PlutusData has no null, so absence is encoded as empty bytes.
   *
   * Field index 4 of the six-field layout. See the note on the layout below.
   */
  env?: string;
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
/** Hex string of exactly `bytes` bytes, case-insensitive. */
function isHexOfBytes(s: unknown, ...bytes: number[]): boolean {
  return typeof s === "string" && bytes.some((b) => new RegExp(`^[0-9a-fA-F]{${b * 2}}$`).test(s));
}

/**
 * Validate a record before it is encoded.
 *
 * A CIP-171 record is a PERMANENT, PUBLIC claim that a set of deployed scripts
 * was produced from a named repository at a named commit. It goes on chain in
 * transaction metadata and cannot be retracted. A malformed or placeholder
 * commit hash therefore does not fail loudly at some later point — it becomes
 * an immutable false provenance record that verifiers will try, and fail, to
 * reproduce.
 *
 * This cannot detect a well-formed but WRONG commit. It does stop the realistic
 * accidents: a null, empty, truncated or placeholder value reaching the chain
 * because the blueprint's provenance was never actually established.
 */
function validateCip171Record(record: Cip171Record): void {
  if (!isHexOfBytes(record.commitHash, 20, 32)) {
    throw new Error(
      `CIP-171: commitHash must be a 20- or 32-byte hex string (40 or 64 hex chars), got ` +
      `${record.commitHash === undefined ? "undefined" : JSON.stringify(record.commitHash)}. ` +
      `This record is a permanent on-chain claim about where the deployed scripts came from — ` +
      `do not emit one until the blueprint's provenance is actually known.`
    );
  }
  if (typeof record.sourceUrl !== "string" || record.sourceUrl.trim() === "") {
    throw new Error("CIP-171: sourceUrl must be a non-empty repository URL");
  }
  if (typeof record.compilerVersion !== "string" || record.compilerVersion.trim() === "") {
    throw new Error(
      "CIP-171: compilerVersion must be non-empty — verifiers reproduce hashes with this exact compiler"
    );
  }
  if (record.scripts.length === 0) {
    throw new Error("CIP-171: a record with no scripts claims nothing; refusing to encode it");
  }
  for (const e of record.scripts) {
    for (const p of e.params) {
      if (typeof p !== "string" || !/^([0-9a-fA-F]{2})*$/.test(p) || p.length === 0) {
        throw new Error(
          `CIP-171: parameters must be non-empty hex byte strings, got ${JSON.stringify(p)} ` +
          `for ${e.rawScriptHash}. Serialize PlutusData with cip171Param() — inline PlutusData ` +
          `is silently dropped by the reference registry.`
        );
      }
    }
    if (!isHexOfBytes(e.rawScriptHash, 28)) {
      throw new Error(
        `CIP-171: rawScriptHash must be a 28-byte hex string (56 hex chars), got ` +
        `${JSON.stringify(e.rawScriptHash)}. These are the UN-parameterised hashes from ` +
        `plutus.json, not the deployed ones.`
      );
    }
  }
}

export function buildCip171PlutusData(record: Cip171Record): PlutusData {
  validateCip171Record(record);

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
    entries.push([
      Data.bytearray(e.rawScriptHash),
      // Each param wrapped as a BYTESTRING. Inline PlutusData here is the
      // published-CDDL reading and it corrupts silently — see Cip171ScriptEntry.
      Data.list(e.params.map((p) => Data.bytearray(p))),
    ]);
  }

  // Canonical map ordering: ascending by key bytes. The reference registry's
  // fixtures are byte-sorted, and Evolution's `sortMapKeys` codec option does
  // not reach Data maps, so the sort is done here rather than delegated.
  entries.sort((a, b) => {
    const ka = (a[0] as Uint8Array), kb = (b[0] as Uint8Array);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return ka.length - kb.length;
  });

  return Data.constr(BigInt(record.compilerType), [
    Data.bytearray(utf8ToHex(record.sourceUrl)),
    Data.bytearray(record.commitHash),
    Data.bytearray(utf8ToHex(record.sourcePath ?? "")),
    Data.bytearray(utf8ToHex(record.compilerVersion)),
    Data.bytearray(utf8ToHex(record.env ?? "")),
    Data.map(entries),
  ]);
}

/**
 * CBOR options reproducing the reference registry's bytes exactly:
 * indefinite-length arrays/lists (`9f…ff`) with a DEFINITE-length map (`a2`).
 *
 * Evolution's default (`CML_DATA_DEFAULT_OPTIONS`) uses indefinite maps (`bf`),
 * which does not match. Verified byte-identical against uplc-link's
 * cross-language fixture — see test/cip171.test.mjs.
 */
export const CIP171_CBOR_OPTIONS = {
  mode: "custom",
  useIndefiniteArrays: true,
  useIndefiniteMaps: false,
  useDefiniteForEmpty: true,
  sortMapKeys: true,
  useMinimalEncoding: true,
} as const;

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
  const cbor = Data.toCBORBytes(buildCip171PlutusData(record), CIP171_CBOR_OPTIONS);
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
  // STRICT six fields. The reference registry drops anything else (log-only,
  // by design), so a five-field record is unparseable there rather than
  // partially understood. Failing loudly here beats emitting one.
  if (fields.length !== 6) {
    throw new Error(
      `CIP-171: expected exactly 6 fields, got ${fields.length}. ` +
      `The five-field layout was redefined in place; records in the old shape are ` +
      `silently dropped by the registry.`
    );
  }
  const sourceUrl = bytesToUtf8(asBytes(fields[0]));
  const commitHash = Bytes.toHex(asBytes(fields[1]));
  const sourcePath = bytesToUtf8(asBytes(fields[2]));
  const compilerVersion = bytesToUtf8(asBytes(fields[3]));
  const env = bytesToUtf8(asBytes(fields[4]));
  const paramsField = fields[5];
  if (!(paramsField instanceof globalThis.Map)) {
    throw new Error("CIP-171: expected Map for parameters field");
  }
  const scripts: Cip171ScriptEntry[] = [];
  for (const [k, v] of paramsField.entries()) {
    const rawScriptHash = Bytes.toHex(asBytes(k));
    if (!Array.isArray(v)) {
      throw new Error(`CIP-171: expected List for params of ${rawScriptHash}`);
    }
    // Elements are bytestrings on the wire; surface them as hex, matching the
    // encoder's input shape so a decode/encode round-trip is lossless.
    scripts.push({ rawScriptHash, params: v.map((p) => Bytes.toHex(asBytes(p))) });
  }
  return { compilerType, sourceUrl, commitHash, sourcePath, compilerVersion, env, scripts };
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

/**
 * Serialize a PlutusData parameter to the hex byte string a CIP-171 record
 * expects, using the encoding the reference registry reproduces.
 *
 * A verifier applies these to the un-parameterised script via
 * `applyParamsToScript` and compares the resulting hash, so the bytes must be
 * exactly what the original build applied.
 */
export function cip171Param(data: PlutusData): HexString {
  return Data.toCBORHex(data, CIP171_CBOR_OPTIONS);
}
