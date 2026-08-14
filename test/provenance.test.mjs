/**
 * Provenance guard — offline, no network.
 *
 * Every bundled blueprint must carry an UPSTREAM_PIN.json whose recorded
 * sha256 matches the artifact actually on disk, and whose `declares` block
 * matches what the artifact says about itself.
 *
 * This is what stops a blueprint being swapped, regenerated or hand-edited
 * without the change being recorded. The dev/bafin-substandard branch replaced
 * the standard blueprint in place under an unchanged v0.3.0 directory name;
 * four of eight validator hashes moved and nothing recorded it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PINNED = [
  "blueprints/standard/v0.3.0",
  "blueprints/substandards/freeze-and-seize/v0.1.0",
  "blueprints/substandards/dummy/v0.1.0",
];

for (const dir of PINNED) {
  test(`${dir} — pin matches artifact`, () => {
    const pin = JSON.parse(readFileSync(resolve(ROOT, dir, "UPSTREAM_PIN.json"), "utf-8"));
    const raw = readFileSync(resolve(ROOT, dir, pin.artifact));

    const actual = createHash("sha256").update(raw).digest("hex");
    assert.equal(
      actual,
      pin.sha256,
      `${dir}/${pin.artifact} changed without its UPSTREAM_PIN.json being updated. ` +
      `If the change is intentional, update the pin AND record why in its verified.findings.`
    );

    const bp = JSON.parse(raw.toString("utf-8"));
    assert.equal(bp.preamble.title, pin.declares.title, `${dir}: preamble title drifted from pin`);
    assert.equal(bp.preamble.version, pin.declares.version, `${dir}: preamble version drifted from pin`);
    assert.equal(
      `${bp.preamble.compiler.name} ${bp.preamble.compiler.version}`,
      pin.declares.compiler,
      `${dir}: compiler drifted from pin`
    );
    assert.equal(bp.validators.length, pin.declares.validators, `${dir}: validator count drifted from pin`);
  });
}

test("every pinned blueprint declares its provenance status honestly", () => {
  for (const dir of PINNED) {
    const pin = JSON.parse(readFileSync(resolve(ROOT, dir, "UPSTREAM_PIN.json"), "utf-8"));
    assert.ok(
      ["VERIFIED", "UNVERIFIED", "UNKNOWN"].includes(pin.provenance),
      `${dir}: provenance must be one of VERIFIED / UNVERIFIED / UNKNOWN`
    );
    // A pin claiming VERIFIED must name the upstream commit that produced it.
    if (pin.provenance === "VERIFIED") {
      assert.ok(pin.upstream.commit, `${dir}: provenance VERIFIED requires an upstream.commit`);
      assert.equal(pin.blueprint_reproduced, true, `${dir}: VERIFIED requires blueprint_reproduced`);
    }
  }
});
