import { Effect } from "effect";
import { Transaction, Assets, Address as EvoAddress, Data } from "@evolution-sdk/evolution";
import type { Evaluator, EvaluationContext } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import { EvaluationError } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import type { UTxO } from "@evolution-sdk/evolution";
import { ExUnits } from "@evolution-sdk/evolution/Redeemer";
import { TransactionHash as EvoTransactionHash } from "@evolution-sdk/evolution";
import type { EvalRedeemer } from "@evolution-sdk/evolution/sdk/EvalRedeemer";

/**
 * Blockfrost tx evaluator that dumps the full raw response body on failure.
 * Uses /utils/txs/evaluate/utxos (Ogmios v5 JSONWSP wrapper).
 */
export function createBlockfrostEvaluator(baseUrl: string, projectId: string): Evaluator {
  return {
    evaluate: (
      tx: Transaction.Transaction,
      additionalUtxos: ReadonlyArray<UTxO.UTxO> | undefined,
      _ctx: EvaluationContext,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const cbor = Transaction.toCBORHex(tx);
          console.error(`\n=== BF EVAL CBOR (${cbor.length} chars) ===`);
          console.error(cbor);

          // Use the raw-CBOR endpoint; simpler, no need to JSON-encode the UTxO set.
          const resp = await fetch(`${baseUrl}/utils/txs/evaluate`, {
            method: "POST",
            headers: { "Content-Type": "application/cbor", project_id: projectId },
            body: Buffer.from(cbor, "hex"),
          });
          const text = await resp.text();
          console.error(`\n=== BF EVAL RESPONSE (${resp.status}) ===`);
          console.error(text);
          console.error(`=== END BF EVAL RESPONSE ===\n`);

          const json = JSON.parse(text);
          if (json.result?.EvaluationFailure) {
            throw new Error(`Blockfrost eval failure: ${JSON.stringify(json.result.EvaluationFailure, null, 2)}`);
          }
          const evalResult = json.result?.EvaluationResult;
          if (!evalResult) throw new Error(`No EvaluationResult: ${text.slice(0, 500)}`);

          const out: EvalRedeemer[] = [];
          for (const [key, budget] of Object.entries(evalResult as Record<string, { memory: number; steps: number }>)) {
            const [rawTag, idxStr] = key.split(":");
            const tag = rawTag === "certificate" ? "cert" : rawTag === "withdrawal" ? "reward" : rawTag;
            out.push({
              ex_units: new ExUnits({ mem: BigInt(budget.memory), steps: BigInt(budget.steps) }),
              redeemer_index: parseInt(idxStr, 10),
              redeemer_tag: tag,
            } as EvalRedeemer);
          }
          return out;
        },
        catch: (e) =>
          new EvaluationError({
            message: `Blockfrost eval failed: ${e instanceof Error ? e.message : String(e)}`,
            failures: [],
          }),
      }),
  };
}

function toBlockfrostUtxoSet(utxos: UTxO.UTxO[]): any[] {
  return utxos.map((u) => {
    const txId = EvoTransactionHash.toHex(u.transactionId);
    const addr = EvoAddress.toBech32(u.address);
    const amount: any[] = [{ unit: "lovelace", quantity: Assets.lovelaceOf(u.assets).toString() }];
    for (const unit of Assets.getUnits(u.assets)) {
      if (unit === "lovelace" || unit === "") continue;
      amount.push({ unit, quantity: Assets.getByUnit(u.assets, unit).toString() });
    }
    const entry: any = { txHash: txId, outputIndex: Number(u.index), address: addr, amount };
    const datumOpt = (u as any).datumOption;
    if (datumOpt?._tag === "InlineDatum" && datumOpt.data != null) {
      entry.inlineDatum = Data.toCBORHex(datumOpt.data);
    }
    return entry;
  });
}
