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

          // DUMP_TX_STRUCTURE=1 prints the transaction as the VALIDATOR will see
          // it: reference inputs and withdrawals in LEDGER ORDER, which is what
          // every redeemer index points into.
          //
          // This exists because a structural `expect` in a validator fails with
          // an EMPTY TRACE LIST — there is no message naming the index, so the
          // only way to check a computed index is to compare it against the
          // artefact. Reading the code that computes it has been wrong
          // repeatedly; the transaction is the diagnostic.
          if (process.env.DUMP_TX_STRUCTURE) {
            try {
              const body: any = (tx as any).body ?? tx;
              const refs = body.referenceInputs ?? body.reference_inputs;
              console.error("=== TX STRUCTURE (ledger order) ===");
              console.error("reference_inputs:");
              for (const [i, r] of [...(refs ?? [])].entries()) {
                const id = r?.transactionId?.hash ?? r?.transactionId;
                const hex =
                  id instanceof Uint8Array
                    ? Array.from(id, (b: number) => b.toString(16).padStart(2, "0")).join("")
                    : String(id);
                console.error(`  [${i}] ${hex}#${r?.index}`);
              }
              const wdrls = body.withdrawals ?? body.withdrawal;
              console.error("withdrawals:", JSON.stringify(wdrls, (_k, v) =>
                typeof v === "bigint" ? v.toString() : v instanceof Uint8Array
                  ? Array.from(v, (b: number) => b.toString(16).padStart(2, "0")).join("")
                  : v
              )?.slice(0, 600));
              console.error("=== END STRUCTURE ===");
            } catch (e: any) {
              console.error("structure dump failed:", e?.message);
            }
          }
          if (process.env.DUMP_TX_CBOR) {
            console.error(`\n=== OGMIOS EVAL CBOR (${cbor.length} chars) ===`);
            console.error(cbor);
            console.error(`=== END CBOR ===\n`);
          }

          // Convert additional UTxOs to Ogmios format
          const ogmiosAdditionalUtxo = additionalUtxos
            ? toOgmiosAdditionalUtxos(additionalUtxos as UTxO.UTxO[])
            : undefined;

          const params: any = { transaction: { cbor } };
          if (ogmiosAdditionalUtxo && ogmiosAdditionalUtxo.length > 0) {
            // ⚠ additionalUtxo means "UTxOs the ledger does NOT have yet" — the
            // outputs of transactions still in flight. Ogmios REJECTS the whole
            // evaluation if any entry already exists on chain:
            //
            //   "Some user-provided additional UTxO entries overlap with those
            //    that exist in the ledger."
            //
            // Evolution keeps handing us chained outputs after they have been
            // confirmed, so once a fixture awaits each submission — as this one
            // does — every "additional" UTxO is already on chain and the
            // evaluation fails for a reason that has nothing to do with the
            // transaction being evaluated. Ask the ledger which ones it has and
            // send only the genuine remainder.
            const fresh = await withoutOnChainUtxos(ogmiosUrl, ogmiosAdditionalUtxo);
            if (fresh.length > 0) params.additionalUtxo = fresh;
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
/**
 * Drop additional-UTxO entries the ledger already knows about.
 *
 * Queried from Ogmios rather than inferred: a stale local view is exactly what
 * causes the overlap in the first place, so inferring from the same stale view
 * would reproduce the bug.
 */
async function withoutOnChainUtxos(ogmiosUrl: string, entries: any[]): Promise<any[]> {
  const outputReferences = entries.map((e) => ({
    transaction: { id: e.transaction.id },
    index: e.index,
  }));
  try {
    const resp = await fetch(ogmiosUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "queryLedgerState/utxo",
        params: { outputReferences },
        id: null,
      }),
    });
    const json = await resp.json();
    if (!Array.isArray(json?.result)) return entries;
    const onChain = new Set(
      json.result.map((u: any) => `${u.transaction.id}#${u.index}`)
    );
    return entries.filter((e) => !onChain.has(`${e.transaction.id}#${e.index}`));
  } catch {
    // If the query itself fails, send what we had — a possibly-rejected
    // evaluation is better than silently dropping UTxOs a chained transaction
    // genuinely needs.
    return entries;
  }
}

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
