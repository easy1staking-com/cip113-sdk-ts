/**
 * Preview: core deployment + FES registration + dummy registration, each
 * carrying its own CIP-171 provenance record on the transaction that creates
 * the thing the record describes.
 *
 * Run by hand; it writes permanent state to a shared chain.
 *   npx tsx test/harness/deploy-preview-all.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  previewChain, evoClient, EvoAddress, EvoAssets, CIP113, stringToHex, computeScriptHash,
} from "../../dist/index.js";
import { freezeAndSeizeSubstandard } from "../../dist/substandards/freeze-and-seize/index.js";
import { dummySubstandard } from "../../dist/substandards/dummy/index.js";
import { bootstrapProtocol, loadStandardBlueprint } from "./bootstrap.js";
import { makeFesFixture } from "./fes-setup.js";
import { registerSubstandardCredentials } from "./substandard-setup.js";
import { buildDeploymentRecord, buildUnparameterisedRecord } from "./cip171-record.js";
import { fesBlueprintDir, dummyBlueprintDir, dummyBlueprintPath } from "./paths.js";
import { explainError } from "./explain-error.js";

const BF = "https://cardano-preview.blockfrost.io/api/v0";

function loadEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
  );
}

async function main() {
  const env = loadEnv(new URL("../../.env.preview", import.meta.url).pathname);
  const client: any = evoClient(previewChain)
    .withBlockfrost({ projectId: env.BLOCKFROST_KEY, baseUrl: BF })
    .withSeed({ mnemonic: env.WALLET_MNEMONIC });

  // Poll the same source we will read the deployment back from. Evolution's
  // awaitTx timed out at 90s on preview while the transaction was already in a
  // block — a deployment aborting on a transaction that had succeeded.
  // ⚠ TX VISIBILITY IS NOT UTxO-SET VISIBILITY. `/txs/{hash}` returning 200
  // means the transaction is indexed; the evaluator reads a DIFFERENT view, and
  // that one lags. Building against outputs the evaluator cannot see yet fails
  // with "Unknown transaction input (missing from UTxO set)" — code 3117, which
  // reads like a malformed transaction and is really a race.
  //
  // So settle on the thing that will actually be consulted: wait until the new
  // outputs are in the ADDRESS's UTxO set, not merely until the tx is indexed.
  const settleOutputs = async (txHash: string) => {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${BF}/addresses/${address}/utxos?count=100`, {
        headers: { project_id: env.BLOCKFROST_KEY },
      });
      if (r.ok) {
        const utxos: Array<{ tx_hash: string }> = await r.json();
        if (utxos.some((u) => u.tx_hash === txHash)) return;
      }
      await new Promise((res) => setTimeout(res, 5_000));
    }
    throw new Error(`outputs of ${txHash} never reached the UTxO set`);
  };

  const awaitTx = async (txHash: string) => {
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${BF}/txs/${txHash}`, { headers: { project_id: env.BLOCKFROST_KEY } });
      if (r.ok) break;
      await new Promise((res) => setTimeout(res, 5_000));
    }
    // ⚠ AND THEN WAIT FOR THE UTxO SET, WHICH IS A DIFFERENT VIEW AND LAGS THE
    // TRANSACTION INDEX. Waiting only on `/txs/{hash}` leaves the NEXT
    // transaction selecting inputs this one already spent — the ledger answers
    // "All inputs are spent. Transaction has probably already been included",
    // which reads like a duplicate submission and is really a stale read.
    // MEASURED: it killed tx2 of the bootstrap immediately after tx1 landed.
    await settleOutputs(txHash);
  };

  const isStakeRegistered = async (stakeAddress: string) => {
    const r = await fetch(`${BF}/accounts/${stakeAddress}`, { headers: { project_id: env.BLOCKFROST_KEY } });
    return r.ok;
  };

  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  const bal = (await client.getUtxos(addressObj)).reduce((s: bigint, u: any) => s + EvoAssets.lovelaceOf(u.assets), 0n);
  console.log(`preview · ${address}\nbalance: ${Number(bal) / 1e6} ADA\n`);
  if (client.chain.id !== 0) throw new Error("refusing: not a testnet");

  // ---- 1. CORE ------------------------------------------------------------
  console.log("[1/3] core bootstrap (record attached to the bootstrap tx)...");
  const deployment: any = await bootstrapProtocol({ client, isStakeRegistered, awaitTx });
  console.log(`      bootstrap tx: ${deployment.txHash}`);
  writeFileSync(
    new URL("../../deployment-preview.json", import.meta.url).pathname,
    JSON.stringify(deployment, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
  );

  const plb = deployment.programmableLogicBase.scriptHash;
  const suffix = deployment.txHash.slice(0, 6);

  // ---- 2. FES REGISTRATION ------------------------------------------------
  console.log("[2/3] FES registration (record attached to the registration tx)...");
  const fesAsset = stringToHex("FES") + suffix;
  const fes: any = await makeFesFixture(client, address, fesAsset, plb);
  const fesProtocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [freezeAndSeizeSubstandard({ blueprint: fes.blueprint, deployment: fes.deployment })],
  });
  const init = await fesProtocol.compliance.init("freeze-and-seize", {
    feePayerAddress: address, adminAddress: address, assetName: fesAsset,
  });
  await init._signBuilder.signAndSubmit();
  await awaitTx(init.txHash);
  await registerSubstandardCredentials(fes.withdrawScripts.slice(1), { client, isStakeRegistered });
  const fesRecord: any = buildDeploymentRecord(fesBlueprintDir(), fes.paramEvents);
  const fesReg = await fesProtocol.register("freeze-and-seize", {
    feePayerAddress: address, assetName: fesAsset, quantity: 1_000n, cip171Record: fesRecord,
  });
  await fesReg._signBuilder.signAndSubmit();
  await awaitTx(fesReg.txHash);
  console.log(`      FES registration tx: ${fesReg.txHash}  (${fesRecord.scripts.length} scripts, ${fesRecord.compilerVersion})`);

  // ---- 3. DUMMY REGISTRATION ---------------------------------------------
  console.log("[3/3] dummy registration (record attached to the registration tx)...");
  const dummyBp = JSON.parse(readFileSync(dummyBlueprintPath(), "utf-8"));
  const dummyScripts = ["transfer.issue.withdraw", "transfer.transfer.withdraw"].map((title) => {
    const code = dummyBp.validators.find((v: any) => v.title === title)!.compiledCode;
    return { type: "PlutusV3" as const, compiledCode: code, hash: computeScriptHash(code) };
  });
  await registerSubstandardCredentials(dummyScripts, { client, isStakeRegistered });
  const dummyProtocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [dummySubstandard({ blueprint: dummyBp })],
  });
  // Dummy's validators take NO parameters, so its record states that positively
  // rather than omitting them — the registry finalises such scripts as
  // NONE_REQUIRED, which is the opposite of PARTIAL.
  const dummyRecord: any = buildUnparameterisedRecord(dummyBlueprintDir());
  const dummyReg = await dummyProtocol.register("dummy", {
    feePayerAddress: address, assetName: stringToHex("DUM") + suffix, quantity: 1_000n,
    cip171Record: dummyRecord,
  });
  await dummyReg._signBuilder.signAndSubmit();
  await awaitTx(dummyReg.txHash);
  console.log(`      dummy registration tx: ${dummyReg.txHash}  (${dummyRecord.scripts.length} scripts, ${dummyRecord.compilerVersion})`);

  console.log(`\nTX HASHES\n  core     ${deployment.txHash}\n  fes      ${fesReg.txHash}\n  dummy    ${dummyReg.txHash}`);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  console.error("REASON:\n  | " + explainError(e));
  process.exitCode = 1;
});
