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
  DRep,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";
import { buildEvoScript, voidData, type PlutusScript } from "../../dist/index.js";
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
  scripts: readonly PlutusScript[]
): Promise<void> {
  const client: any = await makeClient();
  const addressObj = await client.address();
  const evaluator = createOgmiosEvaluator(
    process.env.OGMIOS_URL ?? "http://localhost:1337"
  );

  for (const script of scripts) {
    try {
      let tx = client.newTx();
      tx = tx.registerAndDelegateTo({
        stakeCredential: Credential.makeScriptHash(Bytes.fromHex(script.hash)),
        drep: new DRep.AlwaysAbstainDRep({}),
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
