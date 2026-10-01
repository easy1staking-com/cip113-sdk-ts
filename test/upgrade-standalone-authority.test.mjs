/**
 * Standing up an authority on its own — the workstream that made a
 * multisig → multisig handover impossible, and was invisible in the epic's
 * first draft until gate 3 named it.
 *
 * ⛔ WHY THE BOOTSTRAP'S OWN BUILDERS CANNOT DO THIS:
 *
 *   - `buildMultisigGenesisTx` requires a whole `BootstrapPlan`
 *     (`plan.addresses.upgradeMultisig`, `plan.assetUnits.upgradeMultisigNft`,
 *     and a cross-check against `plan.config.seeds.upgradeMultisig`). An
 *     operator rotating an authority has a `DeploymentParams` and a spare UTxO.
 *   - `buildStakeRegistrationTx` registers ALL SIX of a plan's stake credential
 *     scripts in one transaction. Using it to register one new authority would
 *     register five credentials belonging to a protocol that does not exist —
 *     and `upgrade_multisig.publish` admits only `RegisterCredential`, so
 *     deregistration is permanently closed and those deposits are gone.
 *
 * ⚑ AND ONE IMPROVEMENT OVER THE PLAN VERSION, not just a decoupling: the script
 * is parameterised from the SEED UTxO BEING SPENT rather than from a recorded
 * coordinate, so the hash and the outref cannot disagree. The failure the
 * bootstrap version has to cross-check for cannot arise here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildStandaloneMultisigGenesisTx,
  buildRegisterCredentialTx,
  multisigScriptDatum,
  EvoAssets,
  EvoData,
  EvoAddress,
} from "../dist/index.js";
import { createStandardScripts } from "../dist/standard/scripts.js";
import { h, utxo } from "./support/fes-rig.mjs";

const NETWORK_ID = 0;
const BP = JSON.parse(
  readFileSync(new URL("../blueprints/standard/v0.0.1/plutus.json", import.meta.url), "utf8"),
);
const sig = (k) => ({ type: "signature", keyHash: k });
const TREE = { type: "at-least", required: 2, scripts: [sig(h("e1")), sig(h("e2")), sig(h("e3"))] };

class RecorderStop extends Error {}
function makeClient() {
  const ops = [];
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return (arg) => {
        if (prop === "build") throw new RecorderStop("build reached");
        ops.push({ op: String(prop), arg });
        return builder;
      };
    },
  });
  return { ops, client: { chain: { id: NETWORK_ID }, newTx: () => builder,
    async getProtocolParameters() { return { coinsPerUtxoByte: 4310n }; } } };
}

const OWNER = "addr_test1vqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygxrcya6";
const WALLET = utxo({ address: OWNER, lovelace: 100_000_000n });
const SEED = utxo({ address: OWNER, lovelace: 10_000_000n, txHash: "f1".repeat(32), index: 2 });

async function genesis(overrides = {}) {
  const { ops, client } = makeClient();
  let error;
  try {
    await buildStandaloneMultisigGenesisTx({
      client, changeAddress: OWNER,
      availableUtxos: [WALLET], blueprint: BP, seedUtxo: SEED, tree: TREE, ...overrides,
    });
  } catch (e) { error = e; }
  return { ops, error };
}

async function register(credentials) {
  const { ops, client } = makeClient();
  let error;
  try {
    await buildRegisterCredentialTx({
      client, changeAddress: OWNER,
      availableUtxos: [WALLET], credentials,
    });
  } catch (e) { error = e; }
  return { ops, error };
}

const reached = (r) => r.error instanceof RecorderStop;
const refusedWith = (r, re, why) => {
  assert.ok(r.error instanceof Error, `${why}: must be refused`);
  assert.ok(!(r.error instanceof RecorderStop), `${why}: it BUILT instead of refusing`);
  assert.match(r.error.message, re, why);
};

// ---------------------------------------------------------------------------

test("the script is parameterised from the SEED UTxO BEING SPENT, so hash and outref cannot disagree", async () => {
  const r = await genesis();
  assert.ok(reached(r), `the genesis must build; got: ${r.error?.message}`);

  const expected = createStandardScripts(BP).upgradeMultisig({ txHash: "f1".repeat(32), outputIndex: 2 });
  const pay = r.ops.find((o) => o.op === "payToAddress").arg;
  const mint = r.ops.find((o) => o.op === "mintAssets").arg;
  const unit = EvoAssets.getUnits(mint.assets).find((u) => u !== "lovelace");
  assert.equal(unit.slice(0, 56), expected.hash, "the NFT policy is the script derived from THIS seed");
  // ⚠ `address.from_script(own_policy)` — rail 4. Asserted by rebuilding the
  // address from the derived hash, not by "is it non-empty", which was the first
  // thing written here and asserted nothing at all.
  const { scriptAddress } = await import("../dist/core/evo-utils.js");
  assert.equal(
    EvoAddress.toBech32(pay.address),
    scriptAddress(NETWORK_ID, expected.hash),
    "and the output is locked at that same script, wearing its spending hat",
  );
  assert.equal(
    Buffer.from(unit.slice(56), "hex").toString("utf-8"),
    "UpgradeMultisig",
    "with the token name the validator declares",
  );
});

test("RAIL: exactly one token, one output, and the NFT travels ALONE", async () => {
  const r = await genesis();
  const mint = r.ops.find((o) => o.op === "mintAssets").arg;
  const units = EvoAssets.getUnits(mint.assets).filter((u) => u !== "lovelace");
  assert.equal(units.length, 1, "exactly one token minted");
  assert.equal(EvoAssets.getByUnit(mint.assets, units[0]), 1n, "quantity one");

  const pays = r.ops.filter((o) => o.op === "payToAddress");
  assert.equal(pays.length, 1, "one output — `has_nft_strict` would not FIND a bundled one");
  const outUnits = EvoAssets.getUnits(pays[0].arg.assets).filter((u) => u !== "lovelace");
  assert.deepEqual(outUnits, units, "the NFT and nothing else");
  assert.ok(!("script" in pays[0].arg), "and NO reference script — rail 4 requires None");
});

test("the tree is the output's datum, and the seed is consumed", async () => {
  const r = await genesis();
  const pay = r.ops.find((o) => o.op === "payToAddress").arg;
  const data = pay.datum.data ?? pay.datum;
  assert.equal(
    Buffer.from(EvoData.toCBORBytes(data)).toString("hex"),
    Buffer.from(EvoData.toCBORBytes(multisigScriptDatum(TREE))).toString("hex"),
  );
  assert.equal(r.ops.filter((o) => o.op === "collectFrom").length, 1, "the one-shot seed is spent");
});

test("REFUSED: a malformed tree, before the seed is spent", async () => {
  refusedWith(await genesis({ tree: { type: "all-of", scripts: [] } }), /EMPTY child list|VACUOUSLY TRUE/,
    "AllOf [] is a permissionless authority");
  refusedWith(await genesis({ tree: { type: "at-least", required: 9, scripts: [sig(h("e1"))] } }),
    /required must satisfy/, "a threshold above the child count can never be met");
});

test("REFUSED: no seedUtxo, no tree, no blueprint — each named", async () => {
  refusedWith(await genesis({ seedUtxo: undefined }), /seedUtxo is required/, "the identity comes from it");
  refusedWith(await genesis({ tree: undefined }), /tree is required/, "no default authority");
  refusedWith(await genesis({ blueprint: undefined }), /blueprint is required/, "the body comes from it");
});

// ---------------------------------------------------------------------------

test("registration: one credential, one certificate, one witness", async () => {
  const script = createStandardScripts(BP).upgradeMultisig({ txHash: "f1".repeat(32), outputIndex: 2 });
  const r = await register([{ scriptHash: script.hash, compiledCode: script.compiledCode }]);
  assert.ok(reached(r), `registration must build; got: ${r.error?.message}`);
  assert.equal(r.ops.filter((o) => o.op === "registerStake").length, 1, "ONE credential — not the bootstrap's six");
  assert.equal(r.ops.filter((o) => o.op === "attachScript").length, 1, "a script registration carries its witness");
});

test("REFUSED: the same credential twice — the ledger calls that already-known", async () => {
  const script = createStandardScripts(BP).upgradeMultisig({ txHash: "f1".repeat(32), outputIndex: 2 });
  const one = { scriptHash: script.hash, compiledCode: script.compiledCode };
  refusedWith(await register([one, one]), /appears twice/, "code 3145, and the second entry buys nothing");
});

test("REFUSED: an empty list, a bad hash, or a missing body", async () => {
  refusedWith(await register([]), /must be non-empty/, "nothing to register");
  refusedWith(await register([{ scriptHash: "ab", compiledCode: "00" }]), /28-byte scriptHash/, "names no account");
  refusedWith(await register([{ scriptHash: h("aa"), compiledCode: "" }]), /needs its compiledCode/,
    "purpose=publish needs the witness");
});

test("the registration's message states the ORDERING rule a handover depends on", async () => {
  // ⛔ Withdrawals apply BEFORE certificates, so registering and withdrawing in
  // one transaction is two transactions. A handover is therefore a minimum of
  // four: config genesis, registration, nomination, promotion. If that is not
  // in the docstring the next caller rediscovers it as ledger code 3141.
  const src = readFileSync(new URL("../src/standard/upgrade.ts", import.meta.url), "utf8");
  assert.match(src, /STRICTLY EARLIER TRANSACTION/, "the rule is stated at the builder");
  assert.match(src, /3141/, "with the code it presents as");
  assert.match(src, /minimum of FOUR ordered/, "and the consequence for a handover");
});
