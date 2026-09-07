/**
 * min-UTxO is COMPUTED, not guessed.
 *
 * These pin the defect that prompted the change: a flat 3,000,000 on the CIP-68
 * (100) reference output is SHORT once the caller's metadata reaches the field
 * caps a consuming backend already documents (name 64, ticker 16, url 128,
 * logo 128, description 16). Nothing in this package caps those strings at all,
 * so the true ceiling is unbounded — the capped case is merely the smallest
 * reproduction, not the worst one.
 *
 * ⛔ WHY A SHORTFALL MATTERS RATHER THAN BEING ABSORBED. Evolution does NOT top
 * up an under-funded explicit output. MEASURED on preview 2026-09-01: building a
 * transaction whose datum-bearing output requested 3,000,000 produced a
 * transaction carrying exactly 3,000,000 — the amount is passed through
 * verbatim, and `calculateMinimumUtxoLovelace` is applied only to change and
 * unfracking outputs. The shortfall survives to submission, where the ledger
 * rejects it as "insufficient Ada" with a number and never as "your datum grew".
 *
 * The figures below are pinned against `coinsPerUtxoByte = 4310`, preview's live
 * value at the time of writing, so the arithmetic is reproducible offline. The
 * PRODUCTION path reads the parameter from the chain; a pinned parameter here
 * tests the computation, not the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  minUtxoForOutput,
  minUtxoAtLeast,
  ceilToWholeAda,
  outputAssets,
  voidData,
  buildCIP68FTDatum,
  labeledAssetName,
} from "../dist/index.js";

/** Preview's live value, pinned so these assertions are deterministic. */
const CPB = 4310n;

/** A programmable-token address: script payment credential + a stake key. */
const PLB_ADDR =
  "addr_test1zp0eae3pczvtuhf634als4ujvlxff8qe0m88ymd2p69ygmepntgnq9vjcmskkaxynvd3lrla7l58ug4gtj8x8wldf88synw3tp";

const POLICY = "321c339ba3f84177ce95b2b9ba6c9c6b148eb99707256f57fafba724";

/** Every CIP-68 field at the caps a consuming backend documents. */
const CAPPED_METADATA = {
  name: "N".repeat(64),
  ticker: "T".repeat(16),
  url: "https://" + "u".repeat(120),
  logo: "data:image/png;base64," + "L".repeat(106),
  description: "D".repeat(16),
  decimals: 6,
};

const refUnit = POLICY + labeledAssetName(100, "4645535445535431");

test("the reproducing case: flat 3 ADA is SHORT for a capped CIP-68 datum", () => {
  const need = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[refUnit, 1n]])),
    datum: buildCIP68FTDatum(CAPPED_METADATA),
    coinsPerUtxoByte: CPB,
  });

  // The whole point. If this ever stops being true the defect is gone and this
  // test should be REREAD, not deleted — the constant may simply have moved.
  assert.ok(
    need > 3_000_000n,
    `expected the capped-metadata requirement to exceed the old flat 3 ADA, got ${need}`,
  );
  // 12-byte asset name (4-byte CIP-67 label + an 8-byte name).
  assert.equal(need, 3_021_310n, "requirement at coinsPerUtxoByte=4310");
  assert.equal(ceilToWholeAda(need), 4_000_000n, "what the fixed path now pays");

  // The asset name is a SECOND caller-controlled axis on the same output, so
  // the worst case is both at once: a maximal 32-byte name adds a further
  // 90,510 lovelace. Pinned so the two axes stay separable.
  const needMaxName = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[POLICY + "ff".repeat(32), 1n]])),
    datum: buildCIP68FTDatum(CAPPED_METADATA),
    coinsPerUtxoByte: CPB,
  });
  assert.equal(needMaxName, 3_111_820n, "capped metadata + maximal asset name");
  assert.equal(needMaxName - need, 90_510n, "the asset-name axis, isolated");
});

test("ordinary metadata still fits inside the old constant — no regression", () => {
  const need = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[refUnit, 1n]])),
    datum: buildCIP68FTDatum({ name: "Acme Token", ticker: "ACME", decimals: 6 }),
    coinsPerUtxoByte: CPB,
  });
  assert.ok(need < 3_000_000n, `ordinary metadata should fit, needed ${need}`);

  // The floor is what keeps the change monotone: an ordinary token must still
  // emit exactly what it always did.
  assert.equal(
    minUtxoAtLeast(3_000_000n, {
      address: PLB_ADDR,
      assets: outputAssets(0n, new Map([[refUnit, 1n]])),
      datum: buildCIP68FTDatum({ name: "Acme Token", ticker: "ACME", decimals: 6 }),
      coinsPerUtxoByte: CPB,
    }),
    3_000_000n,
  );
});

test("the sibling defect: a 32-byte asset name outgrows the 1.3 ADA token floor", () => {
  const longUnit = POLICY + "ff".repeat(32);
  const need = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[longUnit, 1000n]])),
    datum: voidData(),
    coinsPerUtxoByte: CPB,
  });
  assert.ok(need > 1_300_000n, `expected a shortfall, needed ${need}`);
  assert.equal(need, 1_318_860n);

  // A short name is unaffected — which is why this was invisible.
  const shortUnit = POLICY + "465553";
  assert.ok(
    minUtxoForOutput({
      address: PLB_ADDR,
      assets: outputAssets(0n, new Map([[shortUnit, 1000n]])),
      datum: voidData(),
      coinsPerUtxoByte: CPB,
    }) < 1_300_000n,
  );
});

test("quantity magnitude moves the requirement too", () => {
  const unit = POLICY + "ff".repeat(32);
  const small = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[unit, 1000n]])),
    datum: voidData(),
    coinsPerUtxoByte: CPB,
  });
  const huge = minUtxoForOutput({
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[unit, 2n ** 63n - 1n]])),
    datum: voidData(),
    coinsPerUtxoByte: CPB,
  });
  assert.ok(huge > small, "a wider CBOR integer must raise the requirement");
  assert.equal(huge, 1_344_720n);
});

test("the computation is monotone in datum size", () => {
  const mk = (n) =>
    minUtxoForOutput({
      address: PLB_ADDR,
      assets: outputAssets(0n, new Map([[refUnit, 1n]])),
      datum: buildCIP68FTDatum({ name: "x".repeat(n) }),
      coinsPerUtxoByte: CPB,
    });
  let prev = 0n;
  for (const n of [1, 32, 64, 128, 256, 512]) {
    const v = mk(n);
    assert.ok(v > prev, `requirement must not fall as the datum grows (${n})`);
    prev = v;
  }
});

test("PROOF OF HARNESS: a smaller coinsPerUtxoByte lowers the requirement", () => {
  // Guards against the computation ignoring its parameter — a bug that would
  // leave every assertion above passing for the wrong reason.
  const args = {
    address: PLB_ADDR,
    assets: outputAssets(0n, new Map([[refUnit, 1n]])),
    datum: buildCIP68FTDatum(CAPPED_METADATA),
  };
  const atHalf = minUtxoForOutput({ ...args, coinsPerUtxoByte: CPB / 2n });
  const atFull = minUtxoForOutput({ ...args, coinsPerUtxoByte: CPB });
  assert.ok(atHalf < atFull, "the protocol parameter must be load-bearing");
});

test("ceilToWholeAda rounds up and leaves whole ADA alone", () => {
  assert.equal(ceilToWholeAda(1n), 1_000_000n);
  assert.equal(ceilToWholeAda(3_111_820n), 4_000_000n);
  assert.equal(ceilToWholeAda(4_000_000n), 4_000_000n);
  assert.equal(ceilToWholeAda(0n), 0n);
});

// ---------------------------------------------------------------------------
// dummy — the SAME defect, found second, in a second place
// ---------------------------------------------------------------------------

test("dummy's token outputs: the measured figures, pinned", () => {
  // ⚠ These numbers live in a comment above `dummySubstandard`. Pinning them
  // here keeps the comment honest: a prose table drifts silently, an assertion
  // does not. The shape is identical to FES's token outputs — PLB address, one
  // token, voidData — which is exactly why the figures match and why this was
  // ONE defect in two places rather than two defects.
  const DUMMY_POLICY = "864e759c0e1e6d315b6b48a08ad2f5b8b5eb7564bedb73cc83d9fd0b";
  const need = (nameHex, qty) =>
    minUtxoForOutput({
      address: PLB_ADDR,
      assets: outputAssets(0n, new Map([[DUMMY_POLICY + nameHex, qty]])),
      datum: voidData(),
      coinsPerUtxoByte: CPB,
    });

  // The live preview deployment's own asset name — comfortably inside the floor.
  assert.equal(need("44554d35954f", 1000n), 1_202_490n);
  assert.ok(1_300_000n - need("44554d35954f", 1000n) === 97_510n, "97,510 headroom");

  // …and the two cases that are genuinely short.
  assert.equal(need("ff".repeat(32), 1000n), 1_318_860n, "SHORT by 18,860");
  assert.equal(need("ff".repeat(32), (2n ** 63n) - 1n), 1_344_720n, "SHORT by 44,720");

  // The identity that made this a pattern rather than a one-off.
  assert.equal(
    need("ff".repeat(32), 1000n),
    minUtxoForOutput({
      address: PLB_ADDR,
      assets: outputAssets(0n, new Map([[POLICY + "ff".repeat(32), 1000n]])),
      datum: voidData(),
      coinsPerUtxoByte: CPB,
    }),
    "same output shape ⇒ same requirement, whichever substandard builds it",
  );
});
