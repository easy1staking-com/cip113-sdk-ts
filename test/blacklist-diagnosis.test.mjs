/**
 * THE MESSAGES THAT NAMED THE WRONG CAUSE.
 *
 * ⛔ WHAT WAS MEASURED, DEVNET 2026-09-30. A freeze-and-seize deployment whose
 * `compliance.init()` had never run — so the blacklist held NO nodes and nobody
 * was blacklisted — refused a transfer with, verbatim:
 *
 *     Sender c2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446
 *     is blacklisted — transfer denied
 *
 * That is a false statement of fact, produced by the SDK's own guard before the
 * transaction reached the evaluator or the chain. `freeze` said the same thing
 * with a "may".
 *
 * ⚠ WHY THIS COSTS MORE THAN AN UNCLEAR ERROR USUALLY DOES. Of the seven FES
 * operations only `transfer` and `freeze` need a blacklist non-membership
 * proof. register, mint, burn, seize and unfreeze do not — confirmed on devnet,
 * where a SEIZE succeeded on the very deployment whose transfer was refused. So
 * a deployment that skipped the init looks entirely healthy, and fails first,
 * and only, on a transfer — while the message sends its operator hunting for a
 * blacklist entry that does not exist.
 *
 * ⛔ AND THE THIRD MESSAGE: an enterprise sender address died three frames deep
 * as `ParseError: BaseAddress.FromHex`, naming neither the address, nor the
 * caller, nor the fact that a STAKING CREDENTIAL is the thing missing — in an
 * SDK where every programmable address is a base address by construction.
 *
 * ⚠ NEITHER FIX IS A FIX FOR GIOVANNI'S PREPROD FAILURE, and nothing here
 * should be read as claiming otherwise. Both are messages that misdescribed
 * their own cause, found while looking for his. The empty-blacklist hypothesis
 * for his failure was retracted on chain evidence.
 *
 * Each refusal below is paired with the covering-node control that must still
 * build, because a guard that refuses everything would pass every assertion
 * about refusals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { blacklistNodeDatum, labeledAssetName, voidData } from "../dist/core/evo-utils.js";
import { AddressEras, Bytes, EnterpriseAddress, KeyHash } from "@evolution-sdk/evolution";

import {
  ASSET_NAME,
  HOLDER,
  HarnessStop,
  NETWORK_ID,
  OWN_NODE,
  RECIPIENT,
  REGISTRY_ADDR,
  REGISTRY_HASH,
  TARGET_TX_HASH,
  TOKEN_POLICY,
  fes,
  h,
  plb,
  run,
  utxo,
} from "./support/fes-rig.mjs";

const USER_NAME = labeledAssetName(333, ASSET_NAME);
const USER_UNIT = TOKEN_POLICY + USER_NAME;

/** HOLDER's staking credential — what the blacklist bounds are compared against. */
const SENDER_STAKING_HASH = h("66");

const REGISTRY_UTXOS = {
  [REGISTRY_ADDR]: [utxo({ address: REGISTRY_ADDR, datum: OWN_NODE, units: { [REGISTRY_HASH + TOKEN_POLICY]: 1n } })],
};

const senderUtxos = {
  [plb(HOLDER)]: [
    utxo({ address: plb(HOLDER), units: { [USER_UNIT]: 100n }, datum: voidData(), txHash: TARGET_TX_HASH }),
  ],
};

const transferParams = (extra) => ({
  substandardId: "freeze-and-seize",
  senderAddress: HOLDER,
  recipientAddress: RECIPIENT,
  tokenPolicyId: TOKEN_POLICY,
  assetName: USER_NAME,
  quantity: 100n,
  ...extra,
});

const freezeParams = (extra) => ({
  substandardId: "freeze-and-seize",
  feePayerAddress: HOLDER,
  tokenPolicyId: TOKEN_POLICY,
  assetName: USER_NAME,
  targetAddress: HOLDER,
  ...extra,
});

/** Discovered from the plugin, not hardcoded — see datum-erasure.test.mjs. */
const BLACKLIST_ADDR = await (async () => {
  const result = await run(fes, "transfer", transferParams(), { ...REGISTRY_UTXOS, ...senderUtxos });
  const last = result.getUtxos.at(-1);
  assert.match(result.error.message, /no blacklist node BRACKETS/);
  assert.ok(last && result.error.message.includes(last));
  return last;
})();

const blacklist = (nodes) => ({ [BLACKLIST_ADDR]: nodes });
const blacklistNode = (key, next) => utxo({ address: BLACKLIST_ADDR, datum: blacklistNodeDatum(key, next) });

/** The origin node `compliance.init()` mints: it brackets every possible hash. */
const ORIGIN_NODE = () => blacklistNode("", "ff".repeat(30));
/** A populated list whose bounds stop short of the sender — a real gap. */
const NON_COVERING = () => blacklistNode("00".repeat(30), "01".repeat(30));

// ---------------------------------------------------------------------------
// Defect A — the enterprise sender address
// ---------------------------------------------------------------------------

const ENTERPRISE = AddressEras.toBech32(
  new EnterpriseAddress.EnterpriseAddress({
    networkId: NETWORK_ID,
    paymentCredential: new KeyHash.KeyHash({ hash: Bytes.fromHex(h("11")) }),
  }),
);

test("DEFECT A — an enterprise sender is refused by naming the MISSING STAKING CREDENTIAL, not a ParseError", async () => {
  const result = await run(fes, "transfer", transferParams({ senderAddress: ENTERPRISE }), {
    ...REGISTRY_UTXOS,
    ...blacklist([ORIGIN_NODE()]),
  });

  assert.ok(result.error instanceof Error, "an address with no stake part cannot be used");
  assert.ok(!(result.error instanceof HarnessStop), "it built a transaction against an unusable address");
  assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed three-frames-deep failure is what this replaces");
  assert.match(result.error.message, /staking credential/, "the refusal must name what is missing");
  assert.ok(result.error.message.includes(ENTERPRISE), "and which address it was missing from");
  assert.match(result.error.message, /base address/, "and what to use instead");
});

test("CONTROL A — a base address with a stake part is still accepted unchanged", async () => {
  const result = await run(fes, "transfer", transferParams(), {
    ...REGISTRY_UTXOS,
    ...senderUtxos,
    ...blacklist([ORIGIN_NODE()]),
  });
  assert.ok(result.error instanceof HarnessStop, `a base address must still build; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [plb(RECIPIENT)]);
});

// ---------------------------------------------------------------------------
// Defect B — the empty blacklist, on transfer and on freeze
// ---------------------------------------------------------------------------

test("DEFECT B — transfer on an EMPTY blacklist names compliance.init() and does NOT claim the sender is blacklisted", async () => {
  const result = await run(fes, "transfer", transferParams(), {
    ...REGISTRY_UTXOS,
    ...senderUtxos,
    ...blacklist([]),
  });

  assert.ok(result.error instanceof Error);
  assert.ok(!(result.error instanceof HarnessStop));
  assert.doesNotMatch(
    result.error.message,
    /is blacklisted/,
    "THE DEFECT: asserting a blacklisting that the empty list disproves",
  );
  assert.match(result.error.message, /compliance\.init\(\)/, "the refusal must name the call that fixes it");
  assert.match(result.error.message, /NOT A BLACKLISTING/, "and say plainly that this is not one");
  assert.ok(result.error.message.includes(BLACKLIST_ADDR), "and name the address it read");
  assert.match(result.error.message, /only transfer and freeze need this proof/i, "and why the deployment looked healthy");
});

test("DEFECT B — freeze on an EMPTY blacklist names compliance.init() and does NOT hedge about an existing block", async () => {
  const result = await run(fes, "freeze", freezeParams(), blacklist([]));

  assert.ok(result.error instanceof Error);
  assert.ok(!(result.error instanceof HarnessStop));
  assert.doesNotMatch(result.error.message, /may already be blacklisted/, "the old hedge pointed at the wrong cause");
  assert.match(result.error.message, /compliance\.init\(\)/);
  assert.match(result.error.message, /NOT AN EXISTING BLOCK/);
  assert.ok(result.error.message.includes(BLACKLIST_ADDR));
});

// ---------------------------------------------------------------------------
// Defect B, second half — populated but not bracketing: BOTH readings, neither asserted
// ---------------------------------------------------------------------------

test("DEFECT B — transfer with a populated, non-bracketing blacklist states BOTH readings", async () => {
  const result = await run(fes, "transfer", transferParams(), {
    ...REGISTRY_UTXOS,
    ...senderUtxos,
    ...blacklist([NON_COVERING()]),
  });

  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /1 node\(s\)/, "the node COUNT is what separates this from the empty case");
  assert.ok(result.error.message.includes(SENDER_STAKING_HASH), "the sender's staking hash, so the bounds can be compared");
  assert.match(result.error.message, /Either this sender IS/, "reading one: a freeze splits the covering node");
  assert.match(result.error.message, /gap/, "reading two: the list simply does not span this hash");
  assert.match(result.error.message, /key < senderStakingHash < next/, "and the rule a proof must satisfy");
});

test("DEFECT B — freeze with a populated, non-bracketing blacklist states BOTH readings", async () => {
  const result = await run(fes, "freeze", freezeParams(), blacklist([NON_COVERING()]));

  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /1 node\(s\)/);
  assert.match(result.error.message, /ALREADY-FROZEN/, "reading one: the target is already blocked");
  assert.match(result.error.message, /nothing to split/, "reading two: the structural cause");
});

test("CONTROL B — freeze against the origin node still builds", async () => {
  const result = await run(fes, "freeze", freezeParams(), blacklist([ORIGIN_NODE()]));
  assert.ok(result.error instanceof HarnessStop, `a bracketing node must still freeze; got: ${result.error?.message}`);
});
