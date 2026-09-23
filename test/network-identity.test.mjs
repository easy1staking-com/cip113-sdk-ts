/**
 * The network label handed to every substandard, and the chain field it is
 * allowed to come from.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR. `CIP113.init` built the plugin context with
 * `network: config.client.chain.id === 1 ? "mainnet" : "preprod"`. `Chain.id`
 * is the NETWORK ID that goes into an address — 1 for mainnet, 0 for every
 * testnet that has ever existed — so it cannot tell preview from preprod. A
 * client pointed at preview was handed `"preprod"`, silently and permanently.
 *
 * ⚠ AND THE TYPE IS HALF THE DEFECT. `SubstandardContext.network` was declared
 * `string`, not `Network`. So `"preview"` was a member of a published union
 * that the code could not produce, and nothing — not the compiler, not a test —
 * ever had to reconcile the declared values with the reachable ones. A looser
 * type is exactly how a value and its own union drift apart in silence.
 *
 * ⚑ THE FOURTH CASE IS THE ONE THAT DECIDES THE DESIGN. A devnet is not
 * mainnet, preprod or preview. `magic === 1 ? "preprod" : "preview"` would be
 * the same defect with different wrong answers, so a chain that is none of the
 * three yields `undefined` — asserted below BY NAME, because "no label" is a
 * decision this suite must defend, not an accident it must tolerate.
 *
 * Every assertion here reads a value the SDK actually produced through the real
 * `CIP113.init`, not a helper called in isolation: the defect lived at the call
 * site, and a test of the mapping alone would have stayed green through it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CIP113,
  networkFromChain,
  mainnetChain,
  preprodChain,
  previewChain,
} from "../dist/index.js";
import * as scriptsModule from "../dist/standard/scripts.js";
import { TARGET_PROTOCOL_VERSION } from "../dist/standard/blueprint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf-8");
const load = (p) => JSON.parse(read(p));

// ⛔ FOLLOWS THE TARGET, NEVER A LITERAL PATH. `validateStandardBlueprint` is a
// version-EQUALITY gate, so a hard-coded directory turns every protocol
// migration into a wall of failures in a file whose subject is the NETWORK
// label and nothing else. MEASURED at the alpha.4 -> alpha.5 bump: five tests
// here went red for a reason none of their names mention.
const blueprint = load(`blueprints/standard/v${TARGET_PROTOCOL_VERSION}/plutus.json`);

// ---------------------------------------------------------------------------
// Scaffolding — a deployment `init` will accept
// ---------------------------------------------------------------------------

/**
 * A self-consistent deployment at the SDK's target version, derived from the
 * blueprint.
 *
 * Scaffolding only: `buildDeploymentScripts` REFUSES a record whose hashes do
 * not reproduce, so `CIP113.init` cannot be reached with an arbitrary object.
 * Nothing about these values is under test here — the subject is the one field
 * `init` computes rather than copies.
 */
function deriveDeployment(bp) {
  const b = scriptsModule.createStandardScripts(bp);

  const PP_TX = { txHash: "aa".repeat(32), outputIndex: 0 };
  const ISS_TX = { txHash: "cc".repeat(32), outputIndex: 1 };
  const REG_TX = { txHash: "bb".repeat(32), outputIndex: 0 };
  const UM_TX = { txHash: "77".repeat(32), outputIndex: 3 };
  const ALWAYS_FAIL = "dd".repeat(28);
  const MAX_INLINE = 512;

  const paramsPolicy = b.protocolParams(PP_TX).hash;
  const plb = b.programmableLogicBase(paramsPolicy).hash;
  const issuanceCborHex = b.issuanceCborHexMint(ISS_TX, ALWAYS_FAIL).hash;
  const registry = b.registry(REG_TX, issuanceCborHex).hash;
  const transfer = b.transfer(plb, registry, MAX_INLINE).hash;
  const thirdParty = b.thirdParty(plb, registry, MAX_INLINE).hash;
  const unfracking = b.unfracking(plb, registry, MAX_INLINE).hash;
  const issuanceLogic = b.issuanceLogic(plb, registry, paramsPolicy, MAX_INLINE).hash;
  const plg = b.programmableLogicGlobal(transfer, thirdParty, unfracking).hash;
  const upgradeMultisig = b.upgradeMultisig(UM_TX).hash;

  const ref = (i) => ({ txHash: "ee".repeat(32), outputIndex: i });

  return {
    txHash: "ee".repeat(32),
    protocolParams: { txInput: PP_TX, policyId: paramsPolicy, utxo: ref(0) },
    programmableLogicBase: { scriptHash: plb },
    transfer: { scriptHash: transfer },
    thirdParty: { scriptHash: thirdParty },
    unfracking: { scriptHash: unfracking },
    programmableLogicGlobal: { scriptHash: plg, unfrackingParameter: unfracking },
    maxInlineDatumBytes: MAX_INLINE,
    upgradeMultisig: { scriptHash: upgradeMultisig, txInput: UM_TX, utxo: ref(6) },
    upgradeMultisigRefInput: ref(7),
    upgradeAuthority: { type: "key", hash: "22".repeat(28) },
    issuanceLogic: { scriptHash: issuanceLogic },
    issuanceLogicRefInput: ref(8),
    issuance: { txInput: ISS_TX, policyId: issuanceCborHex, alwaysFailScriptHash: ALWAYS_FAIL },
    registry: { txInput: REG_TX, issuanceScriptHash: issuanceCborHex, scriptHash: registry },
    programmableBaseRefInput: ref(1),
    programmableLogicGlobalRefInput: ref(2),
    transferRefInput: ref(3),
    thirdPartyRefInput: ref(4),
    unfrackingRefInput: ref(5),
  };
}

const DEPLOYMENT = deriveDeployment(blueprint);

/**
 * Run the real `CIP113.init` against a chain and return the `network` it put
 * in the plugin context.
 *
 * ⚑ The context is captured from a plugin's own `init`, which is the only way a
 * substandard ever sees this field — the same path a third-party plugin takes.
 */
function contextNetworkFor(chain) {
  let captured;
  const capture = {
    id: "capture",
    version: "0.0.0",
    blueprint,
    init(ctx) {
      captured = ctx;
    },
    async register() {
      throw new Error("not used");
    },
    async mint() {
      throw new Error("not used");
    },
    async burn() {
      throw new Error("not used");
    },
    async transfer() {
      throw new Error("not used");
    },
    async thirdPartyTransfer() {
      throw new Error("not used");
    },
  };

  CIP113.init({
    // `init` reads nothing from the client but `chain`; it stores the rest.
    client: { chain },
    standard: { blueprint, deployment: DEPLOYMENT },
    substandards: [capture],
  });

  assert.ok(captured, "the capture plugin's init must have run");
  return { ctx: captured, network: captured.network };
}

/**
 * A devnet-shaped chain: the shape `test/harness/yaci.mjs:getYaciChain()`
 * builds from a local cluster's Shelley genesis — testnet id, its own magic.
 * Built here rather than imported because the harness fetches a LIVE devnet and
 * this suite is offline.
 */
const devnetChain = {
  id: 0,
  name: "Yaci DevKit",
  networkMagic: 42,
  epochLength: 432000,
  slotConfig: { zeroTime: 1_700_000_000_000n, zeroSlot: 0n, slotLength: 1000 },
};

// ---------------------------------------------------------------------------
// The three public networks
// ---------------------------------------------------------------------------

test("⛔ each public chain yields ITS OWN network name through CIP113.init", () => {
  // The real Evolution presets, re-exported by this SDK — not hand-written
  // chain literals. If Evolution ever changes a magic, that arrives here.
  const cases = [
    ["mainnet", mainnetChain],
    ["preprod", preprodChain],
    ["preview", previewChain],
  ];

  const seen = new Map();
  for (const [expected, chain] of cases) {
    const { network } = contextNetworkFor(chain);
    assert.equal(
      network,
      expected,
      `${chain.name} (magic ${chain.networkMagic}) was labelled ${JSON.stringify(network)} — ` +
        `the context network must name the chain the client is actually pointed at`,
    );
    seen.set(expected, network);
  }

  // ⚑ DISTINCTNESS AS ITS OWN ASSERTION. The shipped defect mapped two of these
  // three onto one label; a mapping that collapses any pair again must redden
  // here even if each individual expectation were somehow re-written to match.
  assert.equal(
    new Set(seen.values()).size,
    3,
    `three chains produced ${new Set(seen.values()).size} distinct labels: ` +
      `${JSON.stringify([...seen.values()])}`,
  );
});

test("⛔ REGRESSION: chain.id CANNOT discriminate — it is 0 for both testnets", () => {
  // The measurement that condemns the old derivation, pinned so that nobody
  // reaches for `chain.id` again believing it separates the testnets.
  assert.equal(mainnetChain.id, 1, "mainnet is network id 1");
  assert.equal(preprodChain.id, 0, "preprod is network id 0");
  assert.equal(previewChain.id, 0, "preview is ALSO network id 0 — that is the defect");
  assert.equal(
    preprodChain.id,
    previewChain.id,
    "if these ever differ, the premise of this fix changed and it should be re-argued",
  );

  // …while the magics do discriminate, which is why the fix reads them.
  const magics = [mainnetChain, preprodChain, previewChain].map((c) => c.networkMagic);
  assert.equal(new Set(magics).size, 3, `network magics must be distinct, saw ${magics.join(", ")}`);
  assert.deepEqual(magics, [764824073, 1, 2], "the measured magics, pinned");
});

// ---------------------------------------------------------------------------
// The fourth case
// ---------------------------------------------------------------------------

test("⛔ a DEVNET chain yields undefined — not a public network's name", () => {
  const { network } = contextNetworkFor(devnetChain);

  assert.equal(
    network,
    undefined,
    `a chain that is none of the three public networks was labelled ${JSON.stringify(network)}; ` +
      `the context network must be undefined rather than name a network this client cannot reach`,
  );

  // Named refusals, because each is a wrong answer some plausible fix produces:
  // `chain.id === 1 ? "mainnet" : "preprod"` gives "preprod", and
  // `magic === 1 ? "preprod" : "preview"` gives "preview".
  for (const wrong of ["mainnet", "preprod", "preview"]) {
    assert.notEqual(network, wrong, `a devnet must never be labelled "${wrong}"`);
  }
});

test("⛔ the devnet case is REACHED, not assumed — the field exists and is undefined", () => {
  // ⚠ VACUITY GUARD. `undefined` is what a missing property, a renamed
  // property, or a context that was never built also reads as. This test exists
  // so that "it returned undefined" means "the SDK decided undefined" rather
  // than "nothing answered".
  const { ctx } = contextNetworkFor(devnetChain);

  assert.ok("network" in ctx, "the context must still CARRY a network key, holding undefined");
  assert.ok(ctx.client, "the captured object must be a real context — it carries the client");
  assert.equal(ctx.client.chain.networkMagic, 42, "…and the client is the devnet one");

  // And the same construction on a public chain is NOT undefined, so the
  // machinery above is demonstrably capable of producing a name.
  assert.equal(contextNetworkFor(previewChain).network, "preview");
});

test("networkFromChain is the exported rule, and it agrees with the context", () => {
  // The helper is public surface; a consumer reading `undefined` off the
  // context must be able to reproduce the decision without guessing at it.
  assert.equal(networkFromChain(mainnetChain), "mainnet");
  assert.equal(networkFromChain(preprodChain), "preprod");
  assert.equal(networkFromChain(previewChain), "preview");
  assert.equal(networkFromChain(devnetChain), undefined);

  for (const chain of [mainnetChain, preprodChain, previewChain, devnetChain]) {
    assert.equal(
      contextNetworkFor(chain).network,
      networkFromChain(chain),
      `the context and the exported rule disagree for ${chain.name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The type half of the defect
// ---------------------------------------------------------------------------

test("⛔ the PUBLISHED declaration types network as Network, never as string", () => {
  // Read from `dist/`, not from `src/` — the .d.ts is what a plugin author's
  // compiler actually reads, and `npm test` builds before it runs.
  const dts = read("dist/substandards/interface.d.ts");

  assert.match(
    dts,
    /\n\s*network\?: Network;/,
    "SubstandardContext.network must be declared `network?: Network` in the published types",
  );
  assert.doesNotMatch(
    dts,
    /\n\s*network\??: string;/,
    "`string` is the looseness that let the produced value and the Network union disagree",
  );
  assert.match(
    dts,
    /import type \{[^}]*\bNetwork\b[^}]*\} from "\.\.\/types\.js"/s,
    "the declaration must actually import Network, or the annotation names nothing",
  );
});

test("⛔ the Network union admits no value the SDK cannot produce", () => {
  // The union and the mapping are two lists of the same fact. The defect was
  // that only one of them contained "preview".
  const dts = read("dist/types.d.ts");
  const m = /export type Network = ([^;]+);/.exec(dts);
  assert.ok(m, "dist/types.d.ts must still declare the Network union");

  const members = m[1].split("|").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(
    members.sort(),
    ["mainnet", "preprod", "preview"],
    "the Network union changed — every member must be reachable through networkFromChain",
  );

  // Every declared member must be PRODUCIBLE. A member no chain maps to is the
  // shape of the original defect; a chain mapping outside the union is its
  // inverse.
  const produced = new Set(
    [mainnetChain, preprodChain, previewChain].map((c) => networkFromChain(c)),
  );
  for (const member of members) {
    assert.ok(
      produced.has(member),
      `Network declares "${member}" but no chain produces it — an unreachable union member`,
    );
  }
});
