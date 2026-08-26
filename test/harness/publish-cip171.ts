/**
 * Publish a CIP-171 record in its own transaction.
 *
 * A standalone record is valid and is what the reference registry itself
 * emits: its ingest filters on `label == 1984` alone and never sees the
 * transaction's scripts, so association happens later, BY SCRIPT HASH, at
 * lookup time. Every historical mainnet record is a metadata-only
 * self-payment of exactly this shape.
 *
 * Used for substandard registration, where the deploying transaction is built
 * by SDK API rather than by this harness — attaching metadata there would mean
 * changing a public signature that a consumer is mid-migration onto, for no
 * gain the format requires.
 */
import { CIP171_METADATA_LABEL, buildCip171Metadatum, outputAssets } from "../../dist/index.js";

export async function publishCip171Record(
  client: any,
  record: unknown,
  evaluator?: unknown
): Promise<string> {
  const chunks = buildCip171Metadatum(record as never);
  const addressObj = await client.address();

  let tx = client.newTx();
  tx = tx.attachMetadata({ label: CIP171_METADATA_LABEL, metadata: chunks });
  tx = tx.payToAddress({ address: addressObj, assets: outputAssets(2_000_000n) });

  const built = await tx.build(
    evaluator ? { changeAddress: addressObj, evaluator } : { changeAddress: addressObj }
  );
  const res = await built.signAndSubmit();
  const { TransactionHash } = await import("@evolution-sdk/evolution");
  const hash = typeof res === "string" ? res : TransactionHash.toHex(res as never);
  await client.awaitTx(TransactionHash.fromHex(hash), 2_000, 180_000);
  return hash;
}
