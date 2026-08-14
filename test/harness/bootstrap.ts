/**
 * CIP-113 protocol bootstrap — test fixture.
 *
 * Deploys a fresh protocol instance into a local devnet and returns the
 * resulting DeploymentParams, so devnet tests have something to operate
 * against. `DeploymentParams` is an INPUT to this SDK; producing one is
 * otherwise another system's job.
 *
 * This exists under the constitution's scoped exception (approved 2026-08-14):
 * bootstrap code that stands up a test fixture is permitted provided it lives
 * under the test tree, is excluded from the npm tarball, and is never presented
 * as a supported way to deploy a production protocol. It is not. Do not point
 * this at preprod or mainnet.
 *
 * Ported from the abandoned bafin branch (examples/bafin/00-deploy-standard.ts)
 * with two deliberate differences:
 *
 *  1. NO CIP-171 METADATA. The original emitted a label-1984 record reading its
 *     commit from UPSTREAM.json. That record is a permanent, public on-chain
 *     claim, and this repo's bundled blueprint is pinned UNVERIFIED with
 *     commit: null — there is no truthful record to emit. Under route (b) we
 *     deploy without one until a provenance-pinned blueprint exists (W-D).
 *     When it is added back, parameters MUST go through cip171Param(): passing
 *     `outputReference(...)` straight in emits inline PlutusData, which the
 *     reference registry reads as empty and silently drops.
 *
 *  2. The self-check via buildDeploymentScripts is gone. It compared values
 *     derived from the blueprint against a DeploymentParams populated from
 *     those same values — a tautology that cannot fail. The meaningful check is
 *     assertDeploymentScripts on LOAD, which the test does after a round-trip
 *     through JSON.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  TransactionHash as EvoTransactionHash,
  Credential,
  Bytes,
  Data,
  UPLC,
  InlineDatum,
  type UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";

import {
  createStandardScripts,
  buildEvoScript,
  scriptAddress,
  rewardAddress,
  scriptCredential,
  voidData,
  stringToHex,
  mintAssetsFromMap,
  outputAssets,
  type DeploymentParams,
  type PlutusBlueprint,
  type TxInput,
} from "../../dist/index.js";

import { makeClient, topupAddress } from "./yaci.mjs";
import { createOgmiosEvaluator } from "./ogmios-evaluator.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Fixed nonces so a rebuild of the same devnet yields the same always_fail
 * hashes. Two distinct instances are needed — one guarding protocol params,
 * one guarding the issuance CBOR NFT.
 */
const ALWAYS_FAIL_NONCE_A = "daa1e3ec7f567c31a48598407ba1503810bd824a4a01a83e7cef7015bced1339";
const ALWAYS_FAIL_NONCE_B = "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

/** Placeholder minting-logic hash, split out of the issuance_mint CBOR body. */
const DUMMY_POLICY_ID = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef";

const SEED_ADA = 5_000_000n;
const MIN_WALLET_ADA = 200_000_000n;
const TOPUP_ADA = 500_000n; // ADA, not lovelace — the admin API takes ADA

/** Extract the PlutusV3 script body hex (inner UPLC, no outer CBOR wrap). */
function scriptBodyHex(compiledCode: string): string {
  const level = UPLC.getCborEncodingLevel(compiledCode);
  if (level !== "double") return compiledCode;
  const raw = Bytes.fromHex(compiledCode);
  const additionalInfo = raw[0] & 0x1f;
  const headerLen =
    additionalInfo < 24 ? 1 : additionalInfo === 24 ? 2 : additionalInfo === 25 ? 3 : 5;
  return Bytes.toHex(raw.slice(headerLen));
}

export function loadStandardBlueprint(): PlutusBlueprint {
  return JSON.parse(
    readFileSync(resolve(ROOT, "blueprints/standard/v0.3.0/plutus.json"), "utf-8")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLG_PUBLISH = "programmable_logic_global.programmable_logic_global.publish";

/**
 * A protocol bootstrap must register programmable_logic_global's stake
 * credential — PLG is a withdraw-0 validator and the protocol cannot operate
 * until its credential exists on chain. Evolution's `registerStake` emits a
 * Conway RegCert, which executes the script under the **publish** purpose.
 *
 * A blueprint without a publish handler therefore falls through to `else` and
 * the transaction dies at evaluation with a bare "script terminated with
 * error" and an empty trace list — no indication of which handler is missing.
 * This check turns that into something actionable.
 *
 * The blueprint currently bundled at blueprints/standard/v0.3.0 has NO publish
 * handler. Upstream commit 8143853 and 0.5.0-alpha.1 both do.
 */
function requirePublishHandler(blueprint: PlutusBlueprint): void {
  const titles = blueprint.validators.map((v) => v.title);
  if (!titles.includes(PLG_PUBLISH)) {
    throw new Error(
      `This blueprint cannot bootstrap a protocol: it has no "${PLG_PUBLISH}" handler, ` +
      `so registering programmable_logic_global's stake credential fails at script ` +
      `evaluation (purpose "publish") with no diagnostic.\n` +
      `Present handlers: ${titles.filter((t) => t.startsWith("programmable_logic_global")).join(", ")}\n` +
      `Blueprint: "${blueprint.preamble.title}" v${blueprint.preamble.version}.\n` +
      `A blueprint carrying the publish handler is required — upstream 8143853 and ` +
      `0.5.0-alpha.1 both have one. See PLAN.md (W-A3 / W-D).`
    );
  }
}

/**
 * Bootstrap a protocol instance on the devnet. Returns DeploymentParams.
 * Devnet only — throws if the client is not pointed at a testnet.
 */
export async function bootstrapProtocol(): Promise<DeploymentParams> {
  const client = await makeClient();
  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  const networkId = client.chain.id;

  if (networkId !== 0) {
    throw new Error("bootstrapProtocol is devnet-only; refusing to run against a non-testnet");
  }

  // ---- Preflight: fund the wallet ----------------------------------------
  let utxos = await client.getUtxos(addressObj);
  let balance = utxos.reduce((s: bigint, u: EvoUTxO.UTxO) => s + EvoAssets.lovelaceOf(u.assets), 0n);
  if (balance < MIN_WALLET_ADA) {
    await topupAddress(address, TOPUP_ADA);
    for (let i = 0; i < 20 && balance < MIN_WALLET_ADA; i++) {
      await sleep(1_500);
      utxos = await client.getUtxos(addressObj);
      balance = utxos.reduce((s: bigint, u: EvoUTxO.UTxO) => s + EvoAssets.lovelaceOf(u.assets), 0n);
    }
  }
  if (balance < MIN_WALLET_ADA) {
    throw new Error(`Bootstrap needs ≥${MIN_WALLET_ADA} lovelace, wallet has ${balance}`);
  }

  // ---- Step 1: fragment into distinct seed UTxOs -------------------------
  // The one-shot minting policies are parameterised by specific outrefs, so we
  // need two independent UTxOs that both get consumed by the bootstrap tx.
  let fragTx = client.newTx();
  for (let i = 0; i < 3; i++) {
    fragTx = fragTx.payToAddress({ address: addressObj, assets: EvoAssets.fromLovelace(SEED_ADA) });
  }
  const fragBuilt = await fragTx.build({ changeAddress: addressObj });
  const fragSubmit = await fragBuilt.signAndSubmit();
  const fragHash =
    typeof fragSubmit === "string" ? fragSubmit : EvoTransactionHash.toHex(fragSubmit);
  await client.awaitTx(EvoTransactionHash.fromHex(fragHash), 2_000, 90_000);

  let fragUtxos: EvoUTxO.UTxO[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const after = await client.getUtxos(addressObj);
    fragUtxos = after.filter((u) => EvoTransactionHash.toHex(u.transactionId) === fragHash);
    if (fragUtxos.length >= 3) break;
    await sleep(1_500);
  }
  if (fragUtxos.length < 2) {
    throw new Error(`Fragmentation produced ${fragUtxos.length} seed UTxOs, need ≥2`);
  }
  fragUtxos.sort((a, b) => Number(a.index) - Number(b.index));

  const utxo1 = fragUtxos[0];
  const utxo2 = fragUtxos[1];
  const utxo1Ref: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo1.transactionId),
    outputIndex: Number(utxo1.index),
  };
  const utxo2Ref: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo2.transactionId),
    outputIndex: Number(utxo2.index),
  };

  // ---- Step 2: parameterise the standard scripts -------------------------
  const blueprint = loadStandardBlueprint();
  requirePublishHandler(blueprint);
  const builders = createStandardScripts(blueprint);

  const alwaysFailA = builders.alwaysFail(ALWAYS_FAIL_NONCE_A);
  const alwaysFailB = builders.alwaysFail(ALWAYS_FAIL_NONCE_B);
  const protocolParamsMint = builders.protocolParamsMint(utxo1Ref, alwaysFailA.hash);
  const plg = builders.programmableLogicGlobal(protocolParamsMint.hash);
  const plb = builders.programmableLogicBase(plg.hash);
  const issuanceCborHexMint = builders.issuanceCborHexMint(utxo2Ref, alwaysFailB.hash);
  const registryMint = builders.registryMint(utxo1Ref, issuanceCborHexMint.hash);
  const registrySpend = builders.registrySpend(protocolParamsMint.hash);

  // issuance_mint is parameterised per minting logic, which is not known until
  // a token is registered. Build it once against a placeholder and store the
  // CBOR either side of that placeholder, so registration can splice in the
  // real hash without re-deriving the whole script.
  const issuanceDummy = builders.issuanceMint(plb.hash, registryMint.hash, DUMMY_POLICY_ID);
  const dummyBody = scriptBodyHex(issuanceDummy.compiledCode);
  const splitParts = dummyBody.split(DUMMY_POLICY_ID);
  if (splitParts.length !== 2) {
    throw new Error(
      `Placeholder policy id appeared ${splitParts.length - 1} times in the issuance_mint body — expected exactly once`
    );
  }
  const [cborPre, cborPost] = splitParts;

  // ---- Step 3: addresses & datums ----------------------------------------
  const parametersAlwaysFailAddr = scriptAddress(networkId, alwaysFailA.hash);
  const issuanceAlwaysFailAddr = scriptAddress(networkId, alwaysFailB.hash);
  const registrySpendAddr = scriptAddress(networkId, registrySpend.hash);

  const protocolParamsDatum = Data.constr(0n, [
    Data.bytearray(registryMint.hash),
    scriptCredential(plb.hash),
  ]);

  // Sentinel head of the registry linked list: key "", next 0xff*30.
  const directoryDatum = Data.constr(0n, [
    Data.bytearray(""),
    Data.bytearray("ff".repeat(30)),
    Data.constr(0n, [Data.bytearray("")]),
    Data.constr(0n, [Data.bytearray("")]),
    Data.bytearray(""),
  ]);

  const issuanceDatum = Data.constr(0n, [Data.bytearray(cborPre), Data.bytearray(cborPost)]);

  // ---- Step 4: asset units ------------------------------------------------
  const protocolParamNftUnit = protocolParamsMint.hash + stringToHex("ProtocolParams");
  const directoryNftUnit = registryMint.hash; // empty asset name
  const issuanceNftUnit = issuanceCborHexMint.hash + stringToHex("IssuanceCborHex");

  // ---- Step 5: assemble and submit ---------------------------------------
  let tx = client.newTx();
  tx = tx.collectFrom({ inputs: [utxo1, utxo2] });

  tx = tx.mintAssets({
    assets: mintAssetsFromMap(new Map([[directoryNftUnit, 1n]])),
    redeemer: Data.constr(0n, []),
  });
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(new Map([[protocolParamNftUnit, 1n]])),
    redeemer: Data.constr(1n, []),
  });
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(new Map([[issuanceNftUnit, 1n]])),
    redeemer: Data.constr(2n, []),
  });

  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(parametersAlwaysFailAddr),
    assets: outputAssets(2_000_000n, new Map([[protocolParamNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: protocolParamsDatum }),
  });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(registrySpendAddr),
    assets: outputAssets(2_000_000n, new Map([[directoryNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: directoryDatum }),
  });
  // The issuance datum carries ~5kB of CBOR; min-UTxO scales with serialized
  // output size, hence the much larger ADA floor here.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(issuanceAlwaysFailAddr),
    assets: outputAssets(15_000_000n, new Map([[issuanceNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: issuanceDatum }),
  });

  // Reference scripts, so later transactions need not carry them inline.
  tx = tx.payToAddress({
    address: addressObj,
    assets: outputAssets(20_000_000n),
    script: buildEvoScript(plb.compiledCode),
  });
  tx = tx.payToAddress({
    address: addressObj,
    assets: outputAssets(20_000_000n),
    script: buildEvoScript(plg.compiledCode),
  });
  tx = tx.payToAddress({ address: addressObj, assets: outputAssets(50_000_000n) });
  tx = tx.payToAddress({ address: addressObj, assets: outputAssets(50_000_000n) });

  // Conway RegCert executes the script under the Publish purpose.
  tx = tx.registerStake({
    stakeCredential: Credential.makeScriptHash(Bytes.fromHex(plg.hash)),
    redeemer: voidData(),
  });

  tx = tx.attachScript({ script: buildEvoScript(registryMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(protocolParamsMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(issuanceCborHexMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plg.compiledCode) });

  // NOTE: no attachMetadata for CIP-171 — see the header. Deliberate omission,
  // not an oversight.

  const built = await tx.build({
    changeAddress: addressObj,
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });
  const submitHash = await built.signAndSubmit();
  const bootstrapTxHash =
    typeof submitHash === "string" ? submitHash : EvoTransactionHash.toHex(submitHash);
  await client.awaitTx(EvoTransactionHash.fromHex(bootstrapTxHash), 2_000, 180_000);

  // ---- Step 6: assemble DeploymentParams ---------------------------------
  const OUTPUT_PLB_REF = 3;
  const OUTPUT_PLG_REF = 4;

  return {
    txHash: bootstrapTxHash,
    protocolParams: {
      txInput: utxo1Ref,
      policyId: protocolParamsMint.hash,
      alwaysFailScriptHash: alwaysFailA.hash,
    },
    programmableLogicGlobal: { policyId: plg.hash, scriptHash: plg.hash },
    programmableLogicBase: { scriptHash: plb.hash },
    issuance: {
      txInput: utxo2Ref,
      policyId: issuanceCborHexMint.hash,
      alwaysFailScriptHash: alwaysFailB.hash,
    },
    directoryMint: {
      txInput: utxo1Ref,
      issuanceScriptHash: issuanceCborHexMint.hash,
      scriptHash: registryMint.hash,
    },
    directorySpend: { policyId: protocolParamsMint.hash, scriptHash: registrySpend.hash },
    programmableBaseRefInput: { txHash: bootstrapTxHash, outputIndex: OUTPUT_PLB_REF },
    programmableGlobalRefInput: { txHash: bootstrapTxHash, outputIndex: OUTPUT_PLG_REF },
  };
}
