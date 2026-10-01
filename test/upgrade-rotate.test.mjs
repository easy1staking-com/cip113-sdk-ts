/**
 * Signer rotation — `upgrade_multisig.spend`, the operation nothing in this
 * repo has ever built.
 *
 * ⛔ WHY IT HAD NO BUILDER AND STILL NEEDED ONE. PLAN A-3 has recorded
 * "multisig tree ROTATION is NOT exercised" since the alpha.4 migration, and
 * five places in `src/` document rotation in prose — `types.ts` calls the
 * recorded config coordinate mutable state *because* a rotation moves it. The
 * code to perform one existed nowhere. The validator has supported it since
 * `#125`: moving the signer set into a datum is what stopped every rotation
 * from being a new script, a new credential, and a full `upgrade_cred`
 * handover.
 *
 * ⛔ THE ONE MISTAKE WITH NO REPAIR PATH, which is why this file is mostly
 * refusals. The tree IS the authority. Write an unsatisfiable one and the config
 * UTxO can only be spent by satisfying the tree it now carries — so there is no
 * second attempt, on any timescale, by anyone. Upstream's `well_formed` refuses
 * the shapes it can (`AllOf []` is VACUOUSLY TRUE on chain, i.e. a
 * permissionless authority; `AtLeast` thresholds outside `1..n` can never be
 * met) and explicitly declines to refuse the rest: *"a `Before`-only tree is
 * open now and bricks itself later. That configuration is the authority's own
 * responsibility."*
 *
 * ⚠ SO THE REFUSALS SPLIT IN TWO, and conflating them would be the defect. The
 * SDK refuses what is PROVABLY fatal and what it cannot honestly build; it does
 * NOT refuse a legal tree whose risk is the authority's to take. Giovanni ruled
 * on this directly (2026-10-01): refuse only the provably fatal, no
 * chain-liveness requirement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRotateMultisigTx,
  locateUpgradeMultisig,
  multisigScriptDatum,
  satisfiesMultisigTree,
  upgradeMultisigAddress,
  EvoData,
  EvoAssets,
  EvoAddress,
} from "../dist/index.js";

import { h, utxo } from "./support/fes-rig.mjs";

const NETWORK_ID = 0;
const BP = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL("../blueprints/standard/v0.0.1/plutus.json", import.meta.url),
    "utf8",
  ),
);

// ---------------------------------------------------------------------------
// Fixtures — the deployment's multisig hash must be the one the blueprint
// actually parameterises, or the builder's own cross-check refuses first.
// ---------------------------------------------------------------------------

const SEED = { txHash: "a1".repeat(32), outputIndex: 3 };
const { createStandardScripts } = await import("../dist/standard/scripts.js");
const MS_SCRIPT = createStandardScripts(BP).upgradeMultisig(SEED);
const MS_HASH = MS_SCRIPT.hash;

const DEPLOYMENT = {
  protocolParams: { policyId: h("ab") },
  upgradeMultisig: { scriptHash: MS_HASH, txInput: SEED },
};

const MS_ADDR = upgradeMultisigAddress(NETWORK_ID, DEPLOYMENT);
const NFT_UNIT = MS_HASH + Buffer.from("UpgradeMultisig", "utf-8").toString("hex");
/** Junk bundled into the config UTxO — the value-conservation rail must carry it. */
const JUNK_UNIT = h("ef") + Buffer.from("Junk", "utf-8").toString("hex");

const sig = (k) => ({ type: "signature", keyHash: k });
const A = h("a1");
const B = h("a2");
const C = h("a3");
const D = h("b9");

const TWO_OF_THREE = { type: "at-least", required: 2, scripts: [sig(A), sig(B), sig(C)] };
const ROTATED = { type: "at-least", required: 2, scripts: [sig(A), sig(B), sig(D)] };

const configUtxo = (tree = TWO_OF_THREE, extra = {}) =>
  utxo({
    address: MS_ADDR,
    lovelace: 3_000_000n,
    units: { [NFT_UNIT]: 1n, [JUNK_UNIT]: 5n },
    datum: tree === null ? undefined : multisigScriptDatum(tree),
    ...extra,
  });

// ---------------------------------------------------------------------------
// A recorder that captures the tx SHAPING and stops at build()
// ---------------------------------------------------------------------------

class RecorderStop extends Error {}

function makeClient() {
  const ops = [];
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return (arg) => {
          if (prop === "build") throw new RecorderStop("recorder: build reached");
          ops.push({ op: String(prop), arg });
          return builder;
        };
      },
    },
  );
  return {
    ops,
    client: {
      chain: { id: NETWORK_ID },
      newTx: () => builder,
      async getProtocolParameters() {
        return { coinsPerUtxoByte: 4310n };
      },
    },
  };
}

const CTX = (client) => ({
  client,
  changeAddress: MS_ADDR,
  availableUtxos: [utxo({ address: MS_ADDR, lovelace: 50_000_000n })],
});

async function rotate(overrides = {}) {
  const { ops, client } = makeClient();
  const params = {
    ...CTX(client),
    blueprint: BP,
    deployment: DEPLOYMENT,
    configUtxo: configUtxo(),
    newTree: ROTATED,
    signerKeyHashes: [A, B],
    ...overrides,
  };
  let error;
  try {
    await buildRotateMultisigTx(params);
  } catch (e) {
    error = e;
  }
  return { ops, error };
}

const reached = (r) => r.error instanceof RecorderStop;
const refusedWith = (r, re, why) => {
  assert.ok(r.error instanceof Error, `${why}: must be refused`);
  assert.ok(!(r.error instanceof RecorderStop), `${why}: it BUILT instead of refusing`);
  assert.match(r.error.message, re, why);
};

// ---------------------------------------------------------------------------
// The positive — and what it asserts about the three value rails
// ---------------------------------------------------------------------------

test("builds a rotation: one continuing output at the config address, carrying the NEW tree", async () => {
  const r = await rotate();
  assert.ok(reached(r), `the rotation must build; got: ${r.error?.message}`);

  const pays = r.ops.filter((o) => o.op === "payToAddress");
  assert.equal(pays.length, 1, "RAIL 2: exactly one continuing output — the validator does `expect [cont]`");
  assert.equal(EvoAddress.toBech32(pays[0].arg.address), MS_ADDR, "at the config address");

  const datum = pays[0].arg.datum.data ?? pays[0].arg.datum;
  assert.equal(
    Buffer.from(EvoData.toCBORBytes(datum)).toString("hex"),
    Buffer.from(EvoData.toCBORBytes(multisigScriptDatum(ROTATED))).toString("hex"),
    "RAIL 5: the output datum IS the new tree",
  );
});

test("RAIL 3: EVERY non-lovelace asset is carried forward, not just the NFT", async () => {
  // ⛔ THE RAIL IS `expect_match_assets(cont.value, own_input.output.value)` — the
  // WHOLE non-ADA value, exactly. A builder that forwarded only the config NFT
  // would strip anything a third party had bundled into the UTxO and the
  // validator would refuse it, naming nothing about bundling. Anyone may pay to
  // a script address, so this is not hypothetical.
  const r = await rotate();
  const out = r.ops.find((o) => o.op === "payToAddress").arg;
  assert.equal(EvoAssets.getByUnit(out.assets, NFT_UNIT), 1n, "the config NFT continues");
  assert.equal(EvoAssets.getByUnit(out.assets, JUNK_UNIT), 5n, "and so does bundled junk");
  assert.equal(EvoAssets.lovelaceOf(out.assets), 3_000_000n, "lovelace carried forward unchanged");
});

test("the config UTxO is spent, the script is attached, and every named signer is required", async () => {
  const r = await rotate();
  const collected = r.ops.filter((o) => o.op === "collectFrom");
  assert.equal(collected.length, 1, "the config UTxO is the only script input");
  const signers = r.ops.filter((o) => o.op === "addSigner");
  assert.equal(signers.length, 2, "RAIL 1: both named signers become required_signers");
  assert.equal(r.ops.filter((o) => o.op === "attachScript").length, 1, "the script body is attached");
  assert.ok(!r.ops.some((o) => o.op === "readFrom"), "no reference input is needed for a rotation");
});

// ---------------------------------------------------------------------------
// Refusals — the provably fatal, and the honestly unbuildable
// ---------------------------------------------------------------------------

test("REFUSED: a tree byte-identical to the one on chain", async () => {
  const r = await rotate({ newTree: TWO_OF_THREE });
  refusedWith(r, /BYTE-IDENTICAL/, "a no-op rotation spends a UTxO and changes nothing");
  assert.match(r.error.message, /allowUnchangedTree/, "and names the opt-in");
  assert.match(r.error.message, /chain permits it/, "and admits the SDK is the stricter party");
});

test("CONTROL: the same rotation builds with allowUnchangedTree", async () => {
  // Proves the refusal is an opt-in, not a capability the SDK lacks.
  const r = await rotate({ newTree: TWO_OF_THREE, allowUnchangedTree: true });
  assert.ok(reached(r), `the opt-in must permit it; got: ${r.error?.message}`);
});

test("REFUSED: signers that do not satisfy the CURRENT tree — 1 of a 2-of-3", async () => {
  const r = await rotate({ signerKeyHashes: [A] });
  refusedWith(r, /do NOT satisfy the authority tree/, "a short quorum cannot rotate");
  assert.match(r.error.message, /empty trace list/, "names what the chain would have said instead");
  assert.ok(r.error.message.includes(A), "lists the signers named");
  assert.match(r.error.message, /must approve its replacement/, "and states the rail");
});

test("CONTROL: a different satisfying subset also rotates", async () => {
  // The preflight must not have hardcoded one answer: for at-least there are three.
  for (const pair of [[A, B], [B, C], [A, C]]) {
    const r = await rotate({ signerKeyHashes: pair });
    assert.ok(reached(r), `${pair.join("+")} satisfies 2-of-3; got: ${r.error?.message}`);
  }
});

test("REFUSED: a current tree with a SCRIPT leaf — unbuildable, not invalid", async () => {
  const withScript = {
    type: "any-of",
    scripts: [sig(A), { type: "script", scriptHash: h("7f") }],
  };
  const r = await rotate({ configUtxo: configUtxo(withScript), signerKeyHashes: [A] });
  refusedWith(r, /"script" leaf|script.*leaf kind/, "a script leaf needs another withdraw-0 marshalled in");
  assert.match(r.error.message, /must build this rotation itself/, "and says whose job it is");
});

test("REFUSED: a current tree with an AFTER leaf — no validity interval is set", async () => {
  const withAfter = { type: "all-of", scripts: [sig(A), { type: "after", time: 1n }] };
  const r = await rotate({ configUtxo: configUtxo(withAfter), signerKeyHashes: [A] });
  refusedWith(r, /before.*after|after.*leaf kind/, "a time leaf needs a validity interval");
  assert.match(r.error.message, /passes every offline check and fails on chain/, "the trap it avoids");
});

test("REFUSED: a malformed NEW tree, by the encoder's port of well_formed", async () => {
  const cases = [
    [{ type: "at-least", required: 0, scripts: [sig(A)] }, /required must satisfy/, "threshold 0 authorises with no evidence"],
    [{ type: "at-least", required: 2, scripts: [sig(A)] }, /required must satisfy/, "threshold above the child count can never be met"],
    [{ type: "all-of", scripts: [] }, /EMPTY child list|VACUOUSLY TRUE/, "AllOf [] is a permissionless authority"],
    [{ type: "signature", keyHash: "ab" }, /28 bytes/, "a short hash can never match a signatory"],
  ];
  for (const [tree, re, why] of cases) {
    const r = await rotate({ newTree: tree });
    refusedWith(r, re, why);
  }
});

test("REFUSED: a config UTxO that does not carry this deployment's NFT", async () => {
  const foreign = utxo({ address: MS_ADDR, units: { [JUNK_UNIT]: 1n }, datum: multisigScriptDatum(TWO_OF_THREE) });
  const r = await rotate({ configUtxo: foreign });
  refusedWith(r, /carries no asset of policy/, "the wrong UTxO rotates nothing");
});

test("REFUSED: a config UTxO with no datum — there is no tree to satisfy", async () => {
  const r = await rotate({ configUtxo: configUtxo(null) });
  refusedWith(r, /no inline datum/, "and such a UTxO cannot be spent at all");
});

test("REFUSED: a blueprint/deployment mismatch is caught before anything is spent", async () => {
  const wrong = { ...DEPLOYMENT, upgradeMultisig: { ...DEPLOYMENT.upgradeMultisig, txInput: { txHash: "b2".repeat(32), outputIndex: 0 } } };
  const r = await rotate({ deployment: wrong });
  refusedWith(r, /different protocol instance/, "a one-shot hash is a function of its seed");
});

test("REFUSED: signerKeyHashes empty, or not 28 bytes", async () => {
  refusedWith(await rotate({ signerKeyHashes: [] }), /required and must be non-empty/, "nothing to infer");
  refusedWith(await rotate({ signerKeyHashes: ["ab"] }), /56 hex/, "a wrong-length hash matches nothing");
});

test("REFUSED: no configUtxo, and the message says not to use the recorded coordinate", async () => {
  const r = await rotate({ configUtxo: undefined });
  refusedWith(r, /configUtxo is required/, "it must come from a fresh read");
  assert.match(r.error.message, /every rotation moves it/, "and why the record is not it");
});

// ---------------------------------------------------------------------------
// The preflight, directly — a port of `satisfied`, including its False arms
// ---------------------------------------------------------------------------

test("satisfiesMultisigTree mirrors upstream `satisfied`, including the unbounded-interval arms", () => {
  const ev = (signatories, extra = {}) => ({ signatories, ...extra });

  assert.equal(satisfiesMultisigTree(sig(A), ev([A])), true);
  assert.equal(satisfiesMultisigTree(sig(A), ev([B])), false);
  assert.equal(satisfiesMultisigTree(sig(A.toUpperCase()), ev([A])), true, "hex case is not significance");

  const allOf = { type: "all-of", scripts: [sig(A), sig(B)] };
  assert.equal(satisfiesMultisigTree(allOf, ev([A, B])), true);
  assert.equal(satisfiesMultisigTree(allOf, ev([A])), false);

  const anyOf = { type: "any-of", scripts: [sig(A), sig(B)] };
  assert.equal(satisfiesMultisigTree(anyOf, ev([B])), true);
  assert.equal(satisfiesMultisigTree(anyOf, ev([C])), false);

  assert.equal(satisfiesMultisigTree(TWO_OF_THREE, ev([A, C])), true, "2 of 3");
  assert.equal(satisfiesMultisigTree(TWO_OF_THREE, ev([C])), false, "1 of 3");
  assert.equal(satisfiesMultisigTree(TWO_OF_THREE, ev([A, B, C])), true, "3 of 3");

  const scriptLeaf = { type: "script", scriptHash: h("7f") };
  assert.equal(satisfiesMultisigTree(scriptLeaf, ev([], { withdrawalScriptHashes: [h("7f")] })), true);
  assert.equal(satisfiesMultisigTree(scriptLeaf, ev([h("7f")])), false, "a SIGNATURE is not a withdrawal");

  // ⛔ THE ARMS THAT RETURN FALSE RATHER THAN TRUE. Upstream's Before/After end
  // in `_ -> False`, so an infinite bound satisfies NEITHER. Reading an absent
  // bound as "unbounded, therefore fine" is the inversion that would make this
  // port say yes where the chain says no.
  const after = { type: "after", time: 100n };
  assert.equal(satisfiesMultisigTree(after, ev([])), false, "no interval at all is NOT satisfaction");
  assert.equal(
    satisfiesMultisigTree(after, ev([], { validityRange: { lowerBound: { time: 100n, inclusive: true } } })),
    true,
  );
  assert.equal(
    satisfiesMultisigTree(after, ev([], { validityRange: { lowerBound: { time: 99n, inclusive: true } } })),
    false,
    "the lower bound must be at or after the leaf's time",
  );
  const before = { type: "before", time: 100n };
  assert.equal(satisfiesMultisigTree(before, ev([])), false);
  assert.equal(
    satisfiesMultisigTree(before, ev([], { validityRange: { upperBound: { time: 100n, inclusive: true } } })),
    true,
  );
  assert.equal(
    satisfiesMultisigTree(before, ev([], { validityRange: { upperBound: { time: 101n, inclusive: true } } })),
    false,
  );
});

test("the preflight only ever REFUSES — a true grants nothing", () => {
  // The function is a second implementation of an on-chain rule and can drift.
  // Its contract is one-directional, and this pins the direction: the builder
  // consults it to block, never to permit. Proven by the CONTROL tests above —
  // every one of them still had to pass every other rail.
  const satisfied = satisfiesMultisigTree(TWO_OF_THREE, { signatories: [A, B] });
  assert.equal(satisfied, true);
  assert.equal(typeof satisfied, "boolean", "no structured verdict a caller could mistake for authority");
});
