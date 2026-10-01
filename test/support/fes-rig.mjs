/**
 * THE IN-PROCESS SUBSTANDARD RIG — extracted, not copied.
 *
 * ⛔ WHY THIS IS A MODULE AND NOT A PATTERN TO REPEAT. These fixtures encode
 * decisions a second copy would get subtly wrong and nothing would report:
 * four wallets with DISTINCT STAKE credentials (a shared one makes "right
 * address" and "wrong address" the same string, and every assertion vacuous), a
 * dummy blueprint patched with the `.publish` handlers the shipped one lacks
 * (without it every dummy test passes against `init()`'s refusal while never
 * reaching the code under test), and a recording client that stops the build at
 * the first `payToAddress`. A drifting second copy of this is the same defect
 * class the tests using it exist to catch.
 *
 * It is `test/support/`, not `test/*.test.mjs`, so `node --test test/*.test.mjs`
 * does not glob it — it holds no tests of its own and would report as an empty
 * file if it did.
 *
 * The long prose on WHAT the address family proves stays with the assertions,
 * in `test/address-refusal.test.mjs`.
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

import { protocolParamsDatum, registryNodeDatum } from "../../dist/index.js";
import { baseAddress, scriptAddress } from "../../dist/core/evo-utils.js";
import { dummySubstandard } from "../../dist/substandards/dummy/index.js";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BP_DIR = new URL("../../blueprints/substandards/", import.meta.url);
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
export const DUMMY_BP = (() => {
  const bp = JSON.parse(readFileSync(new URL("dummy/v0.1.0/plutus.json", BP_DIR), "utf8"));
  const code = bp.validators.find((v) => v.title === "transfer.issue.withdraw").compiledCode;
  bp.validators = [
    ...bp.validators,
    { title: "transfer.issue.publish", compiledCode: code },
    { title: "transfer.transfer.publish", compiledCode: code },
  ];
  return bp;
})();

export const NETWORK_ID = 0;
export const h = (byte, n = 28) => byte.repeat(n);
export const keyCred = (hex) => new KeyHash.KeyHash({ hash: Bytes.fromHex(hex) });
export const wallet = (payment, stake) =>
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
export const FEE_PAYER = wallet(h("11"), h("22"));
export const RECIPIENT = wallet(h("33"), h("44"));
export const HOLDER = wallet(h("55"), h("66"));
export const DESTINATION = wallet(h("77"), h("88"));

export const PLB_HASH = h("aa");
export const PLG_HASH = h("ab");
export const THIRD_PARTY_HASH = h("ac");
/** The framework's `transfer` delegate — the hash PP_DATUM names as transferCred. */
export const CORE_TRANSFER_HASH = h("5e");
export const REGISTRY_HASH = h("bb");
export const TOKEN_POLICY = h("cc");
export const ISSUANCE_LOGIC_HASH = h("dd");
export const PP_POLICY = h("ee");
export const ISSUANCE_POLICY = h("3c");
export const ALWAYS_FAIL_HASH = h("1a");
export const ADMIN_PKH = h("2b");
export const ASSET_NAME = "4142";
export const UNIT = TOKEN_POLICY + ASSET_NAME;

export const REGISTRY_ADDR = scriptAddress(NETWORK_ID, REGISTRY_HASH);
export const PP_ADDR = scriptAddress(NETWORK_ID, PP_POLICY);
export const ALWAYS_FAIL_ADDR = scriptAddress(NETWORK_ID, ALWAYS_FAIL_HASH);

export const plb = (addr) => baseAddress(NETWORK_ID, PLB_HASH, addr);

export const refInput = (index) => ({ txHash: h("9", 64), outputIndex: index });
export const DEPLOYMENT = {
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

export const scriptCred = (hash) => ({ type: "script", hash });

export const PP_DATUM = protocolParamsDatum({
  plgCred: scriptCred(PLG_HASH),
  issuanceLogicCred: scriptCred(ISSUANCE_LOGIC_HASH),
  transferCred: scriptCred(CORE_TRANSFER_HASH),
  thirdPartyCred: scriptCred(THIRD_PARTY_HASH),
  upgradeCred: scriptCred(h("70")),
  pendingUpgradeCred: null,
});

export const node = (key, next) =>
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
export const OWN_NODE = node(TOKEN_POLICY, "ff".repeat(30));
/** The node that COVERS the token — what register inserts after. */
export const COVERING_NODE = node(h("00"), "ff".repeat(30));

export const TARGET_TX_HASH = "7e".repeat(32);
export const TARGET_INDEX = 0;

let utxoSeq = 0;
export function utxo({ address, lovelace = 20_000_000n, units = {}, datum, txHash, index = 0 }) {
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
export const tokenUtxo = (address) =>
  utxo({ address, units: { [UNIT]: 100n }, txHash: TARGET_TX_HASH, index: TARGET_INDEX });

// ---------------------------------------------------------------------------
// The recording client
// ---------------------------------------------------------------------------

/** Thrown from the first `payToAddress`: everything asserted here is decided by then. */
export class HarnessStop extends Error {}

/**
 * @param {Record<string, any[]>} utxosByAddress bech32 → UTxOs. Any address not
 *   named gets two plain wallet UTxOs, so coin selection never starves.
 */
export function makeRig(utxosByAddress = {}) {
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

export const STANDARD_SCRIPTS = {
  // ⚠ `transfer` MUST equal PP_DATUM's transferCred below. programmable_logic_base
  // resolves the withdrawal the params datum names for the transfer dispatch
  // arm, so two different hashes here would model a deployment that cannot
  // transfer at all — and a test built on it would prove nothing about one that
  // can.
  transfer: { hash: CORE_TRANSFER_HASH, compiledCode: "00" },
  programmableLogicBase: { hash: PLB_HASH },
  programmableLogicGlobal: { hash: PLG_HASH },
  thirdParty: { hash: THIRD_PARTY_HASH },
  registry: { hash: REGISTRY_HASH },
  buildIssuanceMint: () => ({ hash: TOKEN_POLICY, compiledCode: "00" }),
};

export function initPlugin(plugin, client) {
  plugin.init({
    client,
    standardScripts: STANDARD_SCRIPTS,
    deployment: DEPLOYMENT,
    network: "preprod",
  });
  return plugin;
}

export const fes = (client) =>
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

export const dummy = (client) => initPlugin(dummySubstandard({ blueprint: DUMMY_BP }), client);

/**
 * Drive one operation and return what the transaction actually aimed at.
 * Errors are captured rather than thrown so a test can assert on the CONTRAST
 * between "no error, wrong address" and "named refusal" — but every caller
 * below asserts on `error` explicitly, so a harness failure cannot pass as a
 * result.
 */
export async function run(makePlugin, operation, params, utxosByAddress) {
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
export function assertRefusedByName(result, { operation, parameter, received = '"" (the empty string)' }) {
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
export function assertTargeted(result, expected, why) {
  assert.ok(result.error instanceof HarnessStop, `the run must reach payToAddress; got: ${result.error?.message}`);
  assert.deepEqual(result.payTo, [expected], why);
}
