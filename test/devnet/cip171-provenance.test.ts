/**
 * The bootstrap's CIP-171 record must RECOMPUTE to the hashes actually deployed.
 *
 * ⚠ "The transaction submitted" is not evidence. A wrong-arity constr-0 record
 * is discarded by the reference parser with only a log line — no error, no
 * REJECTED row, no trace — so a dropped record and a never-published one are
 * indistinguishable from outside. The only check worth running is a positive
 * one, and the strongest available offline is recomputation:
 *
 *     raw script + recorded params  ->  hash  ==  the hash on chain
 *
 * A record that does not survive that is decoration.
 *
 * ⚠ THIS TEST IS NECESSARY AND NOT SUFFICIENT. It proves the record describes
 * the scripts we actually deployed. It does NOT prove any registry will accept
 * it — that is a separate, three-level question, and only the third level is
 * acceptance:
 *
 *   1. the transaction submitted            — worthless on its own
 *   2. a lookup by tx hash returns 200      — proves INGESTION ONLY; a PENDING
 *                                             row and a REJECTED row both 200
 *   3. `status == "VERIFIED"` AND every covered script is COMPLETE or
 *      NONE_REQUIRED (never PARTIAL) — the only level that means accepted.
 *      ⚠ A record can be VERIFIED while a script inside it proves nothing:
 *      mainnet `a58e18c4…` is VERIFIED with one script PARTIAL, finalHash
 *      null, 0 of 8 parameters. The per-script half is load-bearing.
 *      ⚠ The literal is VERIFIED. An earlier draft said "SUCCESS" — a
 *      plausible gloss that API cannot emit, so the check would have run and
 *      meant nothing. Nothing in THIS repo could have typechecked it.
 *
 * MEASURED: preview tx 20da8206… passed 1 and 2 while verification was failing
 * with `No parser found for Aiken version: v1.1.23+8949565`.
 *
 * NOT CIRCULAR: the record is read back through CBOR encode -> decode, and the
 * comparison target comes from DeploymentParams, which is produced by a
 * different path than the recorder that built the record.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Data } from "@evolution-sdk/evolution";
import {
  decodeCip171Metadatum,
  parameterizeScript,
  computeScriptHash,
} from "../../dist/index.js";
import { requireDevnet } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { STORE_URL } from "../harness/yaci.mjs";

before(async () => {
  await requireDevnet();
});

test("the bootstrap's CIP-171 record recomputes to the deployed script hashes", async () => {
  const deployment: any = await bootstrapProtocol();
  const blueprint: any = loadStandardBlueprint();

  // 1. Read the record back OFF THE CHAIN, not from the object we built.
  const resp = await fetch(`${STORE_URL}/txs/${deployment.txHash}/metadata`);
  assert.equal(resp.status, 200, "the bootstrap tx must be indexed");
  const body: any = await resp.json();
  const entry = (Array.isArray(body) ? body : []).find(
    (m: any) => String(m.label) === "1984"
  );
  assert.ok(entry, `the bootstrap tx must carry label 1984 — got labels ${JSON.stringify(
    (Array.isArray(body) ? body : []).map((m: any) => m.label)
  )}`);

  // 2. Reassemble and decode.
  const chunks: Uint8Array[] = (
    Array.isArray(entry.value ?? entry.json_metadata)
      ? (entry.value ?? entry.json_metadata)
      : []
  ).map((c: any) =>
    Uint8Array.from(Buffer.from(String(c).replace(/^0x/, ""), "hex"))
  );
  assert.ok(chunks.length > 0, "the metadatum must be a non-empty array of byte chunks");
  const record = decodeCip171Metadatum(chunks);

  // 3. The compiler version is the ARTEFACT's, not this machine's. Aiken is
  //    machine-global here and the versions genuinely differ, so a record
  //    naming the local toolchain is a false provenance claim.
  assert.equal(
    record.compilerVersion,
    blueprint.preamble.compiler.version,
    "compilerVersion must come from the blueprint's preamble, not from `aiken --version`"
  );

  // 4. RECOMPUTE. Every raw script + its recorded params must produce a hash
  //    that the deployment actually uses.
  // Harvest EVERY 28-byte hex value in DeploymentParams, whatever the key.
  // An earlier version collected only `.scriptHash` and reported four false
  // failures: the deployment stores several of these as policy ids and as bare
  // strings, so a narrow collector accuses a correct record.
  const deployedHashes = new Set<string>();
  const collect = (o: any) => {
    if (typeof o === "string") {
      if (/^[0-9a-fA-F]{56}$/.test(o)) deployedHashes.add(o.toLowerCase());
      return;
    }
    if (!o || typeof o !== "object") return;
    for (const v of Object.values(o)) collect(v);
  };
  collect(deployment);

  const rawByHash = new Map<string, string>();
  for (const v of blueprint.validators ?? []) {
    if (v.compiledCode) rawByHash.set(computeScriptHash(v.compiledCode).toLowerCase(), v.compiledCode);
  }

  assert.ok(record.scripts.length > 0, "the record must describe at least one script");
  const unmatched: string[] = [];
  for (const s of record.scripts) {
    const raw = rawByHash.get(s.rawScriptHash.toLowerCase());
    assert.ok(raw, `record names raw script ${s.rawScriptHash}, absent from the blueprint`);
    const applied = parameterizeScript(
      raw,
      s.params.map((p: string) => Data.fromCBORHex(p))
    );
    if (!deployedHashes.has(applied.hash.toLowerCase())) {
      unmatched.push(`${s.rawScriptHash} -> ${applied.hash} (not among the deployed hashes)`);
    }
  }
  // ⇒ COVERAGE, THE OTHER HALF — AND IT IS A PINNED NUMBER ON PURPOSE.
  //
  // Recomputation proves every RECORDED script is real. It cannot prove that
  // no USED script was omitted: a missing entry simply is not there to fail.
  // That is exactly how FES shipped covering 3 of its 4 scripts.
  //
  // There is no general automatic test for "should this validator have been
  // covered?" — core's issuance_mint is legitimately absent (its parameter
  // `minting_logic_cred` is a SUBSTANDARD's identity, which core does not
  // have), while FES's blacklist_spend was a real omission. Both look like
  // "one fewer than the blueprint holds".
  //
  // So the number is PINNED. If coverage changes in either direction this
  // fails, and a human decides which case it is. A guard that cannot decide
  // should stop, not guess.
  const distinctInBlueprint = new Set(
    (blueprint.validators ?? [])
      .filter((v: any) => v.compiledCode)
      .map((v: any) => computeScriptHash(v.compiledCode).toLowerCase())
  ).size;
  // ELEVEN in 0.5.0-alpha.4, of the blueprint's TWELVE distinct validators. It
  // was 10 of 11 in alpha.3 and 11 of 12 in alpha.2.
  //
  // WHY IT MOVED, deliberately and in two independent steps:
  //   * alpha.4 ADDED `issuance_logic` — the replaceable half of the issuance
  //     split — taking the blueprint from 11 distinct validators to 12. The
  //     bootstrap parameterises and deploys it, so it is covered.
  //   * `upgrade_multisig` is now parameterised by a RECORDABLE one-shot
  //     `utxo_ref` instead of an unrecorded signer set, so the bootstrap
  //     parameterises it through the same builder path as everything else and
  //     the event is captured.
  //   ⇒ the bootstrap parameterises 12 validators and records 11.
  //
  // The EXCLUSION is unchanged and is STILL THE ONLY ONE — issuance_mint takes
  // a substandard's minting_logic_cred, which a core deployment does not have.
  //
  // ⚠ This number moved because the PROTOCOL changed, which is the deliberate
  // decision this pin demands. It must not be adjusted to make a run go green.
  assert.equal(
    record.scripts.length,
    11,
    `core's record must cover exactly 11 scripts of the blueprint's ${distinctInBlueprint}. ` +
      `The one absent is issuance_mint, which takes a substandard's minting_logic_cred and ` +
      `therefore CANNOT be parameterised by a core deployment. If this number moved, decide ` +
      `deliberately whether a script became coverable or one was dropped — do not adjust it.`
  );

  // ⚑ AND THE ABSENTEE IS NAMED, not merely counted. A bare count cannot tell
  // "issuance_mint is structurally uncoverable" from "we forgot one" — the
  // distinction that cost a slice when FES's blacklist_spend went missing. The
  // mechanical test: every blueprint validator EXCEPT issuance_mint must appear
  // in the record by unapplied hash.
  const recordedRaw = new Set(record.scripts.map((x: any) => String(x.rawScriptHash ?? x.scriptHash).toLowerCase()));
  const missingTitles = (blueprint.validators ?? [])
    .filter((v: any) => v.compiledCode)
    .filter((v: any) => !recordedRaw.has(computeScriptHash(v.compiledCode).toLowerCase()))
    .map((v: any) => v.title.split(".").slice(0, 2).join("."));
  const uniqueMissing = [...new Set(missingTitles)];
  assert.deepEqual(
    uniqueMissing,
    ["issuance_mint.issuance_mint"],
    `exactly ONE validator may be absent from core's record, and it must be issuance_mint. ` +
      `Absent: ${uniqueMissing.join(", ")}`
  );

  assert.deepEqual(
    unmatched,
    [],
    `every recorded script must recompute to a DEPLOYED hash. A record that does not is ` +
      `decoration: it would verify to a script nobody is running.\n${unmatched.join("\n")}`
  );

  console.error(
    `=== CIP-171 === ${record.scripts.length} scripts recomputed to deployed hashes; ` +
      `compiler ${record.compilerVersion}; env "${record.env ?? ""}"`
  );
});
