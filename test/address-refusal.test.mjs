/**
 * The empty-string address family: refused by NAME, at every site that decides
 * which address a transaction targets.
 *
 * ⛔ WHAT THIS PROVES, AND WHY A COUNT OF PASSING TESTS DOES NOT. Several
 * substandard params types make an address OPTIONAL. Every call site handled an
 * ABSENT value correctly and a PRESENT-BUT-EMPTY one wrongly, and `""` is the
 * only value that separates them. Three of those sites SUBSTITUTED SILENTLY and
 * built a VALID transaction against the WRONG address — no error, no failing
 * test, nothing to notice.
 *
 * So every site gets THREE assertions, and it is the trio that carries the
 * proof:
 *
 *   1. `""` is REFUSED, and the message names the PARAMETER and the OPERATION.
 *   2. ABSENT still resolves to the documented default — unchanged behaviour.
 *   3. A VALID address is still the one used — unchanged behaviour.
 *
 * (1) alone would pass just as well if the fix had broken (2) or (3). The pair
 * (2)+(3) is what says this is a refusal rather than a behaviour change.
 *
 * ⚠ THE INSTRUMENT IS THE ADDRESS THE TRANSACTION ACTUALLY TARGETS, not a
 * description of the code. The plugins are driven in-process against a
 * recording client (the Proxy-client pattern from `cip68-callsite.test.mjs`)
 * which captures the bech32 address of the first `payToAddress`, and every
 * address handed to `getUtxos`. The fee payer and the recipient/holder are
 * DELIBERATELY DIFFERENT wallets, so "it fell back to the fee payer" and "it
 * used the address I asked for" are distinguishable strings and not a judgement
 * call.
 *
 * The transaction build is deliberately cut short by a sentinel thrown from the
 * first `payToAddress`: everything this file asserts is decided before that
 * point, and running further would require a chain.
 *
 * ⛔ NOT EVERY SITE HERE IS REACHABLE IN THE SHIPPED ARTEFACT, AND THAT CHANGES
 * WHAT A GREEN READING MEANS. `dummySubstandard.init()` calls
 * `requirePublishHandlers()`, which refuses the SHIPPED dummy blueprint outright
 * — its validators carry no `.publish` handler (the W-D / T-D08 blocker). That
 * refusal precedes every operation, so dummy's sites are LATENT: live,
 * published code that no caller can currently reach. ⇒ **The defects actually
 * live in 0.10.0 are the four freeze-and-seize sites, three of them silent.**
 *
 * The fixture blueprint below — a copy declaring those two handlers — is the
 * ONLY reason the dummy tests are not vacuous. Without it every dummy test
 * would go green against `init()`'s refusal while never reaching the address
 * decision at all: **a guard pointed at an unreachable call site is a guard
 * observed AGREEING, not a guard observed WORKING.** This repo has been bitten
 * by that shape before — a suite reporting "0 skipped" for a file the runner
 * never matched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  Address as EvoAddress,
  AddressEras,
  Assets,
  BaseAddress,
  Bytes,
  InlineDatum,
  KeyHash,
  TransactionHash,
  UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";

import { protocolParamsDatum, registryNodeDatum } from "../dist/index.js";
import { baseAddress, scriptAddress } from "../dist/core/evo-utils.js";
import { dummySubstandard } from "../dist/substandards/dummy/index.js";
import { freezeAndSeizeSubstandard } from "../dist/substandards/freeze-and-seize/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BP_DIR = new URL("../blueprints/substandards/", import.meta.url);
const FES_BP = JSON.parse(readFileSync(new URL("freeze-and-seize/v0.1.0/plutus.json", BP_DIR), "utf8"));

/**
 * ⚠ The SHIPPED dummy blueprint cannot be initialised: `requirePublishHandlers`
 * refuses it because its validators carry no `.publish` handler (a real,
 * separate blocker — PLAN.md workstream W-D / T-D08). That refusal sits in
 * `init`, ahead of every operation, so dummy's address sites are unreachable
 * through the shipped artefact today. They are still live code and still ship,
 * so they are tested here against a blueprint that declares those handlers —
 * the minimum fixture that lets the address decision run at all.
 */
const DUMMY_BP = (() => {
  const bp = JSON.parse(readFileSync(new URL("dummy/v0.1.0/plutus.json", BP_DIR), "utf8"));
  const code = bp.validators.find((v) => v.title === "transfer.issue.withdraw").compiledCode;
  bp.validators = [
    ...bp.validators,
    { title: "transfer.issue.publish", compiledCode: code },
    { title: "transfer.transfer.publish", compiledCode: code },
  ];
  return bp;
})();

const NETWORK_ID = 0;
const h = (byte, n = 28) => byte.repeat(n);
const keyCred = (hex) => new KeyHash.KeyHash({ hash: Bytes.fromHex(hex) });
const wallet = (payment, stake) =>
  AddressEras.toBech32(
    new BaseAddress.BaseAddress({
      networkId: NETWORK_ID,
      paymentCredential: keyCred(payment),
      stakeCredential: keyCred(stake),
    }),
  );

// Four distinct wallets. Distinct STAKE credentials are what matters: the PLB
// address a transaction targets is derived from the staking credential, so two
// wallets sharing one would make "wrong address" and "right address" the same
// string and every assertion below vacuous.
const FEE_PAYER = wallet(h("11"), h("22"));
const RECIPIENT = wallet(h("33"), h("44"));
const HOLDER = wallet(h("55"), h("66"));
const DESTINATION = wallet(h("77"), h("88"));

const PLB_HASH = h("aa");
const PLG_HASH = h("ab");
const THIRD_PARTY_HASH = h("ac");
const REGISTRY_HASH = h("bb");
const TOKEN_POLICY = h("cc");
const ISSUANCE_LOGIC_HASH = h("dd");
const PP_POLICY = h("ee");
const ISSUANCE_POLICY = h("3c");
const ALWAYS_FAIL_HASH = h("1a");
const ADMIN_PKH = h("2b");
const ASSET_NAME = "4142";
const UNIT = TOKEN_POLICY + ASSET_NAME;

const REGISTRY_ADDR = scriptAddress(NETWORK_ID, REGISTRY_HASH);
const PP_ADDR = scriptAddress(NETWORK_ID, PP_POLICY);
const ALWAYS_FAIL_ADDR = scriptAddress(NETWORK_ID, ALWAYS_FAIL_HASH);

const plb = (addr) => baseAddress(NETWORK_ID, PLB_HASH, addr);

const refInput = (index) => ({ txHash: h("9", 64), outputIndex: index });
const DEPLOYMENT = {
  maxInlineDatumBytes: 1024,
  issuanceLogic: { scriptHash: ISSUANCE_LOGIC_HASH },
  protocolParams: { policyId: PP_POLICY },
  issuance: { policyId: ISSUANCE_POLICY, alwaysFailScriptHash: ALWAYS_FAIL_HASH },
  programmableBaseRefInput: refInput(0),
  programmableLogicGlobalRefInput: refInput(1),
  transferRefInput: refInput(2),
  thirdPartyRefInput: refInput(3),
  unfrackingRefInput: refInput(4),
  issuanceLogicRefInput: refInput(5),
  upgradeMultisigRefInput: refInput(6),
};

const scriptCred = (hash) => ({ type: "script", hash });

const PP_DATUM = protocolParamsDatum({
  plgCred: scriptCred(PLG_HASH),
  issuanceLogicCred: scriptCred(ISSUANCE_LOGIC_HASH),
  transferCred: scriptCred(h("5e")),
  thirdPartyCred: scriptCred(THIRD_PARTY_HASH),
  upgradeCred: scriptCred(h("70")),
  pendingUpgradeCred: null,
});

const node = (key, next) =>
  registryNodeDatum({
    key,
    next,
    mintingLogicScript: scriptCred(h("81")),
    transferLogicScript: scriptCred(h("82")),
    thirdPartyTransferLogicScript: scriptCred(h("83")),
    unfrackingLogicScript: scriptCred(h("84")),
    globalStateCs: "",
  });

/** The node whose key IS the token — what mint/burn/seize look up. */
const OWN_NODE = node(TOKEN_POLICY, "ff".repeat(30));
/** The node that COVERS the token — what register inserts after. */
const COVERING_NODE = node(h("00"), "ff".repeat(30));

const TARGET_TX_HASH = "7e".repeat(32);
const TARGET_INDEX = 0;

let utxoSeq = 0;
function utxo({ address, lovelace = 20_000_000n, units = {}, datum, txHash, index = 0 }) {
  const record = { lovelace };
  for (const [unit, qty] of Object.entries(units)) record[unit] = qty;
  utxoSeq += 1;
  return new EvoUTxO.UTxO({
    transactionId: TransactionHash.fromHex(txHash ?? utxoSeq.toString(16).padStart(4, "0").repeat(16)),
    index: BigInt(index),
    address: EvoAddress.fromBech32(address),
    assets: Assets.fromRecord(record),
    ...(datum ? { datumOption: new InlineDatum.InlineDatum({ data: datum }) } : {}),
  });
}

/** A UTxO holding the token, at `address`, addressable as TARGET_TX_HASH#0. */
const tokenUtxo = (address) =>
  utxo({ address, units: { [UNIT]: 100n }, txHash: TARGET_TX_HASH, index: TARGET_INDEX });

// ---------------------------------------------------------------------------
// The recording client
// ---------------------------------------------------------------------------

/** Thrown from the first `payToAddress`: everything asserted here is decided by then. */
class HarnessStop extends Error {}

/**
 * @param {Record<string, any[]>} utxosByAddress bech32 → UTxOs. Any address not
 *   named gets two plain wallet UTxOs, so coin selection never starves.
 */
function makeRig(utxosByAddress = {}) {
  const seen = { payTo: [], getUtxos: [], stopped: false };

  const builder = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        return (arg) => {
          if (property === "payToAddress") {
            seen.payTo.push(EvoAddress.toBech32(arg.address));
            seen.stopped = true;
            throw new HarnessStop("harness stop: first payToAddress reached");
          }
          return builder;
        };
      },
    },
  );

  const client = {
    chain: { id: NETWORK_ID },
    async getProtocolParameters() {
      return { coinsPerUtxoByte: 4310n };
    },
    async getUtxos(address) {
      const bech32 = EvoAddress.toBech32(address);
      seen.getUtxos.push(bech32);
      if (bech32 in utxosByAddress) return utxosByAddress[bech32];
      return [utxo({ address: bech32, lovelace: 50_000_000n }), utxo({ address: bech32, lovelace: 60_000_000n })];
    },
    async getUtxosWithUnit(address, unit) {
      const bech32 = EvoAddress.toBech32(address);
      if (bech32 === PP_ADDR) return [utxo({ address: bech32, datum: PP_DATUM, units: { [unit]: 1n } })];
      return [utxo({ address: bech32, units: { [unit]: 1n } })];
    },
    async getUtxosByOutRef() {
      return [utxo({ address: FEE_PAYER })];
    },
    newTx() {
      return builder;
    },
  };

  return { seen, client };
}

const STANDARD_SCRIPTS = {
  programmableLogicBase: { hash: PLB_HASH },
  programmableLogicGlobal: { hash: PLG_HASH },
  thirdParty: { hash: THIRD_PARTY_HASH },
  registry: { hash: REGISTRY_HASH },
  buildIssuanceMint: () => ({ hash: TOKEN_POLICY, compiledCode: "00" }),
};

function initPlugin(plugin, client) {
  plugin.init({
    client,
    standardScripts: STANDARD_SCRIPTS,
    deployment: DEPLOYMENT,
    network: "preprod",
  });
  return plugin;
}

const fes = (client) =>
  initPlugin(
    freezeAndSeizeSubstandard({
      blueprint: FES_BP,
      deployment: {
        adminPkh: ADMIN_PKH,
        assetName: ASSET_NAME,
        blacklistNodePolicyId: h("92"),
        blacklistInitTxInput: { txHash: h("a", 64), outputIndex: 0 },
      },
    }),
    client,
  );

const dummy = (client) => initPlugin(dummySubstandard({ blueprint: DUMMY_BP }), client);

/**
 * Drive one operation and return what the transaction actually aimed at.
 * Errors are captured rather than thrown so a test can assert on the CONTRAST
 * between "no error, wrong address" and "named refusal" — but every caller
 * below asserts on `error` explicitly, so a harness failure cannot pass as a
 * result.
 */
async function run(makePlugin, operation, params, utxosByAddress) {
  const { seen, client } = makeRig(utxosByAddress);
  const plugin = makePlugin(client);
  let error;
  try {
    await plugin[operation](params);
  } catch (err) {
    error = err;
  }
  return { ...seen, error };
}

/** The shared shape of every refusal assertion: the parameter AND the operation, by name. */
function assertRefusedByName(result, { operation, parameter, received = '"" (the empty string)' }) {
  assert.ok(result.error instanceof Error, "the empty address must be refused, not accepted");
  assert.ok(
    !(result.error instanceof HarnessStop),
    `${operation}: the empty ${parameter} built a transaction instead of being refused`,
  );
  assert.match(result.error.message, new RegExp(parameter), "the refusal must name the PARAMETER");
  assert.match(
    result.error.message,
    new RegExp(operation.replace(/\./g, "\\.")),
    "the refusal must name the OPERATION",
  );
  assert.match(result.error.message, new RegExp(received.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.payTo.length, 0, "nothing may be paid to anyone once the address is refused");
}

/** Asserts the run got as far as building an output, and names the address it targeted. */
function assertTargeted(result, expected, why) {
  assert.ok(result.error instanceof HarnessStop, `the run must reach payToAddress; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [expected], why);
}

// ---------------------------------------------------------------------------
// Site 1 — freeze-and-seize.register, recipientAddress  (was SILENT)
// ---------------------------------------------------------------------------

const REGISTER_UTXOS = { [REGISTRY_ADDR]: [utxo({ address: REGISTRY_ADDR, datum: COVERING_NODE, units: { [REGISTRY_HASH + h("00")]: 1n } })] };
const registerParams = (extra) => ({ feePayerAddress: FEE_PAYER, assetName: ASSET_NAME, quantity: 10n, ...extra });

test("site 1 — FES register REFUSES an empty recipientAddress by name", async () => {
  const result = await run(fes, "register", registerParams({ recipientAddress: "" }), REGISTER_UTXOS);
  assertRefusedByName(result, { operation: "freeze-and-seize.register", parameter: "recipientAddress" });
});

test("site 1 — FES register with recipientAddress ABSENT still mints to the fee payer", async () => {
  const result = await run(fes, "register", registerParams({}), REGISTER_UTXOS);
  assertTargeted(result, plb(FEE_PAYER), "the documented default: omitted recipientAddress means feePayerAddress");
});

test("site 1 — FES register with a VALID recipientAddress still mints to that recipient", async () => {
  const result = await run(fes, "register", registerParams({ recipientAddress: RECIPIENT }), REGISTER_UTXOS);
  assertTargeted(result, plb(RECIPIENT), "a valid recipientAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 2 — freeze-and-seize.mint, recipientAddress  (was SILENT)
// ---------------------------------------------------------------------------

const OWN_NODE_UTXOS = { [REGISTRY_ADDR]: [utxo({ address: REGISTRY_ADDR, datum: OWN_NODE, units: { [REGISTRY_HASH + TOKEN_POLICY]: 1n } })] };
const mintParams = (extra) => ({
  feePayerAddress: FEE_PAYER,
  tokenPolicyId: TOKEN_POLICY,
  assetName: ASSET_NAME,
  quantity: 10n,
  ...extra,
});

test("site 2 — FES mint REFUSES an empty recipientAddress by name", async () => {
  const result = await run(fes, "mint", mintParams({ recipientAddress: "" }), OWN_NODE_UTXOS);
  assertRefusedByName(result, { operation: "freeze-and-seize.mint", parameter: "recipientAddress" });
});

test("site 2 — FES mint with recipientAddress ABSENT still mints to the fee payer", async () => {
  const result = await run(fes, "mint", mintParams({}), OWN_NODE_UTXOS);
  assertTargeted(result, plb(FEE_PAYER), "the documented default: omitted recipientAddress means feePayerAddress");
});

test("site 2 — FES mint with a VALID recipientAddress still mints to that recipient", async () => {
  const result = await run(fes, "mint", mintParams({ recipientAddress: RECIPIENT }), OWN_NODE_UTXOS);
  assertTargeted(result, plb(RECIPIENT), "a valid recipientAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 3 — freeze-and-seize.burn, holderAddress  (was LOUD, WRONG CAUSE)
// ---------------------------------------------------------------------------

const burnUtxos = (holderOfRecord) => ({
  ...OWN_NODE_UTXOS,
  [plb(holderOfRecord)]: [tokenUtxo(plb(holderOfRecord))],
});
const burnParams = (extra) => ({
  feePayerAddress: FEE_PAYER,
  tokenPolicyId: TOKEN_POLICY,
  assetName: ASSET_NAME,
  utxoTxHash: TARGET_TX_HASH,
  utxoOutputIndex: TARGET_INDEX,
  ...extra,
});

test("site 3 — FES burn REFUSES an empty holderAddress by name", async () => {
  const result = await run(fes, "burn", burnParams({ holderAddress: "" }), burnUtxos(HOLDER));
  assertRefusedByName(result, { operation: "freeze-and-seize.burn", parameter: "holderAddress" });
  assert.deepEqual(result.getUtxos, [], "the refusal must precede the chain read it used to misdiagnose");
});

test("site 3 — FES burn with holderAddress ABSENT still searches the fee payer's PLB address", async () => {
  const result = await run(fes, "burn", burnParams({}), burnUtxos(FEE_PAYER));
  assert.equal(result.getUtxos[0], plb(FEE_PAYER), "the documented default: omitted holderAddress means feePayerAddress");
});

test("site 3 — FES burn with a VALID holderAddress still searches that holder's PLB address", async () => {
  const result = await run(fes, "burn", burnParams({ holderAddress: HOLDER }), burnUtxos(HOLDER));
  assert.equal(result.getUtxos[0], plb(HOLDER), "a valid holderAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 4 — freeze-and-seize.seize, holderAddress  (was SILENT — a dropped holder)
// ---------------------------------------------------------------------------

const seizeUtxos = (whereTheTokenIs) => ({
  ...OWN_NODE_UTXOS,
  [plb(whereTheTokenIs)]: [tokenUtxo(plb(whereTheTokenIs))],
});
const seizeParams = (extra) => ({
  substandardId: "freeze-and-seize",
  feePayerAddress: FEE_PAYER,
  tokenPolicyId: TOKEN_POLICY,
  assetName: ASSET_NAME,
  utxoTxHash: TARGET_TX_HASH,
  utxoOutputIndex: TARGET_INDEX,
  destinationAddress: DESTINATION,
  ...extra,
});

test("site 4 — FES seize REFUSES an empty holderAddress by name instead of dropping it", async () => {
  const result = await run(fes, "seize", seizeParams({ holderAddress: "" }), seizeUtxos(FEE_PAYER));
  assertRefusedByName(result, { operation: "freeze-and-seize.seize", parameter: "holderAddress" });
  assert.deepEqual(result.getUtxos, [], "no address may be searched once the holder is refused");
});

test("site 4 — FES seize with holderAddress ABSENT still searches feePayer then destination", async () => {
  const result = await run(fes, "seize", seizeParams({}), seizeUtxos(FEE_PAYER));
  assert.deepEqual(
    result.getUtxos.slice(0, 1),
    [plb(FEE_PAYER)],
    "absent holderAddress legitimately means: search only feePayer and destination",
  );
  assert.ok(!result.getUtxos.includes(plb(HOLDER)), "no holder was named, so none may be searched");
});

test("site 4 — FES seize with a VALID holderAddress still searches the holder FIRST", async () => {
  const result = await run(fes, "seize", seizeParams({ holderAddress: HOLDER }), seizeUtxos(HOLDER));
  assert.equal(result.getUtxos[0], plb(HOLDER), "a valid holderAddress is searched first, unchanged");
});

// ---------------------------------------------------------------------------
// Site 5 — dummy.register, recipientAddress  (was LOUD, BAD MESSAGE)
// ---------------------------------------------------------------------------

test("site 5 — dummy register REFUSES an empty recipientAddress by name", async () => {
  const result = await run(dummy, "register", registerParams({ recipientAddress: "" }), REGISTER_UTXOS);
  assertRefusedByName(result, { operation: "dummy.register", parameter: "recipientAddress" });
  assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed bech32 ParseError is what this replaces");
});

test("site 5 — dummy register with recipientAddress ABSENT still mints to the fee payer", async () => {
  const result = await run(dummy, "register", registerParams({}), REGISTER_UTXOS);
  assertTargeted(result, plb(FEE_PAYER), "the documented default: omitted recipientAddress means feePayerAddress");
});

test("site 5 — dummy register with a VALID recipientAddress still mints to that recipient", async () => {
  const result = await run(dummy, "register", registerParams({ recipientAddress: RECIPIENT }), REGISTER_UTXOS);
  assertTargeted(result, plb(RECIPIENT), "a valid recipientAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 6 — dummy.mint, recipientAddress  (was LOUD, BAD MESSAGE)
// ---------------------------------------------------------------------------

test("site 6 — dummy mint REFUSES an empty recipientAddress by name", async () => {
  const result = await run(dummy, "mint", mintParams({ recipientAddress: "" }), OWN_NODE_UTXOS);
  assertRefusedByName(result, { operation: "dummy.mint", parameter: "recipientAddress" });
  assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed bech32 ParseError is what this replaces");
});

test("site 6 — dummy mint with recipientAddress ABSENT still mints to the fee payer", async () => {
  const result = await run(dummy, "mint", mintParams({}), OWN_NODE_UTXOS);
  assertTargeted(result, plb(FEE_PAYER), "the documented default: omitted recipientAddress means feePayerAddress");
});

test("site 6 — dummy mint with a VALID recipientAddress still mints to that recipient", async () => {
  const result = await run(dummy, "mint", mintParams({ recipientAddress: RECIPIENT }), OWN_NODE_UTXOS);
  assertTargeted(result, plb(RECIPIENT), "a valid recipientAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 7 — dummy.thirdPartyTransfer, holderAddress  (REQUIRED — no fallback to get wrong)
// ---------------------------------------------------------------------------

const tptUtxos = (holderOfRecord) => ({
  ...OWN_NODE_UTXOS,
  [plb(holderOfRecord)]: [tokenUtxo(plb(holderOfRecord))],
});
const tptParams = (extra) => ({
  holderAddress: HOLDER,
  recipientAddress: RECIPIENT,
  tokenPolicyId: TOKEN_POLICY,
  assetName: ASSET_NAME,
  quantity: 10n,
  feePayerAddress: FEE_PAYER,
  ...extra,
});

test("site 7 — dummy thirdPartyTransfer REFUSES an empty holderAddress by name", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({ holderAddress: "" }), tptUtxos(HOLDER));
  assertRefusedByName(result, { operation: "dummy.thirdPartyTransfer", parameter: "holderAddress" });
  assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed bech32 ParseError is what this replaces");
});

test("site 7 — dummy thirdPartyTransfer REFUSES an ABSENT holderAddress by name (it is REQUIRED)", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({ holderAddress: undefined }), tptUtxos(HOLDER));
  assertRefusedByName(result, {
    operation: "dummy.thirdPartyTransfer",
    parameter: "holderAddress",
    received: "undefined",
  });
  assert.match(result.error.message, /REQUIRED/, "there is no documented default here to fall back to");
});

test("site 7 — dummy thirdPartyTransfer with a VALID holderAddress still searches that holder", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({}), tptUtxos(HOLDER));
  assert.equal(result.getUtxos[0], plb(HOLDER), "a valid holderAddress is used unchanged");
});

// ---------------------------------------------------------------------------
// Site 8 (r2) — dummy.thirdPartyTransfer, recipientAddress  (REQUIRED, unguarded)
//
// ⛔ THE NEXT LINE AFTER SITE 7, in the same function, destructured from the
// same params object. Guarding only `holderAddress` left the operation
// HALF-GUARDED, which is worse than guarding neither: a caller who sees a named
// refusal on one parameter reasonably infers the operation validates its
// addresses.
// ---------------------------------------------------------------------------

test("site 8 — dummy thirdPartyTransfer REFUSES an empty recipientAddress by name", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({ recipientAddress: "" }), tptUtxos(HOLDER));
  assertRefusedByName(result, { operation: "dummy.thirdPartyTransfer", parameter: "recipientAddress" });
  assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed bech32 ParseError is what this replaces");
  assert.doesNotMatch(
    result.error.message,
    /holderAddress/,
    "the refusal must name the parameter that is wrong, not its guarded neighbour",
  );
});

test("site 8 — dummy thirdPartyTransfer REFUSES an ABSENT recipientAddress by name (it is REQUIRED)", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({ recipientAddress: undefined }), tptUtxos(HOLDER));
  assertRefusedByName(result, {
    operation: "dummy.thirdPartyTransfer",
    parameter: "recipientAddress",
    received: "undefined",
  });
  assert.match(result.error.message, /REQUIRED/, "there is no documented default here to fall back to");
});

test("site 8 — dummy thirdPartyTransfer with a VALID recipientAddress still pays that recipient", async () => {
  const result = await run(dummy, "thirdPartyTransfer", tptParams({}), tptUtxos(HOLDER));
  // Pinned to the reading MEASURED at f42758e: the seized supply goes to the
  // recipient's PLB address, and the holder's PLB is searched for it first.
  assertTargeted(result, plb(RECIPIENT), "a valid recipientAddress is used unchanged");
  assert.equal(result.getUtxos[0], plb(HOLDER), "and the holder is still where the tokens are sought");
});

// ---------------------------------------------------------------------------
// Site 9 (r2) — freeze-and-seize.seize, destinationAddress  (REQUIRED, unguarded)
//
// Site 4's own operation, and the parameter that says WHERE THE SEIZED ASSETS
// ARE SENT. It is read twice — once into the search set, once as the output —
// so it is resolved ONCE and both reads use the resolved value: two reads of one
// parameter must not be able to disagree about whether it was checked.
// ---------------------------------------------------------------------------

test("site 9 — FES seize REFUSES an empty destinationAddress by name", async () => {
  const result = await run(fes, "seize", seizeParams({ holderAddress: HOLDER, destinationAddress: "" }), seizeUtxos(HOLDER));
  assertRefusedByName(result, { operation: "freeze-and-seize.seize", parameter: "destinationAddress" });
  assert.doesNotMatch(
    result.error.message,
    /holderAddress/,
    "the refusal must name the parameter that is wrong, not its guarded neighbour",
  );
  assert.deepEqual(result.getUtxos, [], "no address may be searched once the destination is refused");
});

test("site 9 — FES seize REFUSES an ABSENT destinationAddress by name (it is REQUIRED)", async () => {
  const result = await run(fes, "seize", seizeParams({ holderAddress: HOLDER, destinationAddress: undefined }), seizeUtxos(HOLDER));
  assertRefusedByName(result, {
    operation: "freeze-and-seize.seize",
    parameter: "destinationAddress",
    received: "undefined",
  });
  assert.match(result.error.message, /REQUIRED/, "there is no documented default here to fall back to");
});

test("site 9 — FES seize with a VALID destinationAddress still sends the seized assets there", async () => {
  // The token is planted at the DESTINATION's PLB deliberately: the search loop
  // BREAKS on the first hit, so this is the only fixture under which the
  // destination's place in the search order is observable at all.
  const result = await run(fes, "seize", seizeParams({ holderAddress: HOLDER }), seizeUtxos(DESTINATION));
  // Pinned to the reading MEASURED at f42758e — both the order and the target.
  assertTargeted(result, plb(DESTINATION), "a valid destinationAddress is used unchanged");
  assert.deepEqual(
    result.getUtxos.slice(0, 3),
    [plb(HOLDER), plb(FEE_PAYER), plb(DESTINATION)],
    "holder, then feePayer, then destination — the f42758e search order, unchanged",
  );
});

// ---------------------------------------------------------------------------
// r3 — feePayerAddress, on the SEVEN operations this slice touches
//
// ⛔ WHY THIS IS NOT "one more parameter". `feePayerAddress` is the FALLBACK the
// optional guards above hand back for an absent parameter, so leaving it
// unguarded left the slice's own central claim false. MEASURED on f07f00f,
// before these guards existed:
//
//   register({ feePayerAddress: "", recipientAddress: undefined })
//     -> ParseError: AddressStructure.FromBech32      (the unnamed error this
//                                                      slice exists to remove,
//                                                      reached VIA the guard)
//   register({ feePayerAddress: "", recipientAddress: <valid> })
//     -> no error at all through output construction
//
// The guard therefore runs BEFORE the optional resolution, and is rebound over
// the raw parameter so no later read can reach the unchecked value. Guarding it
// afterwards would close nothing.
//
// ⚠ The rule is about OPERATIONS, not about a parameter across the codebase.
// `transfer`, `freeze`, `unfreeze` and `initCompliance` are untouched by this
// slice and their feePayerAddress stays unguarded — honestly untouched rather
// than half-guarded. Seated as T-D50.
// ---------------------------------------------------------------------------

const FEE_PAYER_SITES = [
  {
    operation: "freeze-and-seize.register",
    plugin: fes,
    method: "register",
    params: registerParams,
    utxos: () => REGISTER_UTXOS,
    // With recipientAddress absent, the fee payer IS the mint target — so this
    // asserts the fallback still works and still points where f42758e pointed.
    valid: (r) => assertTargeted(r, plb(FEE_PAYER), "a valid feePayerAddress still receives the fallback mint"),
  },
  {
    operation: "freeze-and-seize.mint",
    plugin: fes,
    method: "mint",
    params: mintParams,
    utxos: () => OWN_NODE_UTXOS,
    valid: (r) => assertTargeted(r, plb(FEE_PAYER), "a valid feePayerAddress still receives the fallback mint"),
  },
  {
    operation: "freeze-and-seize.burn",
    plugin: fes,
    method: "burn",
    params: burnParams,
    utxos: () => burnUtxos(FEE_PAYER),
    valid: (r) =>
      assert.equal(r.getUtxos[0], plb(FEE_PAYER), "a valid feePayerAddress is still the fallback holder searched"),
  },
  {
    operation: "freeze-and-seize.seize",
    plugin: fes,
    method: "seize",
    params: seizeParams,
    utxos: () => seizeUtxos(FEE_PAYER),
    valid: (r) =>
      assert.equal(r.getUtxos[0], plb(FEE_PAYER), "a valid feePayerAddress is still searched when no holder is named"),
  },
  {
    operation: "dummy.register",
    plugin: dummy,
    method: "register",
    params: registerParams,
    utxos: () => REGISTER_UTXOS,
    valid: (r) => assertTargeted(r, plb(FEE_PAYER), "a valid feePayerAddress still receives the fallback mint"),
  },
  {
    operation: "dummy.mint",
    plugin: dummy,
    method: "mint",
    params: mintParams,
    utxos: () => OWN_NODE_UTXOS,
    valid: (r) => assertTargeted(r, plb(FEE_PAYER), "a valid feePayerAddress still receives the fallback mint"),
  },
  {
    operation: "dummy.thirdPartyTransfer",
    plugin: dummy,
    method: "thirdPartyTransfer",
    params: tptParams,
    utxos: () => tptUtxos(HOLDER),
    // feePayerAddress drives no address here — it is the administrator. The
    // property is that guarding it changed NOTHING about where the transfer goes.
    valid: (r) => {
      assertTargeted(r, plb(RECIPIENT), "guarding feePayerAddress must not move the transfer target");
      assert.equal(r.getUtxos[0], plb(HOLDER), "nor the address searched for the tokens");
    },
  },
];

for (const site of FEE_PAYER_SITES) {
  test(`feePayerAddress — ${site.operation} REFUSES an empty feePayerAddress by name`, async () => {
    const result = await run(site.plugin, site.method, site.params({ feePayerAddress: "" }), site.utxos());
    assertRefusedByName(result, { operation: site.operation, parameter: "feePayerAddress" });
    assert.doesNotMatch(result.error.message, /ParseError/, "the unnamed bech32 ParseError is what this replaces");
    assert.deepEqual(result.getUtxos, [], "the refusal must precede every chain read");
  });

  test(`feePayerAddress — ${site.operation} REFUSES an ABSENT feePayerAddress by name (it is REQUIRED)`, async () => {
    const result = await run(site.plugin, site.method, site.params({ feePayerAddress: undefined }), site.utxos());
    assertRefusedByName(result, {
      operation: site.operation,
      parameter: "feePayerAddress",
      received: "undefined",
    });
    assert.match(result.error.message, /REQUIRED/, "there is no documented default here to fall back to");
  });

  test(`feePayerAddress — ${site.operation} with a VALID feePayerAddress is unchanged`, async () => {
    // Pinned to the f42758e reading: this test passes WITH the defect present,
    // which is what makes the two above a refusal and not a behaviour change.
    site.valid(await run(site.plugin, site.method, site.params({}), site.utxos()));
  });
}
