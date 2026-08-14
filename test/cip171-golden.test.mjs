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
      params: [
        Data.bytearray(
          "d8799f58208c198e942f1f7a60e704aa1651333b45bccd51653259204e4dac38b559844dd800ff"
        ),
      ],
    },
    {
      rawScriptHash: "39b875da204d886d1ea0c4ae193281b819236efa36ab0b711bb3977e",
      params: [Data.bytearray("66d403abc1d6f1206b74c64204766e46601b88747575f6a0a02142a0")],
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
