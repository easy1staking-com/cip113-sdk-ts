/**
 * CIP-113 standard bootstrap — network-aware.
 *
 * Deploys the CIP-113 standard scripts (protocol params, directory, issuance,
 * PLB, PLG, registry, always-fail sinks) to the network selected by the
 * NETWORK env var. Emits examples/shared/deployment-${NETWORK}.json.
 *
 *   NETWORK=yaci    → deployment-yaci.json    (auto-topup via Yaci admin API)
 *   NETWORK=preview → deployment-preview.json (wallet must be pre-funded)
 *   NETWORK=preprod → deployment-preprod.json (wallet must be pre-funded)
 *   NETWORK=mainnet → refused; adjust if you really mean it
 *
 * Re-run whenever the standard blueprint (blueprints/standard/**) changes or
 * after `yaci:reset`. The self-check at the end round-trips the generated
 * deployment JSON through the SDK resolver to catch shape drift.
 *
 * TS port of cardano-foundation/cip113-programmable-tokens
 *   src/programmable-tokens-offchain-java/src/test/java/org/cardanofoundation/cip113/standard/
 *   PreviewProtocolDeploymentMintTest.java
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Credential,
  Data,
  InlineDatum,
  TransactionHash as EvoTransactionHash,
  UPLC,
  Bytes,
} from "@evolution-sdk/evolution";
import type { UTxO as EvoUTxO } from "@evolution-sdk/evolution";
import {
  buildEvoScript,
  scriptAddress,
  rewardAddress,
  outputAssets,
  mintAssetsFromMap,
  stringToHex,
  scriptCredential,
  voidData,
} from "../../src/core/evo-utils.js";
import {
  createStandardScripts,
  buildDeploymentScripts,
} from "../../src/standard/scripts.js";
import type { DeploymentParams } from "@easy1staking/cip113-sdk-ts";
import {
  createSigningClient,
  getWalletAddress,
  loadStandardBlueprint,
  isYaci,
  getNetwork,
} from "../shared/config.js";
import { topupAddress } from "../shared/yaci.js";
import { createOgmiosEvaluator } from "../shared/ogmios-evaluator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NETWORK = getNetwork();
const DEPLOYMENT_PATH = resolve(
  __dirname,
  "..",
  "shared",
  `deployment-${NETWORK}.json`,
);

// Two fixed 32-byte nonces so the two always_fail instances have distinct hashes.
// Any pair of distinct random hex strings works — these mirror the Java test.
const ALWAYS_FAIL_NONCE_A = "daa1e3ec7f567c31a48598407ba1503810bd824a4a01a83e7cef7015bced1339";
const ALWAYS_FAIL_NONCE_B = "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

// 28-byte placeholder substituted for the real minting_logic hash during the
// issuance_mint CBOR-split trick. Must appear exactly once in the compiled body.
const DUMMY_POLICY_ID = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef";

const SEED_ADA = 5_000_000n;
const MIN_WALLET_ADA = 200_000_000n;
const TOPUP_ADA = 500_000_000_000n; // 500k ADA — Yaci faucet is generous

const OUTPUT_PROTOCOL_PARAMS = 0;
const OUTPUT_DIRECTORY = 1;
const OUTPUT_ISSUANCE = 2;
const OUTPUT_PLB_REF = 3;
const OUTPUT_PLG_REF = 4;

/** Extract the PlutusV3 script body hex (inner UPLC, no outer CBOR wrap). */
function scriptBodyHex(compiledCode: string): string {
  const level = UPLC.getCborEncodingLevel(compiledCode);
  if (level !== "double") return compiledCode;
  const raw = Bytes.fromHex(compiledCode);
  const additionalInfo = raw[0] & 0x1f;
  const headerLen = additionalInfo < 24 ? 1 : additionalInfo === 24 ? 2 : additionalInfo === 25 ? 3 : 5;
  return Bytes.toHex(raw.slice(headerLen));
}

async function main() {
  if (NETWORK === "mainnet") {
    console.error(
      "Refusing to bootstrap on mainnet. If you truly intend to, edit this guard.",
    );
    process.exit(1);
  }

  console.log(`=== CIP-113 standard bootstrap (NETWORK=${NETWORK}) ===\n`);

  const client = await createSigningClient();
  const address = await getWalletAddress(client);
  const evoAddr = EvoAddress.fromBech32(address);
  const networkId = client.chain.id;
  console.log(`Admin: ${address}`);
  console.log(`Network id: ${networkId}, magic: ${client.chain.networkMagic}`);

  // ---- Preflight: ensure wallet is funded --------------------------------
  let utxos = await client.getUtxos(evoAddr);
  let balance = utxos.reduce((s: bigint, u: EvoUTxO.UTxO) => s + EvoAssets.lovelaceOf(u.assets), 0n);
  console.log(`Balance: ${Number(balance) / 1e6} ADA (${utxos.length} UTxOs)`);

  if (balance < MIN_WALLET_ADA) {
    if (isYaci()) {
      console.log(`Topping up ${Number(TOPUP_ADA) / 1e6} ADA via Yaci admin API...`);
      await topupAddress(address, TOPUP_ADA);
      // Topup is instant in Yaci but we wait one block for indexing.
      await new Promise((r) => setTimeout(r, 3_000));
      utxos = await client.getUtxos(evoAddr);
      balance = utxos.reduce((s: bigint, u: EvoUTxO.UTxO) => s + EvoAssets.lovelaceOf(u.assets), 0n);
      console.log(`Balance after topup: ${Number(balance) / 1e6} ADA (${utxos.length} UTxOs)`);
    } else {
      console.error(
        `Insufficient balance: need ≥${Number(MIN_WALLET_ADA) / 1e6} ADA on ${NETWORK}. ` +
        `Fund ${address} from the ${NETWORK} faucet and re-run.`,
      );
      process.exit(1);
    }
  }

  // ---- Step 1: fragment into two small seed UTxOs -----------------------
  console.log("\n--- Step 1: fragment wallet ---");
  let fragTx = client.newTx();
  for (let i = 0; i < 3; i++) {
    fragTx = fragTx.payToAddress({ address: evoAddr, assets: EvoAssets.fromLovelace(SEED_ADA) });
  }
  const fragBuilt = await fragTx.build({ changeAddress: evoAddr });
  const fragSubmit = await fragBuilt.signAndSubmit();
  const fragHash = typeof fragSubmit === "string" ? fragSubmit : EvoTransactionHash.toHex(fragSubmit);
  console.log(`  fragment tx: ${fragHash}`);
  await client.awaitTx(EvoTransactionHash.fromHex(fragHash), 2_000, 60_000);
  console.log("  confirmed.");

  // Poll until the 3 new UTxOs show up.
  let fragUtxos: EvoUTxO.UTxO[] = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    const after = await client.getUtxos(evoAddr);
    fragUtxos = after.filter((u) => EvoTransactionHash.toHex(u.transactionId) === fragHash);
    if (fragUtxos.length >= 3) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (fragUtxos.length < 2) throw new Error("Fragmentation did not produce ≥2 seed UTxOs");
  fragUtxos.sort((a, b) => Number(a.index) - Number(b.index));

  const utxo1 = fragUtxos[0];
  const utxo2 = fragUtxos[1];
  const utxo1Ref = { txHash: EvoTransactionHash.toHex(utxo1.transactionId), outputIndex: Number(utxo1.index) };
  const utxo2Ref = { txHash: EvoTransactionHash.toHex(utxo2.transactionId), outputIndex: Number(utxo2.index) };
  console.log(`  seed1: ${utxo1Ref.txHash}#${utxo1Ref.outputIndex}`);
  console.log(`  seed2: ${utxo2Ref.txHash}#${utxo2Ref.outputIndex}`);

  // ---- Step 2: parameterise all standard scripts ------------------------
  console.log("\n--- Step 2: parameterise scripts ---");
  const blueprint = loadStandardBlueprint();
  const builders = createStandardScripts(blueprint);

  const alwaysFailA = builders.alwaysFail(ALWAYS_FAIL_NONCE_A);
  const alwaysFailB = builders.alwaysFail(ALWAYS_FAIL_NONCE_B);
  const protocolParamsMint = builders.protocolParamsMint(utxo1Ref, alwaysFailA.hash);
  const plg = builders.programmableLogicGlobal(protocolParamsMint.hash);
  const plb = builders.programmableLogicBase(plg.hash);
  const issuanceCborHexMint = builders.issuanceCborHexMint(utxo2Ref, alwaysFailB.hash);
  const registryMint = builders.registryMint(utxo1Ref, issuanceCborHexMint.hash);
  const registrySpend = builders.registrySpend(protocolParamsMint.hash);

  // Build issuance_mint with a dummy minting_logic hash so we can split the
  // resulting CBOR around the placeholder and store the two halves in the
  // issuance_cbor_hex NFT's datum (see Java PreviewProtocolDeploymentMintTest).
  const issuanceDummy = builders.issuanceMint(plb.hash, registryMint.hash, DUMMY_POLICY_ID);
  const dummyBody = scriptBodyHex(issuanceDummy.compiledCode);
  const splitParts = dummyBody.split(DUMMY_POLICY_ID);
  if (splitParts.length !== 2) {
    throw new Error(
      `dummy policyId appeared ${splitParts.length - 1} times in issuance_mint body — expected exactly once`,
    );
  }
  const [cborPre, cborPost] = splitParts;

  console.log(`  protocol_params_mint : ${protocolParamsMint.hash}`);
  console.log(`  programmable_logic_g : ${plg.hash}`);
  console.log(`  programmable_logic_b : ${plb.hash}`);
  console.log(`  issuance_cbor_hex    : ${issuanceCborHexMint.hash}`);
  console.log(`  registry_mint        : ${registryMint.hash}`);
  console.log(`  registry_spend       : ${registrySpend.hash}`);
  console.log(`  always_fail A        : ${alwaysFailA.hash}`);
  console.log(`  always_fail B        : ${alwaysFailB.hash}`);

  // ---- Step 3: addresses & datums ---------------------------------------
  const parametersAlwaysFailAddr = scriptAddress(networkId, alwaysFailA.hash);
  const issuanceAlwaysFailAddr = scriptAddress(networkId, alwaysFailB.hash);
  const registrySpendAddr = scriptAddress(networkId, registrySpend.hash);
  const plgRewardAddr = rewardAddress(networkId, plg.hash);

  // ProtocolParamsDatum: Constr(0, [directoryHash, programmableLogicBasePaymentCred])
  const protocolParamsDatum = Data.constr(0n, [
    Data.bytearray(registryMint.hash),
    scriptCredential(plb.hash),
  ]);

  // Directory sentinel datum: Constr(0, ["", 0xff*30, Constr(0, ["" ]), Constr(0, ["" ]), ""])
  const directoryDatum = Data.constr(0n, [
    Data.bytearray(""),
    Data.bytearray("ff".repeat(30)),
    Data.constr(0n, [Data.bytearray("")]),
    Data.constr(0n, [Data.bytearray("")]),
    Data.bytearray(""),
  ]);

  // Issuance datum: two CBOR halves of the dummy issuance_mint body.
  const issuanceDatum = Data.constr(0n, [
    Data.bytearray(cborPre),
    Data.bytearray(cborPost),
  ]);

  // ---- Step 4: asset units ----------------------------------------------
  const protocolParamNftUnit = protocolParamsMint.hash + stringToHex("ProtocolParams");
  const directoryNftUnit = registryMint.hash + ""; // empty asset name
  const issuanceNftUnit = issuanceCborHexMint.hash + stringToHex("IssuanceCborHex");

  // ---- Step 5: assemble bootstrap tx ------------------------------------
  console.log("\n--- Step 5: build & submit bootstrap tx ---");
  let tx = client.newTx();

  // One-shot seeds — mark as inputs so the parameterised minting policies succeed.
  tx = tx.collectFrom({ inputs: [utxo1, utxo2] });

  // Mints (order matters only within one policy; redeemers per policy).
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

  // Output 0: protocolParams NFT at alwaysFail-A.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(parametersAlwaysFailAddr),
    assets: outputAssets(2_000_000n, new Map([[protocolParamNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: protocolParamsDatum }),
  });

  // Output 1: directory sentinel NFT at registry_spend.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(registrySpendAddr),
    assets: outputAssets(2_000_000n, new Map([[directoryNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: directoryDatum }),
  });

  // Output 2: issuance CBOR NFT at alwaysFail-B.
  // Datum carries the two halves of the issuance_mint CBOR (~5kB); min-UTxO
  // scales with serialized output size, so a bigger ADA floor is needed here.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(issuanceAlwaysFailAddr),
    assets: outputAssets(15_000_000n, new Map([[issuanceNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: issuanceDatum }),
  });

  // Output 3: reference script — programmable_logic_base.
  tx = tx.payToAddress({
    address: evoAddr,
    assets: outputAssets(20_000_000n),
    script: buildEvoScript(plb.compiledCode),
  });

  // Output 4: reference script — programmable_logic_global.
  tx = tx.payToAddress({
    address: evoAddr,
    assets: outputAssets(20_000_000n),
    script: buildEvoScript(plg.compiledCode),
  });

  // Outputs 5 & 6: 50 ADA each for subsequent substandard operations.
  tx = tx.payToAddress({ address: evoAddr, assets: outputAssets(50_000_000n) });
  tx = tx.payToAddress({ address: evoAddr, assets: outputAssets(50_000_000n) });

  // Register programmable_logic_global's stake credential. Evolution SDK's
  // registerStake emits Conway RegCert which executes the script on Publish
  // purpose — requires the validator to handle that purpose.
  tx = tx.registerStake({
    stakeCredential: Credential.makeScriptHash(Bytes.fromHex(plg.hash)),
    redeemer: voidData(),
  });

  // Attach minting policies + plg (witness for the publish-purpose redeemer).
  tx = tx.attachScript({ script: buildEvoScript(registryMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(protocolParamsMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(issuanceCborHexMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plg.compiledCode) });

  // Default Ogmios URL matches Yaci DevKit; for preview/preprod the user is
  // expected to export OGMIOS_URL (e.g. SSH tunnel to panic-station:31357).
  const ogmiosUrl = process.env.OGMIOS_URL ?? "http://localhost:1337";
  if (!process.env.OGMIOS_URL && !isYaci()) {
    console.warn(
      `Warning: OGMIOS_URL not set; falling back to ${ogmiosUrl}. ` +
      `Export OGMIOS_URL for ${NETWORK} (e.g. http://127.0.0.1:31357 via tunnel).`,
    );
  }
  const built = await tx.build({
    changeAddress: evoAddr,
    evaluator: createOgmiosEvaluator(ogmiosUrl),
  });
  const submitHash = await built.signAndSubmit();
  const bootstrapTxHash =
    typeof submitHash === "string" ? submitHash : EvoTransactionHash.toHex(submitHash);
  console.log(`  bootstrap tx: ${bootstrapTxHash}`);
  await client.awaitTx(EvoTransactionHash.fromHex(bootstrapTxHash), 2_000, 180_000);
  console.log("  confirmed.");
  console.log(`  plg reward addr: ${plgRewardAddr}`);

  // ---- Step 6: write deployment JSON ------------------------------------
  const deployment: DeploymentParams = {
    txHash: bootstrapTxHash,
    protocolParams: {
      txInput: utxo1Ref,
      policyId: protocolParamsMint.hash,
      alwaysFailScriptHash: alwaysFailA.hash,
    },
    programmableLogicGlobal: {
      policyId: plg.hash,
      scriptHash: plg.hash,
    },
    programmableLogicBase: {
      scriptHash: plb.hash,
    },
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
    directorySpend: {
      policyId: protocolParamsMint.hash,
      scriptHash: registrySpend.hash,
    },
    programmableBaseRefInput: { txHash: bootstrapTxHash, outputIndex: OUTPUT_PLB_REF },
    programmableGlobalRefInput: { txHash: bootstrapTxHash, outputIndex: OUTPUT_PLG_REF },
  };

  // Self-check: round-trip via the SDK's own resolver to catch shape drift.
  const resolved = buildDeploymentScripts(blueprint, deployment);
  const checks: Array<[string, string, string]> = [
    ["protocolParamsMint", resolved.protocolParamsMint.hash!, protocolParamsMint.hash],
    ["programmableLogicGlobal", resolved.programmableLogicGlobal.hash!, plg.hash],
    ["programmableLogicBase", resolved.programmableLogicBase.hash!, plb.hash],
    ["issuanceCborHexMint", resolved.issuanceCborHexMint.hash!, issuanceCborHexMint.hash],
    ["registryMint", resolved.registryMint.hash!, registryMint.hash],
    ["registrySpend", resolved.registrySpend.hash!, registrySpend.hash],
  ];
  for (const [name, got, expected] of checks) {
    if (got !== expected) {
      throw new Error(`Self-check failed: ${name} expected ${expected} got ${got}`);
    }
  }
  console.log("  self-check: OK");

  writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment written: ${DEPLOYMENT_PATH}`);
  console.log(`\nNext: NETWORK=${NETWORK} npx tsx bafin/run-all.ts`);

  // Prove it parses back from disk.
  const reread = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf-8"));
  if (reread.txHash !== bootstrapTxHash) {
    throw new Error("Deployment JSON round-trip mismatch");
  }
  if (!existsSync(DEPLOYMENT_PATH)) throw new Error("Deployment JSON missing");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
