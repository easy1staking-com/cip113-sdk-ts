import { EvoTransactionHash } from "@easy1staking/cip113-sdk-ts";

type SigningClient = {
  awaitTx: (txHash: any, checkInterval?: number, timeout?: number) => Promise<boolean>;
};

/**
 * Submit a transaction and wait for on-chain confirmation.
 *
 * Uses the SDK's `_signBuilder` for signing (seed wallet auto-signs)
 * and the Evolution SDK's `awaitTx` for polling Blockfrost.
 */
export async function signSubmitAndWait(
  result: { _signBuilder?: any; cbor: string; txHash: string },
  client: SigningClient,
  label: string,
): Promise<string> {
  console.log(`\n[${label}] Signing and submitting...`);

  if (!result._signBuilder) {
    throw new Error(`No _signBuilder on result — was the client a SigningClient?`);
  }

  const txHash = await result._signBuilder.signAndSubmit();
  const txHashHex =
    typeof txHash === "string" ? txHash : EvoTransactionHash.toHex(txHash);

  console.log(`[${label}] Submitted: ${txHashHex}`);
  console.log(`[${label}] Waiting for confirmation...`);

  await client.awaitTx(txHash, 3_000, 120_000);
  console.log(`[${label}] Confirmed!\n`);

  return txHashHex;
}
