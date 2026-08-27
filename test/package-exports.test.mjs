/**
 * Every declared export subpath must resolve to something that exists.
 *
 * ⚠ THE FAILURE THIS CATCHES SHIPPED FOR EVERY RELEASE UP TO 0.6.0.
 * `"./evolution": "./dist/provider/evolution-adapter.js"` was declared in the
 * initial release; the adapter layer was later removed and the entry was not.
 * `import "@easy1staking/cip113-sdk-ts/evolution"` has therefore failed with
 * ERR_MODULE_NOT_FOUND in every published version — and nothing noticed,
 * because `tsc` never reads the exports map, the tarball guard only checks what
 * must be ABSENT, and no test imported it.
 *
 * A declared entry point that cannot be imported is a promise the package
 * makes and cannot keep. The check is one stat per subpath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

test("package exports: every subpath target exists on disk", () => {
  const entries = Object.entries(pkg.exports ?? {});
  // Pinned: an exports map that silently emptied would otherwise pass a loop
  // over zero entries — the vacuous shape this repo keeps meeting.
  assert.ok(entries.length >= 4, `expected the full exports map, saw ${entries.length}`);

  for (const [subpath, target] of entries) {
    assert.equal(typeof target, "string", `${subpath}: conditional exports need their own check`);
    // A wildcard target is a directory prefix; assert the prefix, since the
    // matched files are the caller's choice.
    const onDisk = resolve(ROOT, target.replace(/\*.*$/, ""));
    assert.ok(existsSync(onDisk), `exports["${subpath}"] → ${target} does not exist`);
  }
});

test("package exports: every JS target is actually importable", async () => {
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (!target.endsWith(".js")) continue;
    // existsSync is not enough: a target present but broken at module scope
    // fails only for the consumer.
    await assert.doesNotReject(
      import(new URL(target, `file://${ROOT}/`).href),
      `exports["${subpath}"] → ${target} exists but does not import`
    );
  }
});
