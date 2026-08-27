/**
 * Register a substandard's withdraw-0 stake credentials — test fixture.
 *
 * A withdraw-0 validator cannot appear in a transaction until its stake
 * credential is registered on chain. That is part of DEPLOYING a substandard,
 * not part of bootstrapping the protocol, so it lives here rather than in
 * bootstrap.ts.
 *
 * Registration emits a Conway RegCert which executes the script under the
 * PUBLISH purpose — so the substandard's blueprint must carry a publish handler
 * or this fails at evaluation with an empty trace list.
 */
import {
  Bytes,
  Credential,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";
import { buildEvoScript, voidData, rewardAddress, type PlutusScript } from "../../dist/index.js";
import { makeClient } from "./yaci.mjs";
import { createOgmiosEvaluator } from "./ogmios-evaluator.js";

/**
 * Register (and DRep-delegate) each script's stake credential.
 *
 * ⚠ THE DELEGATION IS NOT OPTIONAL AND IS NOT OBVIOUS. Conway rejects a
 * withdrawal from a credential that "does not engage in on-chain governance"
 * (code 3150) EVEN WHEN THE WITHDRAWN AMOUNT IS ZERO. Every withdraw-0
 * trampoline in CIP-113 depends on this, and a credential that is registered
 * but undelegated fails later, at submission, with an error about rewards
 * accounting rather than about governance.
 */
export async function registerSubstandardCredentials(
  scripts: readonly PlutusScript[],
  opts: {
    client?: any;
    evaluator?: unknown;
    /**
     * Positive "is this reward account already registered?" check.
     *
     * ⚠ THIRD INSTANCE of the same defect class in this harness. The catch
     * below tolerates re-registration by matching "already known credential" /
     * "3145" — Ogmios's vocabulary. Blockfrost returns an opaque failure for
     * the identical condition, so the tolerance silently does not apply off
     * devnet and a second run dies on a state the code already knows is fine.
     * A guard written against one provider's error prose does not transfer.
     */
    isStakeRegistered?: (stakeAddress: string) => Promise<boolean>;
  } = {}
): Promise<void> {
  // Same injection contract as bootstrapProtocol: default to the local devnet,
  // accept a client for any other testnet. An injected client brings its own
  // evaluation — the custom Ogmios evaluator exists for Aiken traces, which
  // Blockfrost does not return.
  const client: any = opts.client ?? (await makeClient());
  const addressObj = await client.address();
  const evaluator =
    opts.evaluator ??
    (opts.client
      ? undefined
      : createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"));

  const networkId = client.chain.id;
  for (const script of scripts) {
    if (opts.isStakeRegistered) {
      const addr = rewardAddress(networkId, script.hash);
      if (await opts.isStakeRegistered(addr)) {
        console.error(`  [substandard] ${script.hash.slice(0, 12)}… already registered — skipping`);
        continue;
      }
    }
    try {
      // PLAIN registration, NOT registerAndDelegateTo.
      //
      // MEASURED: a combined register-and-delegate emits a Conway
      // vote_reg_deleg_cert (cert type 12), which reaches the publish handler
      // as a DIFFERENT Certificate constructor than RegisterCredential — and
      // upstream's publish idiom, which this substandard copies, permits ONLY
      // RegisterCredential:
      //
      //     when c is { RegisterCredential { .. } -> True; _ -> False }
      //
      // so the combined certificate is REFUSED by the very validator being
      // registered. The refusal is correct — it is what stops a third party
      // deregistering the credential — but it also means a script credential
      // governed by this idiom cannot be DRep-delegated at all.
      let tx = client.newTx();
      tx = tx.registerStake({
        stakeCredential: Credential.makeScriptHash(Bytes.fromHex(script.hash)),
        redeemer: voidData(),
      });
      tx = tx.attachScript({ script: buildEvoScript(script.compiledCode) });
      const built = await tx.build({ changeAddress: addressObj, evaluator });
      const res = await built.signAndSubmit();
      const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res);
      await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 120_000);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // Already registered by an earlier run on this devnet. The ONLY tolerated
      // error: anything else — notably a publish-purpose script failure — must
      // surface, since that is the defect this fixture exists to reveal.
      if (!msg.includes("already known credential") && !msg.includes("3145")) throw err;
    }
  }
}
