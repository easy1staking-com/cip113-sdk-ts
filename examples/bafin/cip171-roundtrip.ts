/**
 * Local sanity check — encode a CIP-171 record, chunk it, decode it back,
 * and verify the round-trip + chunk-size invariants. Not a chain test.
 */

import { Data } from "@evolution-sdk/evolution";
import {
  CIP171_METADATA_LABEL,
  CIP171_MAX_CHUNK_BYTES,
  CompilerType,
  buildCip171Metadatum,
  buildCip171PlutusData,
  decodeCip171Metadatum,
} from "../../src/core/cip171.js";

const record = {
  compilerType: CompilerType.AIKEN,
  sourceUrl: "https://github.com/cardano-foundation/cip113-programmable-tokens",
  commitHash: "81438534f83550789e13961db17b59d606cf8a8e",
  sourcePath: "",
  compilerVersion: "v1.1.21+42babe5",
  scripts: [
    {
      rawScriptHash: "e9d8d9c7fc531f0b179d502c86bffee829613c537794dab053ae28fe",
      params: [Data.bytearray("daa1e3ec7f567c31a48598407ba1503810bd824a4a01a83e7cef7015bced1339")],
    },
    {
      rawScriptHash: "29c78c576f9a399449b3b8d0339616f5fbe8f7334bcc7cd2c087d538",
      params: [
        Data.constr(0n, [Data.bytearray("aa".repeat(32)), Data.int(0n)]),
        Data.bytearray("e9d8d9c7fc531f0b179d502c86bffee829613c537794dab053ae28fe"),
      ],
    },
  ],
};

const cbor = Data.toCBORBytes(buildCip171PlutusData(record));
const chunks = buildCip171Metadatum(record);
const total = chunks.reduce((n, c) => n + c.length, 0);

console.log("label:", CIP171_METADATA_LABEL.toString());
console.log("cbor bytes:", cbor.length);
console.log("chunks:", chunks.length, "total bytes:", total);
console.log("chunk sizes:", chunks.map((c) => c.length).join(","));
console.log("max chunk size respected:", chunks.every((c) => c.length <= CIP171_MAX_CHUNK_BYTES));
console.log("cbor == concat(chunks):", total === cbor.length);

const decoded = decodeCip171Metadatum(chunks);
console.log("decoded.compilerType:", decoded.compilerType, "(expect", CompilerType.AIKEN, ")");
console.log("decoded.sourceUrl:", decoded.sourceUrl);
console.log("decoded.commitHash:", decoded.commitHash);
console.log("decoded.sourcePath:", JSON.stringify(decoded.sourcePath));
console.log("decoded.compilerVersion:", decoded.compilerVersion);
console.log("decoded.scripts:");
for (const s of decoded.scripts) console.log("  ", s.rawScriptHash, "params=", s.params.length);

const ok =
  decoded.sourceUrl === record.sourceUrl &&
  decoded.commitHash === record.commitHash &&
  decoded.sourcePath === record.sourcePath &&
  decoded.compilerVersion === record.compilerVersion &&
  decoded.compilerType === record.compilerType &&
  decoded.scripts.length === record.scripts.length &&
  total === cbor.length &&
  chunks.every((c) => c.length <= CIP171_MAX_CHUNK_BYTES);
console.log(ok ? "ROUNDTRIP OK" : "ROUNDTRIP FAILED");
process.exit(ok ? 0 : 1);
