/**
 * CIP-171 encode/decode round-trip and wire-format invariants.
 *
 * Salvaged from the abandoned bafin branch (commit c944966), where it existed
 * as a console.log script that printed "ROUNDTRIP OK" and exited. Converted to
 * assertions so a regression fails a run instead of printing a different word
 * into a log nobody reads.
 *
 * The chunk-size invariant is the load-bearing one: Cardano rejects any single
 * metadata bytestring over 64 bytes, so a record that encodes fine but chunks
 * wrong produces a transaction the ledger refuses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  CIP171_METADATA_LABEL,
  CIP171_MAX_CHUNK_BYTES,
  CompilerType,
  buildCip171Metadatum,
  buildCip171PlutusData,
  chunkBytes,
  decodeCip171Metadatum,
  decodeCip171PlutusData,
  CIP171_CBOR_OPTIONS,
  cip171Param,
} from "../dist/core/cip171.js";

/** A record describing the upstream contracts this SDK is pinned against. */
const record = {
  compilerType: CompilerType.AIKEN,
  sourceUrl: "https://github.com/cardano-foundation/cip113-programmable-tokens",
  commitHash: "81438534f83550789e13961db17b59d606cf8a8e",
  sourcePath: "",
  compilerVersion: "v1.1.21+42babe5",
  scripts: [
    {
      rawScriptHash: "e9d8d9c7fc531f0b179d502c86bffee829613c537794dab053ae28fe",
      params: ["daa1e3ec7f567c31a48598407ba1503810bd824a4a01a83e7cef7015bced1339"],
    },
    {
      rawScriptHash: "29c78c576f9a399449b3b8d0339616f5fbe8f7334bcc7cd2c087d538",
      // cip171Param() serializes PlutusData to the opaque bytes the wire format
      // requires. Passing the PlutusData directly is now a type error.
      params: [
        cip171Param(Data.constr(0n, [Data.bytearray("aa".repeat(32)), Data.int(0n)])),
        "e9d8d9c7fc531f0b179d502c86bffee829613c537794dab053ae28fe",
      ],
    },
  ],
};

test("metadata label is the CIP-10 registered value", () => {
  assert.equal(CIP171_METADATA_LABEL, 1984n);
});

test("round-trip preserves every field", () => {
  const decoded = decodeCip171Metadatum(buildCip171Metadatum(record));

  assert.equal(decoded.compilerType, record.compilerType);
  assert.equal(decoded.sourceUrl, record.sourceUrl);
  assert.equal(decoded.commitHash, record.commitHash);
  assert.equal(decoded.sourcePath, record.sourcePath, "empty sourcePath must survive");
  assert.equal(decoded.compilerVersion, record.compilerVersion);
  assert.equal(decoded.scripts.length, record.scripts.length);

  // Compared by lookup, not by index: the encoder canonicalises map key order,
  // so decoded order is ascending by key and need not match input order.
  for (const original of record.scripts) {
    const found = decoded.scripts.find((s) => s.rawScriptHash === original.rawScriptHash);
    assert.ok(found, `script ${original.rawScriptHash} missing after round-trip`);
    assert.equal(found.params.length, original.params.length, "param count");
  }
  const keys = decoded.scripts.map((s) => s.rawScriptHash);
  assert.deepEqual([...keys].sort(), keys, "decoded keys must be in canonical ascending order");
});

test("no chunk exceeds the 64-byte ledger limit", () => {
  const chunks = buildCip171Metadatum(record);
  assert.ok(chunks.length > 0, "expected at least one chunk");
  for (const [i, c] of chunks.entries()) {
    assert.ok(
      c.length <= CIP171_MAX_CHUNK_BYTES,
      `chunk ${i} is ${c.length} bytes — the ledger rejects anything over ${CIP171_MAX_CHUNK_BYTES}`
    );
  }
});

test("chunks concatenate back to exactly the CBOR payload", () => {
  // Must use the same codec options the metadatum builder uses, or the two
  // encodings differ by the map header alone and the comparison is meaningless.
  const cbor = Data.toCBORBytes(buildCip171PlutusData(record), CIP171_CBOR_OPTIONS);
  const chunks = buildCip171Metadatum(record);
  const total = chunks.reduce((n, c) => n + c.length, 0);

  assert.equal(total, cbor.length, "chunking must not add or drop bytes");
  assert.deepEqual(Buffer.concat(chunks.map(Buffer.from)), Buffer.from(cbor));
});

test("PlutusData round-trips independently of chunking", () => {
  const decoded = decodeCip171PlutusData(buildCip171PlutusData(record));
  assert.equal(decoded.sourceUrl, record.sourceUrl);
  assert.equal(decoded.commitHash, record.commitHash);
  assert.equal(decoded.scripts.length, record.scripts.length);
});

test("chunkBytes splits at the boundary, never over it", () => {
  // Exactly at the limit: one chunk, untouched.
  assert.equal(chunkBytes(new Uint8Array(64), 64).length, 1);
  // One byte over: two chunks, and the split is 64 + 1.
  const over = chunkBytes(new Uint8Array(65), 64);
  assert.equal(over.length, 2);
  assert.equal(over[0].length, 64);
  assert.equal(over[1].length, 1);
});

// ---------------------------------------------------------------------------
// Refusing to write false provenance on chain
// ---------------------------------------------------------------------------
//
// A CIP-171 record is permanent and public. The realistic accident is not a
// malicious wrong commit — it is a placeholder reaching the chain because the
// blueprint's provenance was never established. This repo has exactly that
// situation today: blueprints/standard/v0.3.0 is pinned UNVERIFIED with
// upstream.commit === null, so a bootstrap that read the pin and emitted a
// record would encode `null` as a provenance claim that can never be retracted.

test("rejects a null commit hash — the unverified-provenance case", () => {
  assert.throws(
    () => buildCip171PlutusData({ ...record, commitHash: null }),
    /commitHash must be a 20- or 32-byte hex string/,
    "a pin with commit: null must not become an on-chain claim"
  );
});

test("rejects placeholder and truncated commit hashes", () => {
  for (const bad of ["", "unknown", "TBD", "8143853", "deadbeef", "z".repeat(40)]) {
    assert.throws(
      () => buildCip171PlutusData({ ...record, commitHash: bad }),
      /commitHash must be/,
      `"${bad}" must be rejected`
    );
  }
});

test("accepts both 20-byte and 32-byte commit hashes", () => {
  assert.ok(buildCip171PlutusData({ ...record, commitHash: "ab".repeat(20) }));
  assert.ok(buildCip171PlutusData({ ...record, commitHash: "ab".repeat(32) }));
});

test("rejects a raw script hash that is not 28 bytes", () => {
  // The commonest confusion: passing a DEPLOYED (parameterised) hash, or a
  // transaction id, where the un-parameterised plutus.json hash belongs.
  assert.throws(
    () => buildCip171PlutusData({
      ...record,
      scripts: [{ rawScriptHash: "ab".repeat(32), params: ["ab"] }],
    }),
    /rawScriptHash must be a 28-byte hex string/
  );
});

test("rejects an empty record — it would claim nothing", () => {
  assert.throws(() => buildCip171PlutusData({ ...record, scripts: [] }), /claims nothing/);
  assert.throws(() => buildCip171PlutusData({ ...record, sourceUrl: "  " }), /sourceUrl/);
  assert.throws(() => buildCip171PlutusData({ ...record, compilerVersion: "" }), /compilerVersion/);
});
