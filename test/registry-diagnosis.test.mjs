/**
 * "Registry node not found" — TRUE, AND IT NAMED ONLY THE SYMPTOM.
 *
 * ⛔ THE CAUSE IT COULD NOT EXPRESS, and the one actually hit in the field
 * (CIP-113 on preprod, 2026-09-30): a programmable token's policy id IS the
 * hash of `issuance_mint` parameterised by the deployment it was minted under.
 * The token is therefore DEPLOYMENT-BOUND — its registry node lives in that
 * deployment's directory, and freeze-and-seize's transfer credential derives
 * from that deployment's `programmable_logic_base` hash. A protocol
 * re-bootstrap produces a NEW directory which does not contain it, and there is
 * no repointing.
 *
 * ⚠ WHY THAT READING MUST BE IN THE MESSAGE RATHER THAN IN A DOC. It is
 * invisible to every other check: the token exists, its UTxOs exist, the holder
 * holds them, and every credential the transaction derives is correct FOR THE
 * OTHER DEPLOYMENT. The old sentence reads as "your token does not exist",
 * which is the one thing that is false. Observed consequence: an SDK caller and
 * an independent Java caller failed on the same token, which looks like two
 * defects and is one configuration fact.
 *
 * ⚠ AND WHAT THE MESSAGE MUST NOT DO: pick a cause. An absent node is equally
 * what a never-registered token, a re-bootstrapped deployment and a lagging
 * indexer all look like. All three readings are stated; the SDK cannot tell
 * them apart from one directory read, and a message that chose would be
 * confidently wrong a third of the time.
 *
 * ⛔ THE ASSERTION THAT CARRIES THIS FILE is the EMPTY / POPULATED split. The
 * two diagnoses differ — an empty read means "not bootstrapped, wrong address,
 * or stale", a populated one means "this directory is real and your token is
 * not in it" — and a single message that said neither would pass any test that
 * only looked for the word "registry".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { voidData } from "../dist/core/evo-utils.js";
import { registryNodeMissingError } from "../dist/substandards/registry-guard.js";

import {
  ASSET_NAME,
  DESTINATION,
  HOLDER,
  HarnessStop,
  OWN_NODE,
  RECIPIENT,
  REGISTRY_ADDR,
  REGISTRY_HASH,
  TARGET_INDEX,
  TARGET_TX_HASH,
  TOKEN_POLICY,
  dummy,
  fes,
  h,
  node,
  plb,
  run,
  tokenUtxo,
  utxo,
} from "./support/fes-rig.mjs";

const UNIT = TOKEN_POLICY + ASSET_NAME;

/** The directory read returns nothing at all — not even an origin node. */
const EMPTY_REGISTRY = { [REGISTRY_ADDR]: [] };

/**
 * A real, populated directory that simply does not hold this token: one node
 * for SOME OTHER policy. This is what a re-bootstrapped deployment looks like
 * to a token minted under the previous one.
 */
const OTHER_POLICY = h("7f");
const POPULATED_REGISTRY = {
  [REGISTRY_ADDR]: [
    utxo({
      address: REGISTRY_ADDR,
      datum: node(OTHER_POLICY, "ff".repeat(30)),
      units: { [REGISTRY_HASH + OTHER_POLICY]: 1n },
    }),
  ],
};

const WITH_TOKEN_NODE = {
  [REGISTRY_ADDR]: [utxo({ address: REGISTRY_ADDR, datum: OWN_NODE, units: { [REGISTRY_HASH + TOKEN_POLICY]: 1n } })],
};

const holderTokens = { [plb(HOLDER)]: [tokenUtxo(plb(HOLDER))] };
const senderTokens = {
  [plb(HOLDER)]: [utxo({ address: plb(HOLDER), units: { [UNIT]: 100n }, datum: voidData(), txHash: TARGET_TX_HASH })],
};

const common = { tokenPolicyId: TOKEN_POLICY, assetName: ASSET_NAME };

/** Every site that looks a TOKEN up, with the fixtures each needs to reach it. */
const SITES = [
  {
    operation: "freeze-and-seize.mint",
    plugin: fes,
    method: "mint",
    params: { ...common, feePayerAddress: HOLDER, quantity: 10n },
    extra: {},
  },
  {
    operation: "freeze-and-seize.burn",
    plugin: fes,
    method: "burn",
    params: { ...common, feePayerAddress: HOLDER, holderAddress: HOLDER, utxoTxHash: TARGET_TX_HASH, utxoOutputIndex: TARGET_INDEX },
    extra: holderTokens,
  },
  {
    operation: "freeze-and-seize.transfer",
    plugin: fes,
    method: "transfer",
    params: { ...common, substandardId: "freeze-and-seize", senderAddress: HOLDER, recipientAddress: RECIPIENT, quantity: 100n },
    extra: senderTokens,
  },
  {
    operation: "freeze-and-seize.seize",
    plugin: fes,
    method: "seize",
    params: {
      ...common,
      substandardId: "freeze-and-seize",
      feePayerAddress: HOLDER,
      holderAddress: HOLDER,
      destinationAddress: DESTINATION,
      utxoTxHash: TARGET_TX_HASH,
      utxoOutputIndex: TARGET_INDEX,
    },
    extra: holderTokens,
  },
  {
    operation: "dummy.transfer",
    plugin: dummy,
    method: "transfer",
    params: { ...common, substandardId: "dummy", senderAddress: HOLDER, recipientAddress: RECIPIENT, quantity: 100n },
    extra: senderTokens,
  },
  {
    operation: "dummy.mint",
    plugin: dummy,
    method: "mint",
    params: { ...common, feePayerAddress: HOLDER, quantity: 10n },
    extra: {},
  },
];

for (const site of SITES) {
  test(`${site.operation} — an EMPTY directory is diagnosed as not-bootstrapped / wrong-address / stale`, async () => {
    const result = await run(site.plugin, site.method, site.params, { ...site.extra, ...EMPTY_REGISTRY });

    assert.ok(result.error instanceof Error, "the lookup must be refused");
    assert.ok(!(result.error instanceof HarnessStop), "no transaction may be built without a registry node");
    assert.equal(result.payTo.length, 0);
    assert.match(result.error.message, new RegExp(site.operation.replace(/\./g, "\\.")), "names the OPERATION");
    assert.ok(result.error.message.includes(TOKEN_POLICY), "names the POLICY asked for");
    assert.ok(result.error.message.includes(REGISTRY_ADDR), "names the DIRECTORY it actually read");
    assert.match(result.error.message, /NO NODES AT ALL/, "an empty read is its own diagnosis");
    assert.match(result.error.message, /never bootstrapped/, "and names the likeliest reason for it");
  });

  test(`${site.operation} — a POPULATED directory without the token names the DEPLOYMENT-BOUND reading`, async () => {
    const result = await run(site.plugin, site.method, site.params, { ...site.extra, ...POPULATED_REGISTRY });

    assert.ok(result.error instanceof Error);
    assert.ok(!(result.error instanceof HarnessStop));
    assert.match(result.error.message, /1 node\(s\)/, "the COUNT is what distinguishes this from an empty read");
    assert.doesNotMatch(result.error.message, /NO NODES AT ALL/, "this directory is populated — saying otherwise misdiagnoses it");
    assert.match(result.error.message, /DIFFERENT DEPLOYMENT/, "the reading the old message could not express");
    assert.match(result.error.message, /deployment-bound/, "and why: the policy id is derived from the deployment");
    assert.match(result.error.message, /no repointing/, "and that it cannot be migrated");
    assert.match(result.error.message, /never registered/, "reading one is still offered");
    assert.match(result.error.message, /behind the chain/, "and so is indexer lag");
  });
}

// ---------------------------------------------------------------------------
// register is different: it needs a BRACKETING node, which a bootstrapped
// directory always has. So its absence is never a fact about the token.
// ---------------------------------------------------------------------------

test("freeze-and-seize.register — an absent COVERING node is diagnosed as a bootstrap/address problem, not a token one", async () => {
  const result = await run(fes, "register", { feePayerAddress: HOLDER, assetName: ASSET_NAME, quantity: 10n }, EMPTY_REGISTRY);

  assert.ok(result.error instanceof Error);
  assert.ok(!(result.error instanceof HarnessStop));
  assert.match(result.error.message, /freeze-and-seize\.register/, "names the OPERATION");
  assert.ok(result.error.message.includes(REGISTRY_ADDR), "names the DIRECTORY");
  assert.match(result.error.message, /key < policyId < next/, "states the rule insertion needs");
  assert.match(result.error.message, /NOT a fact about your token/, "the misreading it exists to prevent");
  assert.match(result.error.message, /bootstrap never/, "and the cause it points at instead");
  assert.doesNotMatch(result.error.message, /DIFFERENT DEPLOYMENT/, "register's diagnosis is NOT the deployment-bound one");
});

// ---------------------------------------------------------------------------
// Controls — the directory that DOES hold the token is unaffected
// ---------------------------------------------------------------------------

test("CONTROL — with the token's node present, mint still builds", async () => {
  const result = await run(fes, "mint", { ...common, feePayerAddress: HOLDER, quantity: 10n }, WITH_TOKEN_NODE);
  assert.ok(result.error instanceof HarnessStop, `mint must still build; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(HOLDER)], "omitted recipientAddress means the fee payer");
});

test("CONTROL — with a bracketing node present, register still builds", async () => {
  const covering = {
    [REGISTRY_ADDR]: [
      utxo({
        address: REGISTRY_ADDR,
        datum: node(h("00"), "ff".repeat(30)),
        units: { [REGISTRY_HASH + h("00")]: 1n },
      }),
    ],
  };
  const result = await run(fes, "register", { feePayerAddress: HOLDER, assetName: ASSET_NAME, quantity: 10n }, covering);
  assert.ok(result.error instanceof HarnessStop, `register must still build; got: ${result.error?.message}`);
});

test("the two diagnoses are DIFFERENT TEXT, not one message with a number swapped", () => {
  // Proof-of-harness for the split above: if both branches produced the same
  // prose, every assertion in this file would still pass except this one.
  const empty = runSync(0);
  const populated = runSync(3);
  assert.notEqual(empty, populated, "an empty and a populated directory must not read the same");
  assert.match(empty, /NO NODES AT ALL/);
  assert.match(populated, /it is populated/);
  assert.doesNotMatch(populated, /NO NODES AT ALL/);
});

/**
 * The message built directly from its own export — the only way to vary
 * `nodesRead` without fabricating that many UTxOs.
 */
function runSync(nodesRead) {
  return registryNodeMissingError({
    operation: "freeze-and-seize.transfer",
    tokenPolicyId: TOKEN_POLICY,
    registryAddress: REGISTRY_ADDR,
    nodesRead,
  }).message;
}
