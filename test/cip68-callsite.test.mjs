/**
 * The FES call site must pass the deployment's inline-datum bound to the
 * refusal helper. The helper's own tests cannot distinguish that from a
 * caller which substitutes the fixture's usual 1024-byte bound.
 *
 * This drives the plugin directly because CIP113.init correctly rejects a
 * deployment whose bound no longer matches its four parameterised scripts.
 * The refusal runs before any client read, so the client is deliberately only
 * large enough for plugin initialisation; any later access fails loudly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EvoData, buildCIP68FTDatum } from "../dist/index.js";
import { freezeAndSeizeSubstandard } from "../dist/substandards/freeze-and-seize/index.js";

const BP = JSON.parse(
  readFileSync(
    new URL("../blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json", import.meta.url),
    "utf8",
  ),
);
const H28 = "ab".repeat(28);
const DEPLOYMENT_BOUND = 512;

test("FES register reads maxInlineDatumBytes from its deployment at the call site", async () => {
  let clientReads = 0;
  const client = new Proxy(
    { chain: { id: 0 } },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        clientReads += 1;
        throw new Error(`unexpected client access: ${String(property)}`);
      },
    },
  );
  const plugin = freezeAndSeizeSubstandard({
    blueprint: BP,
    deployment: {
      adminPkh: H28,
      assetName: "4142",
      blacklistNodePolicyId: H28,
      blacklistInitTxInput: { txHash: "cd".repeat(32), outputIndex: 0 },
    },
  });
  plugin.init({
    client,
    standardScripts: {
      programmableLogicBase: { hash: H28 },
      buildIssuanceMint: () => ({ hash: H28 }),
    },
    deployment: { maxInlineDatumBytes: DEPLOYMENT_BOUND },
    network: "preprod",
  });

  const metadata = { name: "Callsite", description: "D".repeat(600) };
  const measured = EvoData.toCBORBytes(buildCIP68FTDatum(metadata)).length;
  assert.ok(measured > DEPLOYMENT_BOUND && measured < 1_024, "fixture must distinguish 512 from 1024");

  await assert.rejects(
    plugin.register({
      feePayerAddress: "addr_test1stub",
      assetName: "4142",
      quantity: 1n,
      cip68Metadata: metadata,
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /maxInlineDatumBytes/);
      assert.match(err.message, /512/, "the refusal must name the deployment's 512-byte bound");
      return true;
    },
  );
  assert.equal(clientReads, 0, "the deployment-bound refusal must precede every client access");
});
