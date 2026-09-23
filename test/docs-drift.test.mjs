/**
 * Documentation is not tested by anything, and it silently rotted for two
 * protocol versions.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR, stated as history rather than as a worry.
 * `docs/api-reference.md` documented `DeploymentParams` with the **0.3.x**
 * shape — `programmableLogicGlobal: { policyId, scriptHash }`,
 * `protocolParams.alwaysFailScriptHash`, a `directoryMint`/`directorySpend`
 * pair. It survived the ENTIRE 0.3.x → 0.5.0-alpha.2 migration untouched,
 * because a build cannot fail on prose and no test read it. A consumer
 * following it would have written a deployment record the SDK cannot accept.
 *
 * ⚠ AND STALE DOCS ARE WORSE THAN ABSENT ONES for this particular type.
 * `DeploymentParams` is hand-assembled by whoever deploys the protocol; it is
 * the one input this SDK cannot derive or validate into existence. A reader
 * copying a wrong field list gets a well-formed object that fails at
 * submission, far from the document that misled them.
 *
 * So the field names in that document are pinned to the real type here. This is
 * deliberately a NAME check, not a type check: it catches the drift that
 * actually happened (fields renamed, added, removed) without pretending a
 * markdown fence can be typechecked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf-8");

/**
 * Field names of a documented / declared `interface X { … }`, TOP LEVEL AND
 * ONE LEVEL DOWN — nested members come back as `parent.child`.
 *
 * ⛔ THE NESTING IS THE WHOLE FIX, AND ITS ABSENCE IS THIS FILE'S SECOND
 * INCARNATION OF ITS OWN DEFECT. Both parsers used to collect names at
 * brace-depth 0 only. `DeploymentParams` puts most of its real content one level
 * down — `protocolParams.policyId`, `upgradeMultisig.txInput`,
 * `programmableLogicGlobal.unfrackingParameter` — so a field could be ADDED to
 * the type, REQUIRED by the SDK, and absent from the document a deployer
 * hand-builds the record from, while this test sat GREEN and
 * `docs/api-reference.md` CLAIMED to be pinned by it. MEASURED: that is exactly
 * what happened to `unfrackingParameter`.
 *
 * ⚠ The lesson is the classification. The check was judged by its SHAPE — "it
 * compares DeploymentParams field names" — rather than by WHAT GETS PAST IT,
 * which was everything nested. One level is what this type needs; it is a depth
 * with a reason, not a depth that happened. A third level would need the same
 * argument made again.
 *
 * ⚠ NOT A TYPE CHECK, still. It catches the drift that actually happens —
 * fields renamed, added, removed — without pretending a markdown fence can be
 * typechecked.
 */
function interfaceFields(text, header, what) {
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `${what}: must still declare ${header}`);
  const body = text.slice(text.indexOf("{", start) + 1);

  const names = [];
  let depth = 0;
  let parent = null;
  let inBlockComment = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    if (depth === 0 && line.startsWith("}")) break;

    const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
    if (m && depth === 0) {
      names.push(m[1]);
      // An object written INLINE on one line — the form the docs fence uses for
      // most of these, e.g. `registry: { txInput: TxInput; scriptHash: ... };`
      const inline = /^[A-Za-z_][A-Za-z0-9_]*\??\s*:\s*\{(.*)\}/.exec(line);
      if (inline) {
        for (const part of inline[1].split(/[;,]/)) {
          const n = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(part);
          if (n) names.push(`${m[1]}.${n[1]}`);
        }
      } else if (line.includes("{")) {
        // A multi-line block — the form src/types.ts uses when a member carries
        // its own doc comment. Its members are collected at depth 1 below.
        parent = m[1];
      }
    } else if (m && depth === 1 && parent) {
      names.push(`${parent}.${m[1]}`);
    }

    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (depth === 0) parent = null;
  }
  return names;
}

/** Documented field names, from a markdown ```typescript fence. */
function documentedFields(markdown, interfaceName) {
  return interfaceFields(markdown, `interface ${interfaceName} {`, "docs");
}

/** Real field names, from the source declaration. */
function sourceFields(ts, interfaceName) {
  return interfaceFields(ts, `export interface ${interfaceName} {`, "src");
}

test("docs/api-reference.md documents the REAL DeploymentParams fields", () => {
  const documented = documentedFields(read("docs/api-reference.md"), "DeploymentParams");
  const actual = sourceFields(read("src/types.ts"), "DeploymentParams");

  assert.ok(actual.length > 5, "sanity: the parser found a real field list");

  const missing = actual.filter((f) => !documented.includes(f));
  const invented = documented.filter((f) => !actual.includes(f));

  assert.deepEqual(
    missing,
    [],
    `DeploymentParams fields exist but are UNDOCUMENTED: ${missing.join(", ")}. ` +
      `A deployer hand-assembling this record from the docs would omit them.`,
  );
  assert.deepEqual(
    invented,
    [],
    `docs describe fields that DO NOT EXIST: ${invented.join(", ")}. ` +
      `This is exactly how the 0.3.x shape survived into the 0.5.x era.`,
  );
});

test("PROOF OF HARNESS: the parsers actually find fields", () => {
  // Both halves of the comparison must be non-trivial, or the test above passes
  // by comparing two empty lists — the vacuous-guard shape this repo has
  // shipped before.
  const documented = documentedFields(read("docs/api-reference.md"), "DeploymentParams");
  const actual = sourceFields(read("src/types.ts"), "DeploymentParams");

  assert.ok(documented.length >= 10, `docs parser found only ${documented.length} fields`);
  assert.ok(actual.length >= 10, `source parser found only ${actual.length} fields`);

  // ⛔ AND THEY MUST ACTUALLY DESCEND. Without this the test above compares two
  // top-level-only lists and passes exactly as it did while
  // `programmableLogicGlobal.unfrackingParameter` was undocumented — a green
  // reading from an instrument pointed one level too high. A parser that quietly
  // stopped nesting would restore that defect and nothing else would say so.
  const nested = (l) => l.filter((f) => f.includes("."));
  assert.ok(
    nested(documented).length >= 15,
    `docs parser found only ${nested(documented).length} NESTED fields — it is not descending`,
  );
  assert.ok(
    nested(actual).length >= 15,
    `source parser found only ${nested(actual).length} NESTED fields — it is not descending`,
  );
  // Both nesting FORMS must be reached: inline `{ a: T; b: U }` (the docs fence)
  // and a multi-line block whose members carry their own doc comments
  // (src/types.ts). A parser handling only one silently half-works.
  for (const required of [
    "protocolParams.policyId",              // inline, both files
    "upgradeMultisig.txInput",              // inline in docs, multi-line in src
    "programmableLogicGlobal.unfrackingParameter", // the field this fix exists for
  ]) {
    assert.ok(actual.includes(required), `source parser must reach ${required}`);
    assert.ok(documented.includes(required), `docs parser must reach ${required}`);
  }

  // And the names must be the specific ones alpha.3 introduced, so a parser
  // that silently returned a stale-but-plausible list would be caught.
  for (const required of [
    "programmableLogicGlobal",
    "maxInlineDatumBytes",
    "registry",
    "issuanceLogic",
  ]) {
    assert.ok(actual.includes(required), `source must expose ${required}`);
    assert.ok(documented.includes(required), `docs must document ${required}`);
  }
  // …and must NOT still carry the names alpha.3 removed.
  for (const gone of ["coordinationNonce", "coordination", "directoryMint", "directorySpend"]) {
    assert.ok(!actual.includes(gone), `${gone} was removed in alpha.3`);
    assert.ok(!documented.includes(gone), `docs still describe the removed ${gone}`);
  }
});

test("the README's migration note names the silent redeemer change", () => {
  // The one change a consumer cannot discover by failing: stale bytes decode.
  // If this section is ever trimmed, the trap goes undocumented again.
  //
  // ⛔ ANCHORED ON 0.9.0 EXPLICITLY, NOT ON THE FIRST "## Migrating to".
  // Every assertion below is about the alpha.2->alpha.4 PROTOCOL migration, which
  // is documented in the 0.9.0 section and nowhere else. This used to take the
  // FIRST migration heading, which was unambiguous only while exactly one existed
  // — adding the 0.10.0 note put a different section in that slot and reddened
  // this test for a reason that had nothing to do with the trap it guards. A
  // later release adding its own note must not silently re-point this guard.
  const readme = read("README.md");
  const start = readme.indexOf("## Migrating to 0.9.0");
  assert.notEqual(start, -1, "the 0.9.0 migration section is gone — the alpha.4 trap it documents is not");
  const end = readme.indexOf("\n## ", start + 1);
  const migration = readme.slice(start, end === -1 ? undefined : end);

  assert.notEqual(start, -1, "must retain one migration section");
  assert.match(migration, /Migrating to 0\.9\.0/);
  assert.match(migration, /byte-identical/i, "must state that the stale redeemer still decodes");
  assert.match(migration, /SpendViaTransfer/, "must name the stale constructor");
  assert.match(
    migration,
    /stale builder emitting `SpendViaTransfer`/,
    "must preserve the explanation of why the stale constructor is silent",
  );
  assert.match(
    migration,
    /wdrl_idx`\s+now\s+indexes\s+the\s+\*\*dispatcher/,
    "must say where wdrl_idx now points",
  );
  assert.match(
    migration,
    /Every mint and burn now needs .*issuance_logic.*withdraw-0/i,
    "must name alpha.4's issuance withdrawal obligation",
  );
  assert.match(migration, /index 1/i, "must name where issuance_logic_cred was inserted");
  assert.match(
    migration,
    /naming no withdrawal, no policy and no index/i,
    "must say why an omitted issuance_logic withdrawal is silent",
  );
});

test("package version and the migration note agree", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.version, "0.12.0");
  assert.match(read("README.md"), new RegExp(`Migrating to ${pkg.version.replace(/\./g, "\\.")}`));
});

// ---------------------------------------------------------------------------
// SubstandardContext — the published plugin interface
// ---------------------------------------------------------------------------

test("docs/api-reference.md documents the REAL SubstandardContext fields", () => {
  // ⛔ WHY THIS TYPE JOINS DeploymentParams HERE. `SubstandardContext` is the
  // object every substandard plugin receives, and it was undocumented while its
  // `network` field was both wrongly typed (`string`, not `Network`) and wrongly
  // computed (from `chain.id`, which is 0 for EVERY testnet). A plugin author
  // had no document to be misled by — and no document to be corrected by
  // either. Documenting it without pinning it would just restore the rot this
  // file exists for.
  const documented = documentedFields(read("docs/api-reference.md"), "SubstandardContext");
  const actual = sourceFields(read("src/substandards/interface.ts"), "SubstandardContext");

  assert.ok(actual.length > 3, "sanity: the parser found a real field list");

  const missing = actual.filter((f) => !documented.includes(f));
  const invented = documented.filter((f) => !actual.includes(f));

  assert.deepEqual(
    missing,
    [],
    `SubstandardContext fields exist but are UNDOCUMENTED: ${missing.join(", ")}. ` +
      `A plugin author reading the docs would not know they are there.`,
  );
  assert.deepEqual(
    invented,
    [],
    `docs describe SubstandardContext fields that DO NOT EXIST: ${invented.join(", ")}.`,
  );
});

test("the documented SubstandardContext.network is OPTIONAL and typed Network", () => {
  // ⚠ THE FIELD NAME SURVIVING IS NOT THE FACT THAT MATTERS HERE. The name
  // `network` was correct throughout the defect; what was wrong was its type
  // and the possibility of its absence. The name check above cannot see either,
  // so the two properties a plugin author must act on are asserted directly —
  // in the DOCS, because that is the artefact this file guards.
  const docs = read("docs/api-reference.md");
  const start = docs.indexOf("interface SubstandardContext {");
  assert.notEqual(start, -1, "the SubstandardContext fence is gone");
  const fence = docs.slice(start, docs.indexOf("```", start));

  assert.match(
    fence,
    /network\?: Network;/,
    "the documented field must be `network?: Network` — optional, and the union, not `string`",
  );
  assert.doesNotMatch(
    fence,
    /network\??: string;/,
    "`string` here is the looseness that let the value and the Network union disagree",
  );

  // And the prose must tell the reader what the absence MEANS, because
  // `undefined` with no explanation reads as an oversight to be defaulted away
  // — which is exactly how a devnet gets relabelled "preprod" by a consumer
  // instead of by us.
  assert.match(
    docs,
    /devnet[^.]*`undefined`|`undefined`[^.]*devnet/i,
    "the docs must say that a devnet (or any private network) yields undefined",
  );
  assert.match(
    docs,
    /network magic/i,
    "the docs must name the field the label is actually derived from",
  );
});
