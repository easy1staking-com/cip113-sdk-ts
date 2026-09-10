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

/** Top-level field names from a documented `interface X { ... }` fence. */
function documentedFields(markdown, interfaceName) {
  const start = markdown.indexOf(`interface ${interfaceName} {`);
  assert.notEqual(start, -1, `docs must still document ${interfaceName}`);
  const body = markdown.slice(start);
  const end = body.indexOf("\n}");
  assert.notEqual(end, -1, `${interfaceName} block must be closed`);

  const names = [];
  let depth = 0;
  for (const raw of body.slice(0, end).split("\n").slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    // Only take names at brace-depth 0 — nested object literals are inline here.
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m) names.push(m[1]);
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
  }
  return names;
}

/** Top-level field names of the real type, read from its source declaration. */
function sourceFields(ts, interfaceName) {
  const start = ts.indexOf(`export interface ${interfaceName} {`);
  assert.notEqual(start, -1, `${interfaceName} must exist in src`);
  const body = ts.slice(ts.indexOf("{", start) + 1);

  const names = [];
  let depth = 0;
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
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m) names.push(m[1]);
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
  }
  return names;
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
  const readme = read("README.md");
  assert.match(readme, /Migrating to 0\.8\.0/);
  assert.match(readme, /byte-identical/i, "must state that the stale redeemer still decodes");
  assert.match(readme, /SpendViaTransfer/, "must name the stale constructor");
  assert.match(readme, /dispatcher/i, "must say where wdrl_idx now points");
});

test("package version and the migration note agree", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.version, "0.8.0");
  assert.match(read("README.md"), new RegExp(`Migrating to ${pkg.version.replace(/\./g, "\\.")}`));
});
