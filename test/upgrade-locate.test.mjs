/**
 * Locating a protocol's governable state — the two UTxOs every upgrade reads.
 *
 * ⛔ THE DEFECT THIS FILE EXISTS FOR, and it would have shipped. The working
 * version of this lookup lives in `test/harness/upgrade.ts` and begins:
 *
 *     if (atAddress.length < 2) throw new Error(
 *       `...the bootstrap parks a decoy beside the config UTxO so the policy
 *        filter below is exercised. With fewer than 2 there is nothing to
 *        discriminate and this lookup proves nothing.`)
 *
 * That is a true statement about a DEVNET FIXTURE and a false requirement of a
 * real deployment. Nothing obliges a production protocol to have junk parked
 * beside its config UTxO — least of all mainnet, where there is no bootstrap
 * harness to park anything. Exported verbatim it would refuse every clean
 * deployment, and it would do so with a message about a decoy the operator has
 * never heard of. `SINGLE UTXO` below is the regression test; it is the reason
 * this file is worth more than the function it covers.
 *
 * ⚠ AND THE DECOY IT NAMES WAS MEASURED NON-LOAD-BEARING. The harness's own
 * comment records it (audit r1 A2a): the parked decoy carries lovelace only, so
 * deleting the `=== policy` comparison leaves the suite green, because "has any
 * native asset" discriminates identically. This file fixes that by giving the
 * junk a FOREIGN-POLICY asset, which makes the policy comparison the only thing
 * separating the two — proven by mutation M1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  locateProtocolParams,
  locateUpgradeMultisig,
  protocolParamsAddress,
  upgradeMultisigAddress,
  multisigScriptDatum,
  protocolParamsDatum,
  PROTOCOL_PARAMS_TOKEN_NAME,
  UPGRADE_MULTISIG_TOKEN_NAME,
} from "../dist/index.js";

import { h, utxo } from "./support/fes-rig.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = 0;
const PP_POLICY = h("ab");
const MS_HASH = h("cd");
/** A policy that is NOT either of ours — what makes the policy filter load-bearing. */
const FOREIGN_POLICY = h("ef");

const DEPLOYMENT = {
  protocolParams: { policyId: PP_POLICY },
  upgradeMultisig: { scriptHash: MS_HASH },
};

const hexName = (s) => Buffer.from(s, "utf-8").toString("hex");
const PP_UNIT = PP_POLICY + hexName(PROTOCOL_PARAMS_TOKEN_NAME);
const MS_UNIT = MS_HASH + hexName(UPGRADE_MULTISIG_TOKEN_NAME);

const PP_ADDR = protocolParamsAddress(NETWORK_ID, DEPLOYMENT);
const MS_ADDR = upgradeMultisigAddress(NETWORK_ID, DEPLOYMENT);

const scriptCred = (hash) => ({ type: "script", hash });
const PARAMS = {
  plgCred: scriptCred(h("01")),
  issuanceLogicCred: scriptCred(h("02")),
  transferCred: scriptCred(h("03")),
  thirdPartyCred: scriptCred(h("04")),
  upgradeCred: scriptCred(MS_HASH),
  pendingUpgradeCred: null,
};
const PARAMS_DATUM = protocolParamsDatum(PARAMS);

/** A 2-of-3 tree — the shape W-G rotates, and one no bootstrap would "expect". */
const TREE = {
  type: "at-least",
  required: 2,
  scripts: [
    { type: "signature", keyHash: h("a1") },
    { type: "signature", keyHash: h("a2") },
    { type: "signature", keyHash: h("a3") },
  ],
};
const TREE_DATUM = multisigScriptDatum(TREE);

const ppUtxo = (extra = {}) =>
  utxo({ address: PP_ADDR, units: { [PP_UNIT]: 1n }, datum: PARAMS_DATUM, ...extra });
const msUtxo = (extra = {}) =>
  utxo({ address: MS_ADDR, units: { [MS_UNIT]: 1n }, datum: TREE_DATUM, ...extra });

/** Junk anyone may pay to a script address — carrying a FOREIGN native asset. */
const foreignJunk = (address) =>
  utxo({ address, units: { [FOREIGN_POLICY + hexName("NotOurs")]: 7n } });
/** Junk with no native assets at all. */
const lovelaceJunk = (address) => utxo({ address });

const locatePP = (utxosAtAddress) =>
  locateProtocolParams({ deployment: DEPLOYMENT, utxosAtAddress, networkId: NETWORK_ID });
const locateMS = (utxosAtAddress) =>
  locateUpgradeMultisig({ deployment: DEPLOYMENT, utxosAtAddress, networkId: NETWORK_ID });

// ---------------------------------------------------------------------------
// THE REGRESSION: a clean deployment has no decoy, and must still be readable
// ---------------------------------------------------------------------------

test("SINGLE UTXO — an address holding ONLY the config UTxO is located, not refused", () => {
  // The harness refuses this with `atAddress.length < 2`. A real deployment —
  // and every mainnet deployment — looks exactly like this.
  const found = locateMS([msUtxo()]);
  assert.deepEqual(found.tree, TREE, "the tree is read off the one UTxO present");
  assert.equal(found.ref.outputIndex, 0);
});

test("SINGLE UTXO — the same for the protocol-params UTxO", () => {
  const found = locatePP([ppUtxo()]);
  assert.deepEqual(found.params.upgradeCred, scriptCred(MS_HASH));
  assert.equal(found.params.pendingUpgradeCred, null);
});

// ---------------------------------------------------------------------------
// The policy filter, made load-bearing
// ---------------------------------------------------------------------------

test("the config UTxO is picked out from junk carrying a FOREIGN-POLICY asset", () => {
  // ⛔ THE ASSET MATTERS. With lovelace-only junk, "has any native asset"
  // discriminates identically and the policy comparison is dead code that
  // mutation cannot kill — which is exactly what was measured of the devnet
  // decoy. A foreign policy makes the comparison the only discriminator.
  const found = locateMS([lovelaceJunk(MS_ADDR), foreignJunk(MS_ADDR), msUtxo(), foreignJunk(MS_ADDR)]);
  assert.deepEqual(found.tree, TREE);
});

test("the params UTxO is picked out from junk carrying a FOREIGN-POLICY asset", () => {
  const found = locatePP([foreignJunk(PP_ADDR), ppUtxo(), lovelaceJunk(PP_ADDR)]);
  assert.deepEqual(found.params.transferCred, scriptCred(h("03")));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("REFUSED: no UTxO carries the policy — names the address and lists what was passed in", () => {
  let err;
  try {
    locateMS([lovelaceJunk(MS_ADDR), foreignJunk(MS_ADDR)]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "an absent NFT must be refused");
  assert.match(err.message, /no UTxO at/, "says what is missing");
  assert.ok(err.message.includes(MS_ADDR), "names the ADDRESS it searched");
  assert.ok(err.message.includes(MS_HASH), "names the POLICY it searched for");
  assert.match(err.message, /one-shot/, "and why absence is conclusive");
  assert.match(err.message, /stale|different address/, "and the likely causes");
  assert.match(err.message, /2 UTxO\(s\) you passed in hold/, "and reports the actual input");
  assert.ok(
    err.message.includes(UPGRADE_MULTISIG_TOKEN_NAME),
    "and names the asset name, as a hint rather than as the lookup key",
  );
});

test("REFUSED: TWO UTxOs carry the policy — a state the validators cannot produce", () => {
  let err;
  try {
    locateMS([msUtxo(), msUtxo({ index: 1 })]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "two NFT holders must be refused, never picked between");
  assert.match(err.message, /2 UTxOs .* carry an asset of policy/);
  assert.match(err.message, /exactly one must/);
  assert.match(err.message, /mixes two deployments|not what it is taken to be/);
});

test("REFUSED: the config UTxO carries no inline datum — the tree IS the authority", () => {
  let err;
  try {
    locateMS([msUtxo({ datum: undefined })]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match(err.message, /NO\s+INLINE DATUM/);
  assert.match(err.message, /no repair path/, "the consequence, which is the point");
  assert.match(err.message, /withdraw/, "and which handler needs it");
});

test("REFUSED: the params UTxO carries no inline datum", () => {
  let err;
  try {
    locatePP([ppUtxo({ datum: undefined })]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.match(err.message, /NO INLINE\s+DATUM/);
  assert.match(err.message, /cannot be produced by the validators/, "it is an impossible state");
});

// ---------------------------------------------------------------------------
// The operator/bootstrap asymmetry
// ---------------------------------------------------------------------------

test("NO EXPECTATION IS REQUIRED — a tree nobody predicted is returned, not refused", () => {
  // ⛔ THE DIFFERENCE FROM `assertMultisigConfigUtxo`, which demands an
  // `expectedTree` and refuses a mismatch. That is right for a BOOTSTRAP, which
  // knows what it just minted. It is unusable for an OPERATOR, who reads a live
  // authority precisely because they do not know what it holds — and after a
  // rotation the tree is whatever the last rotation wrote.
  const rotated = {
    type: "at-least",
    required: 2,
    scripts: [
      { type: "signature", keyHash: h("a1") },
      { type: "signature", keyHash: h("a2") },
      { type: "signature", keyHash: h("b9") }, // a3 rotated out, b9 in
    ],
  };
  const found = locateMS([msUtxo({ datum: multisigScriptDatum(rotated) })]);
  assert.deepEqual(found.tree, rotated, "whatever is on chain is the answer");
  assert.notDeepEqual(found.tree, TREE, "and it is NOT the bootstrap's tree");
});

test("a standing nomination is read back, so a promotion can be built from it", () => {
  const nominated = protocolParamsDatum({ ...PARAMS, pendingUpgradeCred: scriptCred(h("99")) });
  const found = locatePP([ppUtxo({ datum: nominated })]);
  assert.deepEqual(found.params.pendingUpgradeCred, scriptCred(h("99")));
  assert.deepEqual(found.params.upgradeCred, scriptCred(MS_HASH), "and the sitting authority is unmoved");
});

// ---------------------------------------------------------------------------
// Purity — the constitution's requirement, asserted rather than assumed
// ---------------------------------------------------------------------------

test("PURE: neither locator reaches the network", () => {
  // ⛔ WHY THIS IS A TEST AND NOT A COMMENT. The harness original read the chain
  // itself (`client.getUtxos`), signed, submitted and awaited. The reshape into
  // exported surface is only honest if the absence of a chain read is checked:
  // a later edit that reintroduces one would otherwise pass every test above.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("a locator must not reach the network");
  };
  try {
    locateMS([msUtxo()]);
    locatePP([ppUtxo()]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0, "no locator may perform a chain read — the caller supplies the UTxOs");
});

test("the addresses are DERIVED from the policy, so they cannot drift from it", () => {
  // One hash, two roles: the NFT policy id and the address's payment credential
  // are the same value by the validator's construction, so there is no second
  // field to record and nothing to keep in sync.
  assert.notEqual(PP_ADDR, MS_ADDR);
  assert.equal(protocolParamsAddress(NETWORK_ID, DEPLOYMENT), PP_ADDR, "deterministic");
  assert.notEqual(
    protocolParamsAddress(1, DEPLOYMENT),
    PP_ADDR,
    "and network-dependent — a mainnet address must not equal a testnet one",
  );
});
