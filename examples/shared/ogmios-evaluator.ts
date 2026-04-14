/**
 * Custom Ogmios transaction evaluator.
 *
 * Uses a local Ogmios instance for tx evaluation instead of Blockfrost.
 * Returns detailed error messages including Aiken stack traces.
 */

import { Effect } from "effect";
import { Transaction, Address as EvoAddress, Assets, Data } from "@evolution-sdk/evolution";
import type { Evaluator, EvaluationContext } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import { EvaluationError } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import type { EvalRedeemer } from "@evolution-sdk/evolution/sdk/EvalRedeemer";
import type { UTxO } from "@evolution-sdk/evolution";
import { ExUnits } from "@evolution-sdk/evolution/Redeemer";
import { TransactionHash as EvoTransactionHash } from "@evolution-sdk/evolution";

/**
 * Create an Ogmios evaluator that calls a local Ogmios instance.
 * On failure, logs the full error including Aiken stack traces.
 */
export function createOgmiosEvaluator(ogmiosUrl: string): Evaluator {
  return {
    evaluate: (
      tx: Transaction.Transaction,
      additionalUtxos: ReadonlyArray<UTxO.UTxO> | undefined,
      _context: EvaluationContext,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const cbor = Transaction.toCBORHex(tx);

          // Convert additional UTxOs to Ogmios format
          const ogmiosAdditionalUtxo = additionalUtxos
            ? toOgmiosAdditionalUtxos(additionalUtxos as UTxO.UTxO[])
            : undefined;

          const params: any = { transaction: { cbor } };
          if (ogmiosAdditionalUtxo && ogmiosAdditionalUtxo.length > 0) {
            params.additionalUtxo = ogmiosAdditionalUtxo;
          }

          const resp = await fetch(ogmiosUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "evaluateTransaction",
              params,
              id: null,
            }, (_key, value) => typeof value === "bigint" ? Number(value) : value),
          });

          const json = await resp.json();

          if (json.error) {
            console.error("\n=== OGMIOS EVALUATION ERROR ===");
            console.error(JSON.stringify(json.error, null, 2));
            console.error("===============================\n");
            throw new Error(json.error.message || JSON.stringify(json.error));
          }

          if (!json.result || !Array.isArray(json.result)) {
            console.error("\n=== OGMIOS UNEXPECTED RESPONSE ===");
            console.error(JSON.stringify(json, null, 2));
            console.error("==================================\n");
            throw new Error("Unexpected Ogmios response");
          }

          // Map Ogmios result to EvalRedeemer format
          const evalRedeemers: EvalRedeemer[] = json.result.map((item: any) => {
            const purpose = item.validator.purpose as string;
            let tag: string;
            if (purpose === "publish") tag = "cert";
            else if (purpose === "withdraw") tag = "reward";
            else tag = purpose;

            return {
              ex_units: new ExUnits({
                mem: BigInt(item.budget.memory),
                steps: BigInt(item.budget.cpu),
              }),
              redeemer_index: item.validator.index,
              redeemer_tag: tag,
            } as EvalRedeemer;
          });

          return evalRedeemers;
        },
        catch: (e) =>
          new EvaluationError({
            message: `Ogmios evaluation failed: ${e instanceof Error ? e.message : String(e)}`,
            failures: [],
          }),
      }),
  };
}

/**
 * Convert Evolution SDK UTxOs to Ogmios additionalUtxo format.
 * Ogmios expects: [{ transaction: { id }, index, address, value, datum?, script? }]
 */
function toOgmiosAdditionalUtxos(utxos: UTxO.UTxO[]): any[] {
  return utxos.map((utxo) => {
    const txId = EvoTransactionHash.toHex(utxo.transactionId);
    const address = EvoAddress.toBech32(utxo.address);

    // Build Ogmios value format: { ada: { lovelace }, ...policyId: { assetName: qty } }
    const lovelace = Assets.lovelaceOf(utxo.assets);
    const value: any = { ada: { lovelace: Number(lovelace) } };
    const units = Assets.getUnits(utxo.assets);
    for (const unit of units) {
      if (unit === "lovelace" || unit === "") continue;
      const policyId = unit.slice(0, 56);
      const assetName = unit.slice(56);
      if (!value[policyId]) value[policyId] = {};
      value[policyId][assetName] = Number(Assets.getByUnit(utxo.assets, unit));
    }

    const entry: any = {
      transaction: { id: txId },
      index: Number(utxo.index),
      address,
      value,
    };

    // Include inline datum as CBOR hex (Ogmios expects a hex string, not an object)
    const datumOpt = (utxo as any).datumOption;
    if (datumOpt?._tag === "InlineDatum" && datumOpt.data != null) {
      entry.datum = Data.toCBORHex(datumOpt.data);
    } else if (datumOpt?._tag === "DatumHash" && datumOpt.hash != null) {
      entry.datumHash = Buffer.from(datumOpt.hash).toString("hex");
    }

    return entry;
  });
}
