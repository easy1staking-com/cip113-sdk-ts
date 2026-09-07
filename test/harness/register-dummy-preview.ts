/**
 * Register the `dummy` substandard against an EXISTING preview instance.
 *
 * ⛔ WHY THIS EXISTS SEPARATELY FROM `deploy-preview-all.ts`.
 *
 * That script does core bootstrap + FES + dummy in one run, and its first step
 * spends ONE-SHOT seed UTxOs. So it cannot be re-run to retry a later step: the
 * bootstrap would fail on spent seeds, and `saveInstance` would refuse to
 * overwrite the instance record anyway (correctly — that record cannot be
 * regenerated).
 *
 * MEASURED 2026-09-07, alpha.3 preview stand-up: core and FES both succeeded and
 * dummy failed with
 *
 *   Unknown transaction input (missing from UTxO set): <bootstrap>#1
 *
 * which is the UTxO-SET LAG this repo already documents — `/txs/{hash}`
 * returning 200 means the TRANSACTION is indexed, while the EVALUATOR reads a
 * different view that trails it. Nothing was wrong with the deployment; the
 * third step simply ran before the provider agreed the second step's outputs
 * existed. Retrying the step is the fix, and a partial deployment needs a way to
 * be completed rather than restarted.
 *
 *   npx tsx test/harness/register-dummy-preview.ts --instance alpha3
 */
import { readFileSync } from "node:fs";
import {
  previewChain, evoClient, EvoAddress, CIP113, stringToHex, computeScriptHash,
} from "../../dist/index.js";
import { dummySubstandard } from "../../dist/substandards/dummy/index.js";
import { loadStandardBlueprint } from "./bootstrap.js";
import { registerSubstandardCredentials } from "./substandard-setup.js";
import { buildUnparameterisedRecord } from "./cip171-record.js";
import { dummyBlueprintDir, dummyBlueprintPath } from "./paths.js";
import { loadInstance, requireInstanceName } from "./instances.mjs";
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
  // Resolved FIRST, before any chain work — a bad name must fail instantly.
  const instanceName = requireInstanceName("preview");
  const deployment: any = loadInstance("preview", instanceName);

  const env = loadEnv(new URL("../../.env.preview", import.meta.url).pathname);
  const client: any = evoClient(previewChain)
    .withBlockfrost({ projectId: env.BLOCKFROST_KEY, baseUrl: BF })
    .withSeed({ mnemonic: env.WALLET_MNEMONIC });

  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  if (client.chain.id !== 0) throw new Error("refusing: not a testnet");

  const isStakeRegistered = async (stakeAddress: string) => {
    const r = await fetch(`${BF}/accounts/${stakeAddress}`, { headers: { project_id: env.BLOCKFROST_KEY } });
    return r.ok;
  };

  // ⚠ Settle on the UTxO SET, not the transaction index — the distinction that
  // caused the failure this script exists to repair. The registry node the
  // registration spends must be visible to the EVALUATOR, and that view lags.
  const settled = async (txHash: string) => {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${BF}/addresses/${address}/utxos?count=100`, {
        headers: { project_id: env.BLOCKFROST_KEY },
      });
      if (r.ok && (await r.json()).some((u: { tx_hash: string }) => u.tx_hash === txHash)) return;
      await new Promise((res) => setTimeout(res, 5_000));
    }
    throw new Error(`outputs of ${txHash} never reached the UTxO set`);
  };

  console.log(`preview instance "${instanceName}" · bootstrap ${deployment.txHash}`);

  const dummyBp = JSON.parse(readFileSync(dummyBlueprintPath(), "utf-8"));
  const dummyScripts = ["transfer.issue.withdraw", "transfer.transfer.withdraw"].map((title) => {
    const code = dummyBp.validators.find((v: any) => v.title === title)!.compiledCode;
    return { type: "PlutusV3" as const, compiledCode: code, hash: computeScriptHash(code) };
  });
  await registerSubstandardCredentials(dummyScripts, { client, isStakeRegistered });

  const protocol = CIP113.init({
    client,
    standard: { blueprint: loadStandardBlueprint(), deployment },
    substandards: [dummySubstandard({ blueprint: dummyBp })],
  });

  // Dummy's validators take NO parameters, so the record states that positively
  // rather than omitting them — the registry finalises such scripts as
  // NONE_REQUIRED, which is the opposite of PARTIAL.
  const record: any = buildUnparameterisedRecord(dummyBlueprintDir());
  const assetName = stringToHex("DUM") + deployment.txHash.slice(0, 6);

  const reg = await protocol.register("dummy", {
    feePayerAddress: address, assetName, quantity: 1_000n, cip171Record: record,
  });
  await reg._signBuilder.signAndSubmit();
  await settled(reg.txHash);
  console.log(`dummy registration tx: ${reg.txHash}  (${record.scripts.length} scripts, ${record.compilerVersion})`);
  console.log(`asset name: ${assetName}`);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  console.error("REASON:\n  | " + explainError(e));
  process.exitCode = 1;
});
