/**
 * CIP-171 golden fixture — byte-identity with the reference registry.
 *
 * uplc-link is the public registry that indexes and verifies every label-1984
 * record on chain. It is the consumer of everything this encoder emits, and it
 * parses STRICTLY on six fields: `fields.size() != 6` is dropped, log-only, by
 * design (PlutusScanRequestParser.java). A five-field record is therefore not
 * rejected loudly — it is silently ignored.
 *
 * The vectors below are theirs, not ours: taken from their cross-language pair
 * (frontend `__tests__/metadata-encoding.test.ts`, backend `SerdeTest.java`),
 * which already anchors their TypeScript and Java to the same bytes. Asserting
 * against them here makes this SDK a third independent producer of the same
 * bytes rather than a second copy of one implementation's opinion.
 *
 * If this test fails, do NOT adjust the expected hex. It is the contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  buildCip171PlutusData,
  buildCip171Metadatum,
  decodeCip171Metadatum,
  CompilerType,
  CIP171_CBOR_OPTIONS,
  cip171Param,
} from "../dist/core/cip171.js";

/** From uplc-link SerdeTest.simpleSerdeTest() — env: "" (built without --env). */
const FIXTURE = {
  compilerType: CompilerType.AIKEN,
  sourceUrl: "http://github.com/easy1staking-com/cardano-recurring-payment",
  commitHash: "35f1a0d51c8663782ab052f869d5c82b756e8615",
  sourcePath: "",
  compilerVersion: "v1.1.3",
  env: "",
  scripts: [
    // Deliberately NOT in sorted order: the encoder must canonicalise.
    {
      rawScriptHash: "e513498211e006e0fa7679e7c51ef09fd0b53904b7bfa5d9fb3dd01b",
      // Opaque byte strings, NOT inline PlutusData — see defect 4.
      params: ["d8799f58208c198e942f1f7a60e704aa1651333b45bccd51653259204e4dac38b559844dd800ff"],
    },
    {
      rawScriptHash: "39b875da204d886d1ea0c4ae193281b819236efa36ab0b711bb3977e",
      params: ["66d403abc1d6f1206b74c64204766e46601b88747575f6a0a02142a0"],
    },
  ],
};

const EXPECTED_HEX =
  "d8799f583c687474703a2f2f6769746875622e636f6d2f65617379317374616b696e672d636f6d2f63617264616e6f2d726563757272696e672d7061796d656e745435f1a0d51c8663782ab052f869d5c82b756e8615404676312e312e3340a2581c39b875da204d886d1ea0c4ae193281b819236efa36ab0b711bb3977e9f581c66d403abc1d6f1206b74c64204766e46601b88747575f6a0a02142a0ff581ce513498211e006e0fa7679e7c51ef09fd0b53904b7bfa5d9fb3dd01b9f5827d8799f58208c198e942f1f7a60e704aa1651333b45bccd51653259204e4dac38b559844dd800ffffff";

/** Their chunking, 64 bytes each. */
const EXPECTED_CHUNKS = [
  "d8799f583c687474703a2f2f6769746875622e636f6d2f65617379317374616b696e672d636f6d2f63617264616e6f2d726563757272696e672d7061796d656e",
  "745435f1a0d51c8663782ab052f869d5c82b756e8615404676312e312e3340a2581c39b875da204d886d1ea0c4ae193281b819236efa36ab0b711bb3977e9f58",
  "1c66d403abc1d6f1206b74c64204766e46601b88747575f6a0a02142a0ff581ce513498211e006e0fa7679e7c51ef09fd0b53904b7bfa5d9fb3dd01b9f5827d8",
  "799f58208c198e942f1f7a60e704aa1651333b45bccd51653259204e4dac38b559844dd800ffffff",
];

const toHex = (u8) => Buffer.from(u8).toString("hex");

test("GOLDEN: encoded record is byte-identical to the reference registry", () => {
  const actual = Data.toCBORHex(buildCip171PlutusData(FIXTURE), CIP171_CBOR_OPTIONS);
  assert.equal(
    actual.toLowerCase(),
    EXPECTED_HEX.toLowerCase(),
    "bytes diverged from uplc-link's fixture — the registry drops what it cannot parse, " +
    "so a mismatch here means records vanish silently rather than erroring"
  );
});

test("GOLDEN: field 4 is env, field 5 is the parameters map", () => {
  // Guards the exact regression that motivated this file: emitting the
  // published five-field layout, which the registry drops.
  const withEnv = { ...FIXTURE, env: "preview" };
  const hex = Data.toCBORHex(buildCip171PlutusData(withEnv), CIP171_CBOR_OPTIONS);

  assert.ok(hex.includes("4770726576696577"), 'env="preview" must encode as 4770726576696577');
  assert.ok(EXPECTED_HEX.includes("40a2"), 'env="" must encode as 40, immediately before the map');

  const decoded = decodeCip171Metadatum(buildCip171Metadatum(withEnv));
  assert.equal(decoded.env, "preview");
  assert.equal(decoded.scripts.length, 2);
});

test("GOLDEN: chunking matches theirs exactly", () => {
  const chunks = buildCip171Metadatum(FIXTURE).map(toHex);
  assert.deepEqual(chunks, EXPECTED_CHUNKS);
});

test("GOLDEN: map keys are canonicalised regardless of input order", () => {
  // FIXTURE lists e513… before 39b8…; the wire format must be ascending.
  const reversed = { ...FIXTURE, scripts: [...FIXTURE.scripts].reverse() };
  const a = Data.toCBORHex(buildCip171PlutusData(FIXTURE), CIP171_CBOR_OPTIONS);
  const b = Data.toCBORHex(buildCip171PlutusData(reversed), CIP171_CBOR_OPTIONS);
  assert.equal(a, b, "encoding must not depend on the order scripts were supplied");
  assert.equal(a.toLowerCase(), EXPECTED_HEX.toLowerCase());
});

test("a five-field record is refused on decode, not partially understood", () => {
  const fiveField = Data.constr(0n, [
    Data.bytearray("00"),
    Data.bytearray("35f1a0d51c8663782ab052f869d5c82b756e8615"),
    Data.bytearray("00"),
    Data.bytearray("00"),
    Data.map([[Data.bytearray("ab".repeat(28)), Data.list([])]]),
  ]);
  const cbor = Data.toCBORBytes(fiveField, CIP171_CBOR_OPTIONS);
  assert.throws(
    () => decodeCip171Metadatum([cbor]),
    /expected exactly 6 fields/,
    "the old layout must fail loudly here rather than be silently dropped downstream"
  );
});

// ---------------------------------------------------------------------------
// Spec-vs-reference divergences 4, 5, 6 — each asserted on the wire bytes
// ---------------------------------------------------------------------------

test("DEFECT 4: parameters are BYTESTRING-wrapped, never inline plutus_data", () => {
  // Published CDDL says `parameter_list = [ * plutus_data ]`. It is wrong, and
  // wrong silently: the registry reads .bytes on each element, so an inline
  // record parses, shows six fields, and loses its parameters with no warning.
  //
  // Checked STRUCTURALLY by decoding the CBOR. An earlier version of this test
  // regex-scanned the hex for "9f" and matched inside byte payloads — testing
  // the encoding by pattern-matching its serialization is its own trap.
  const decoded = Data.fromCBORHex(
    Data.toCBORHex(buildCip171PlutusData(FIXTURE), CIP171_CBOR_OPTIONS),
    CIP171_CBOR_OPTIONS
  );
  const paramsMap = decoded.fields[5];
  assert.ok(paramsMap instanceof Map, "field 5 must be a Map");

  for (const [key, list] of paramsMap.entries()) {
    assert.ok(key instanceof Uint8Array, "map key must be a bytestring");
    assert.ok(Array.isArray(list), "map value must be a list");
    assert.ok(list.length > 0, "every script entry must carry parameters here");
    for (const element of list) {
      assert.ok(
        element instanceof Uint8Array,
        `params element must be a ByteString; got ${element?.constructor?.name} ` +
        `— inline PlutusData is read as .bytes by the registry and silently lost`
      );
    }
  }
});

test("DEFECT 4: a non-empty parameters map is what exercises this", () => {
  // An empty map would pass every other assertion in this file while leaving
  // the parameter encoding completely untested.
  const totalParams = FIXTURE.scripts.reduce((n, s) => n + s.params.length, 0);
  assert.ok(totalParams > 0, "fixture must carry real parameters");
  const decoded = decodeCip171Metadatum(buildCip171Metadatum(FIXTURE));
  for (const original of FIXTURE.scripts) {
    const found = decoded.scripts.find((s) => s.rawScriptHash === original.rawScriptHash);
    assert.deepEqual(
      found.params.map((p) => p.toLowerCase()),
      original.params.map((p) => p.toLowerCase()),
      `parameters for ${original.rawScriptHash} must survive the round-trip intact`
    );
  }
});

test("DEFECT 4: inline PlutusData is refused rather than silently encoded", () => {
  assert.throws(
    () => buildCip171PlutusData({
      ...FIXTURE,
      scripts: [{ rawScriptHash: "ab".repeat(28), params: [Data.bytearray("aabb")] }],
    }),
    /parameters must be non-empty hex byte strings/,
    "a PlutusData object must not be accepted where opaque bytes belong"
  );
});

test("DEFECT 5: chunks are exactly 64 bytes with only the last one short", () => {
  // The CDDL permits 1..64 but does not mandate the boundary discipline, so
  // matching the reference by accident is possible. Assert the rule itself.
  const chunks = buildCip171Metadatum(FIXTURE);
  assert.ok(chunks.length > 1, "fixture must be large enough to chunk");
  for (const c of chunks.slice(0, -1)) {
    assert.equal(c.length, 64, "every chunk but the last must be exactly 64 bytes");
  }
  const last = chunks[chunks.length - 1];
  assert.ok(last.length > 0 && last.length <= 64, "last chunk in (0, 64]");
});

test("DEFECT 6: the constr field list uses INDEFINITE-length arrays", () => {
  const hex = Data.toCBORHex(buildCip171PlutusData(FIXTURE), CIP171_CBOR_OPTIONS);
  // d879 = tag 121 (constr 0), then 9f = indefinite array start, terminated ff.
  assert.ok(hex.startsWith("d8799f"), `expected d8799f prefix, got ${hex.slice(0, 8)}`);
  assert.ok(hex.endsWith("ff"), "indefinite array must be break-terminated");
  // ...while the map inside is DEFINITE (a2 = 2 entries), not bf.
  assert.ok(hex.includes("40a2"), "map must be definite-length (a2), not indefinite (bf)");
  assert.ok(!hex.includes("40bf"), "an indefinite map (bf) means wrong bytes");
});

test("cip171Param serializes PlutusData to the exact bytes the wire expects", () => {
  const data = Data.constr(0n, [Data.bytearray("8c".repeat(32)), Data.int(0n)]);
  const asHex = cip171Param(data);
  assert.equal(asHex, Data.toCBORHex(data, CIP171_CBOR_OPTIONS));
  // And it is accepted as a parameter, unlike the PlutusData it came from.
  assert.ok(buildCip171PlutusData({
    ...FIXTURE,
    scripts: [{ rawScriptHash: "ab".repeat(28), params: [asHex] }],
  }));
});
