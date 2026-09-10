/**
 * The CIP-68 inline-datum bound, measured — and the half nobody tests.
 *
 * alpha.4 NEWLY bounds the datum of a CIP-68 mint. Upstream at `d37ca8d`,
 * `lib/assets.ak :: is_seizable_output_shape_bounded` reads:
 *
 *     InlineDatum(d) ->
 *       bytearray.length(builtin.serialise_data(d)) <= max_inline_datum_bytes
 *
 * and the doc block above it marks the old issuance exemption "(expired)",
 * naming "CIP-68 reference tokens minted with data-URI logos" as the standing
 * example of a kilobyte datum born at mint. This is not a relocated rule.
 *
 * ⛔ THE OPERATOR-FACING RISK IS THE GATE THAT CANNOT BE OPENED, not the one
 * that leaks. A bound one byte too strict removes CIP-68 from this SDK with no
 * incident, no log and no corruption — only a capability that quietly does not
 * exist, which nobody investigates because nothing bad happens. The on-chain
 * rule is `<=`; a `<` here looks like safety and is a silent capability
 * removal. That is why the ACCEPTANCE case below is load-bearing and the
 * refusal cases are the easy half.
 *
 * ⚠ NOTHING HERE IS ON-CHAIN EVIDENCE. Every figure is produced by Evolution's
 * `Data.toCBORBytes`; the chain measures with Plutus's `serialise_data`. Two
 * encoders. Only the conservative direction is safe — the SDK must measure ≥
 * the chain — and that direction is settled by the devnet at-bound SUCCESS in
 * T-F04-4, not by this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EvoData, buildCIP68FTDatum } from "../dist/index.js";

// The two helpers under test are NOT re-exported from the package root: the
// root barrel is outside this slice and they have no caller yet, by design.
// Imported as a NAMESPACE deliberately — a named import of a missing export is
// a module-LOAD error, which would take the size pins and the fixture control
// down with it and destroy the fail-first evidence this file exists to record.
import * as evo from "../dist/core/evo-utils.js";

/**
 * The fixture bound. D-17 keeps the deployed value at 1024; this file pins the
 * BEHAVIOUR at whatever bound it is handed, not the number itself (see "the
 * bound is READ, not hardcoded").
 */
const MAX = 1024;

/** Measured the way the pins are stated — directly, without the helper. */
const directBytes = (meta) => EvoData.toCBORBytes(buildCIP68FTDatum(meta)).length;

/** An ordinary token record: a few short fields. */
const SIMPLE = { name: "Acme Token", ticker: "ACME", decimals: 6 };

/**
 * Every CIP-68 field at the caps a consuming backend documents. Copied from
 * `min-utxo.test.mjs` by SHAPE — deliberately not imported, so neither file can
 * silently move the other's measurement.
 */
const CAPPED = {
  name: "N".repeat(64),
  ticker: "T".repeat(16),
  url: "https://" + "u".repeat(120),
  logo: "data:image/png;base64," + "L".repeat(106),
  description: "D".repeat(16),
  decimals: 6,
};

/**
 * The boundary pair, ONE CHARACTER APART — the sharpest discriminator
 * available. 958/959/960 description characters land on 1023/1024/1025 bytes.
 */
const atBoundMeta = (n) => ({ name: "AtBound", description: "D".repeat(n) });
const UNDER = atBoundMeta(958); // 1023 — one byte under
const AT = atBoundMeta(959); // 1024 — exactly at
const OVER = atBoundMeta(960); // 1025 — one byte over

// ---------------------------------------------------------------------------
// 1. The size pins
// ---------------------------------------------------------------------------

test("the size pins: what buildCIP68FTDatum actually serialises to", () => {
  assert.equal(directBytes(SIMPLE), 46, "an ordinary three-field record");

  // ⚑ THE ROW THAT CORRECTS THE ALARM. A record with EVERY field at a
  // documented cap is 419 bytes — it fits under 1024 with 605 bytes to spare.
  // The bound therefore bites on an EMBEDDED DATA-URI IMAGE, not on ordinary
  // metadata. The migration note (T-F05) must say so, or it reads as an alarm
  // nobody can reproduce: a caller with capped fields cannot trip this bound
  // however hard they try.
  assert.equal(directBytes(CAPPED), 419, "every field at a documented cap");
  assert.ok(419 + 605 === MAX, "the capped record's headroom under the bound");

  assert.equal(directBytes(UNDER), 1023, "one byte under the bound");
  assert.equal(directBytes(AT), 1024, "exactly at the bound");
  assert.equal(directBytes(OVER), 1025, "one byte over the bound");
});

test("inlineDatumBytes reports the same number the pins were measured with", () => {
  for (const [label, meta] of [
    ["SIMPLE", SIMPLE],
    ["CAPPED", CAPPED],
    ["UNDER", UNDER],
    ["AT", AT],
    ["OVER", OVER],
  ]) {
    assert.equal(
      evo.inlineDatumBytes(buildCIP68FTDatum(meta)),
      directBytes(meta),
      `inlineDatumBytes disagrees with a direct Data.toCBORBytes on ${label}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The gate OPENS — the load-bearing half
// ---------------------------------------------------------------------------

/**
 * THE FIXTURE CONTROL, and it is GREEN ON THE UNMODIFIED BASE by construction:
 * it measures only `buildCIP68FTDatum` and `Data.toCBORBytes`, both of which
 * already exist. If THIS is ever red, the fixture has drifted off the boundary
 * and the acceptance test below is testing a comfortable interior point rather
 * than the bound — which is exactly the way an at-bound test stops being one
 * without anybody noticing.
 */
test("the at-bound fixture sits EXACTLY on the bound (fixture control)", () => {
  assert.equal(directBytes(AT), MAX, "the at-bound fixture is not at the bound");
  assert.equal(directBytes(OVER), MAX + 1, "the over-bound fixture is not one byte over");
  assert.equal(directBytes(UNDER), MAX - 1, "the under-bound fixture is not one byte under");
});

/**
 * ⛔ THE GATE OPENS. A datum measuring EXACTLY `maxInlineDatumBytes` is
 * ACCEPTED, because the on-chain rule is `<=` and not `<`.
 *
 * This is the direction nobody tests: a gate that cannot be opened FAILS SAFE,
 * so it produces no incident to investigate — the caller simply concludes that
 * CIP-68 registration does not work, and that reading is unfalsifiable from
 * outside. Every closing-direction test in this file stays green under a `<`.
 * This one does not.
 */
test("THE GATE OPENS: a datum measuring exactly the bound is ACCEPTED", () => {
  assert.doesNotThrow(
    () => evo.assertInlineDatumWithinBound(buildCIP68FTDatum(AT), MAX, "CIP-68 (100) reference datum"),
    "a datum of exactly maxInlineDatumBytes must be ACCEPTED — the rule is <=, not <",
  );
});

// ---------------------------------------------------------------------------
// 3. The gate CLOSES, one byte over
// ---------------------------------------------------------------------------

test("THE GATE CLOSES: one byte over the bound is refused, by name", () => {
  assert.throws(
    () => evo.assertInlineDatumWithinBound(buildCIP68FTDatum(OVER), MAX, "CIP-68 (100) reference datum"),
    (err) => {
      assert.ok(err instanceof Error, "expected an Error");
      const m = err.message;
      // The message content is CONTRACTED, so it is pinned rather than
      // eyeballed: the parameter a caller has to go and change, the size that
      // was measured, and the bound it exceeded.
      assert.ok(
        m.includes("maxInlineDatumBytes"),
        `refusal must name the parameter 'maxInlineDatumBytes'; got: ${m}`,
      );
      assert.ok(m.includes("1025"), `refusal must state the MEASURED size 1025; got: ${m}`);
      assert.ok(m.includes("1024"), `refusal must state the BOUND 1024; got: ${m}`);
      assert.ok(
        m.includes("CIP-68 (100) reference datum"),
        `refusal must name WHAT was measured; got: ${m}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. The bound is READ, not hardcoded
// ---------------------------------------------------------------------------

/**
 * The same fixture, two bounds, opposite verdicts. A deployment is free to be
 * parameterised with a different bound, and a helper that quietly compares
 * against 1024 would enforce THIS repo's fixture value against SOMEBODY ELSE'S
 * protocol. Only throw/no-throw is asserted here, so this test stays
 * independent of the refusal message's wording.
 */
test("the bound is READ from the argument, not hardcoded", () => {
  const atBound = buildCIP68FTDatum(AT); // 1024 bytes

  assert.throws(
    () => evo.assertInlineDatumWithinBound(atBound, 1023, "CIP-68 (100) reference datum"),
    "1024 bytes must be refused against a bound of 1023",
  );
  assert.doesNotThrow(
    () => evo.assertInlineDatumWithinBound(atBound, 2048, "CIP-68 (100) reference datum"),
    "1024 bytes must be accepted against a bound of 2048",
  );
});

// ---------------------------------------------------------------------------
// 5. The instrument responds to a change we control
// ---------------------------------------------------------------------------

/**
 * An instrument that returns a stable, plausible number regardless of its input
 * does not fail — it reports. Before trusting `inlineDatumBytes` to tell us a
 * datum is small enough, prove it can SEE the datum at all.
 */
test("inlineDatumBytes responds to a change we control", () => {
  const shorter = evo.inlineDatumBytes(buildCIP68FTDatum(atBoundMeta(40)));
  const longer = evo.inlineDatumBytes(buildCIP68FTDatum(atBoundMeta(41)));

  assert.ok(
    longer >= shorter + 1,
    `one more metadata character must raise the reported size by at least one; got ${shorter} then ${longer}`,
  );
});
