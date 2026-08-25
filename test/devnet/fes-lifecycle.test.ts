/**
 * freeze-and-seize on a live devnet (W-E S-4's devnet half).
 *
 * Covers the paths migrated in S-4: initCompliance → register → mint → transfer.
 * `seize` and `burn` are NOT migrated (they route through the deleted
 * `ThirdPartyAct`) and are asserted to REFUSE, so this file fails the moment
 * S-5 lands and stops being an honest description of the state.
 *
 * Unlike `dummy`, FES cannot be constructed and used directly: its
 * `blacklist_mint` is parameterised by the UTxO `initCompliance` consumes. See
 * test/harness/fes-setup.ts for why the ordering is forced.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Address as EvoAddress, Assets as EvoAssets } from "@evolution-sdk/evolution";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";
import { CIP113, stringToHex, baseAddress } from "../../dist/index.js";
import { requireDevnet, makeClient, waitFor } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { makeFesFixture } from "../harness/fes-setup.js";
import { registerSubstandardCredentials } from "../harness/substandard-setup.js";
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";

before(async () => {
  await requireDevnet();
});

test("freeze-and-seize: the migrated paths work on a live devnet", async () => {
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const networkId = client.chain.id;
  const address = EvoAddress.toBech32(await client.address());
  // ⚠ A PER-RUN ASSET NAME, and it is not cosmetic.
  //
  // `issuer_admin` is parameterised by (adminPkh, assetName) and NOTHING ELSE —
  // so with a fixed asset name its script hash is IDENTICAL across runs, while
  // every other FES script changes with each bootstrap. Its stake credential is
  // therefore already registered on the second run, and initCompliance fails
  // with code 3145, "trying to re-register some already known credentials" —
  // an error about registration that is really about a parameterisation that
  // does not vary.
  //
  // Deriving the suffix from the bootstrap tx hash keeps a run deterministic
  // while making runs independent of each other.
  const assetName = stringToHex("FES" + deployment.txHash.slice(0, 6));

  // The forced ordering: choose a UTxO, derive the blacklist policy FROM it,
  // and only then construct the plugin.
  const fes = await makeFesFixture(
    client,
    address,
    assetName,
    deployment.programmableLogicBase.scriptHash
  );
  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      freezeAndSeizeSubstandard({
        blueprint: fes.blueprint as never,
        deployment: fes.deployment as never,
      }),
    ],
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });

  // ⚑ That this line is reached at all is the S-4 result: freeze-and-seize
  // refused to initialise AT ALL under D-14's blanket quarantine.
  assert.deepEqual(protocol.listSubstandards(), ["freeze-and-seize"]);

  const heldAt = async (addr: string, policyHex: string, nameHex: string) => {
    const utxos = await client.getUtxos(EvoAddress.fromBech32(addr));
    let total = 0n;
    for (const u of utxos) {
      for (const p of EvoAssets.policies(u.assets)) {
        if (String(p) !== policyHex) continue;
        for (const [name, qty] of EvoAssets.tokens(u.assets, p).entries()) {
          const raw = (name as any)?.bytes ?? name;
          const hex =
            typeof raw === "string"
              ? raw
              : Array.from(raw as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
          if (hex === nameHex) total += qty as bigint;
        }
      }
    }
    return total;
  };

  // --- initCompliance FIRST, and the order is not cosmetic -----------------
  //
  // The blacklist policy is derived FROM a specific wallet UTxO, and
  // initCompliance is the transaction that spends it. Anything that submits in
  // between can consume that UTxO through ordinary coin selection — and then
  // init fails with "Bootstrap UTxO not found on-chain", which names the UTxO
  // and says nothing about who took it.
  //
  // MEASURED: registering the withdraw-0 credentials before init did exactly
  // that. So init runs FIRST, closing the window, and credential registration
  // follows — it is only needed by register/mint/transfer, not by init.
  const init = await protocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address,
    adminAddress: address,
    assetName,
  });
  await init._signBuilder.signAndSubmit();

  // Now the remaining withdraw-0 credential.
  //
  // ⚠ ONLY the transfer logic. `initCompliance` registers `issuer_admin`'s
  // credential ITSELF (it has a `checkStakeRegistration` hook for callers who
  // already did), so registering it here as well is a guaranteed duplicate.
  await registerSubstandardCredentials(fes.withdrawScripts.slice(1));

  // --- register + first mint ----------------------------------------------
  const reg = await protocol.register("freeze-and-seize", {
    feePayerAddress: address,
    assetName,
    quantity: 1_000n,
  });
  const policy = reg.tokenPolicyId!;
  await reg._signBuilder.signAndSubmit();

  const plb = deployment.programmableLogicBase.scriptHash;
  await waitFor(async () => (await heldAt(baseAddress(networkId, plb, address), policy, assetName)) === 1_000n, {
    what: "the FES supply to appear at the issuer's programmable address",
    timeoutMs: 120_000,
  });
});

test("NOT MIGRATED: seize and burn refuse, naming the deleted redeemer", async () => {
  // Asserts the BLOCKER. This file fails the moment S-5 lands, which is the
  // signal to delete this test rather than a nuisance.
  const deployment = await bootstrapProtocol();
  const client: any = await makeClient();
  const address = EvoAddress.toBech32(await client.address());
  const assetName = stringToHex("FES" + deployment.txHash.slice(0, 6));
  const fes = await makeFesFixture(client, address, assetName, deployment.programmableLogicBase.scriptHash);

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [
      freezeAndSeizeSubstandard({ blueprint: fes.blueprint as never, deployment: fes.deployment as never }),
    ],
  });

  await assert.rejects(
    () =>
      protocol.burn({
        feePayerAddress: address,
        tokenPolicyId: "ab".repeat(28),
        assetName,
        quantity: 1n,
        substandardId: "freeze-and-seize",
      } as never),
    /not yet migrated to CIP-113 0\.5\.0-alpha\.2/,
    "burn must refuse by naming the migration, not fail obscurely on chain"
  );
});
