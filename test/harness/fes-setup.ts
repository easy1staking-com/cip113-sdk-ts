/**
 * freeze-and-seize setup — test fixture.
 *
 * FES cannot simply be constructed and used the way `dummy` can. Its
 * `blacklist_mint` policy is parameterised by `blacklistInitTxInput` — THE VERY
 * UTxO that `initCompliance` then consumes — so the ordering is forced:
 *
 *   1. choose a wallet UTxO
 *   2. derive `blacklist_mint` FROM it, giving the blacklist policy id
 *   3. construct the plugin with that policy id AND that UTxO
 *   4. only now run `initCompliance`, which spends the UTxO and mints the
 *      blacklist origin node
 *
 * Steps 2 and 3 cannot be swapped: the policy does not exist until the UTxO is
 * chosen, and the plugin will not accept a policy that was not derived from the
 * UTxO it is also given.
 *
 * ⚠ AND THE WINDOW BETWEEN 1 AND 4 IS HOSTILE. Once a UTxO is chosen, ANY other
 * transaction submitted from the same wallet can consume it through ordinary
 * coin selection — after which init fails with "Bootstrap UTxO not found
 * on-chain", an error that names the UTxO and says nothing about who took it.
 * MEASURED: registering the substandard's withdraw-0 credentials in that window
 * did exactly this. Run initCompliance FIRST and close the window; everything
 * else FES needs can follow.
 */
import { readFileSync } from "node:fs";
import {
  Address as EvoAddress,
  Assets as EvoAssets,
  type UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";
import { createFESScripts } from "../../dist/substandards/freeze-and-seize/index.js";
import { paymentCredentialHash, computeScriptHash, type PlutusScript } from "../../dist/index.js";
import { fesBlueprintPath } from "./paths.js";
import type { ParameterizationEvent } from "../../dist/standard/scripts.js";

export interface FesFixture {
  /** Every FES parameterisation, in call order — the CIP-171 record's source. */
  paramEvents: ParameterizationEvent[];
  /** Ready to hand to `freezeAndSeizeSubstandard({ blueprint, deployment })`. */
  deployment: {
    adminPkh: string;
    assetName: string;
    blacklistNodePolicyId: string;
    blacklistInitTxInput: { txHash: string; outputIndex: number };
  };
  blueprint: unknown;
  /** The two withdraw-0 scripts whose stake credentials must be registered. */
  withdrawScripts: PlutusScript[];
}

/**
 * Derive an FES fixture against a live wallet.
 *
 * `assetNameHex` participates in `issuer_admin`'s parameterisation, so a
 * different asset name is a different issuer-admin script — not merely a
 * different token.
 */
export async function makeFesFixture(
  client: any,
  adminAddress: string,
  assetNameHex: string,
  /**
   * programmable_logic_base's hash from the deployment. FES's own `transfer`
   * validator is parameterised by it, so the fixture cannot derive that script
   * — and therefore cannot say which credentials need registering — without it.
   */
  plbHash: string
): Promise<FesFixture> {
  const blueprint = JSON.parse(readFileSync(fesBlueprintPath(), "utf-8"));
  // Recorded so a CIP-171 record for FES can be DERIVED from the calls that
  // actually parameterise its validators, exactly as the standard chain does.
  const paramEvents: ParameterizationEvent[] = [];
  const fes = createFESScripts(blueprint, (e) => paramEvents.push(e));
  const adminPkh = paymentCredentialHash(adminAddress);

  // Pick the bootstrap UTxO EXPLICITLY, and pick a fat one: it has to survive
  // being an input to initCompliance alongside the fees, and a dust UTxO makes
  // the failure look like a script problem rather than a funding one.
  const utxos: EvoUTxO.UTxO[] = await client.getUtxos(EvoAddress.fromBech32(adminAddress));
  const usable = utxos
    .filter((u) => EvoAssets.lovelaceOf(u.assets) >= 10_000_000n)
    .sort((a, b) => Number(EvoAssets.lovelaceOf(b.assets) - EvoAssets.lovelaceOf(a.assets)));
  if (usable.length === 0) {
    throw new Error(
      `No wallet UTxO with >= 10 ADA to bootstrap the blacklist from (${utxos.length} UTxOs seen)`
    );
  }
  const chosen = usable[0]!;
  const blacklistInitTxInput = {
    txHash: (await import("@evolution-sdk/evolution")).TransactionHash.toHex(chosen.transactionId),
    outputIndex: Number(chosen.index),
  };

  // Derive the policy FROM the chosen UTxO. This is the step whose order is
  // load-bearing.
  const blacklistMint = fes.buildBlacklistMint(blacklistInitTxInput, adminPkh);

  const issuerAdmin = fes.buildIssuerAdmin(adminPkh, assetNameHex);
  // FES's transfer logic is parameterised by BOTH the PLB hash and the
  // blacklist policy — so it only exists once the blacklist policy above does.
  const fesTransfer = fes.buildTransfer(plbHash, blacklistMint.hash);
  // Built so the CIP-171 record COVERS it. The plugin derives blacklist_spend
  // internally from the same policy id, so this parameterisation is identical
  // to the one actually deployed — but the plugin's own script factory has no
  // recorder attached, so without this call the validator is simply absent
  // from the record and the registry reports it PARTIAL with 0 of 1 parameters.
  // MEASURED on core's first live record: an uncovered validator does not
  // fail loudly, it reports a null finalHash inside a VERIFIED record.
  fes.buildBlacklistSpend(blacklistMint.hash);

  return {
    paramEvents,
    blueprint,
    deployment: {
      adminPkh,
      assetName: assetNameHex,
      blacklistNodePolicyId: blacklistMint.hash,
      blacklistInitTxInput,
    },
    // BOTH are withdraw-0 and both must be registered before any FES operation
    // can be built. `issuer_admin` authorises issuance and administration;
    // `transfer` is the per-transfer compliance check.
    withdrawScripts: [
      { type: "PlutusV3", compiledCode: issuerAdmin.compiledCode, hash: issuerAdmin.hash },
      { type: "PlutusV3", compiledCode: fesTransfer.compiledCode, hash: fesTransfer.hash },
    ],
  };
}

export { computeScriptHash };
