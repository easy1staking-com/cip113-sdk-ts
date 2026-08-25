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
 * TARGETS CIP-113 0.5.0-alpha.2 (upstream 9db7e06).
 *
 * This is a REWRITE, not a port. programmable_logic_global is dissolved
 * (upstream #110), so the topology changed rather than the parameters:
 *
 *  * PLG's single withdraw-0 became THREE — `transfer`, `third_party` and
 *    `unfracking` — and a bootstrap must register ALL THREE stake credentials.
 *    Each carries its own `publish` handler, which is why the blocker that
 *    stopped the previous version of this file is gone.
 *  * The protocol-params NFT is locked at `coordination_spend`, NOT at
 *    always_fail. `protocol_params_mint`'s 2nd parameter kept its arity and its
 *    type across that change, so nothing but correctness stands here.
 *  * The params datum is 7 fields and carries the live delegate credentials;
 *    an upgrade rewrites them in place rather than redeploying PLB.
 *
 * The self-check via buildDeploymentScripts is deliberately absent: it compared
 * values derived from the blueprint against a DeploymentParams populated from
 * those same values — a tautology that cannot fail. The meaningful check is
 * assertDeploymentScripts on LOAD, which the test does after a round-trip
 * through JSON.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  TransactionHash as EvoTransactionHash,
  Credential,
  DRep,
  Bytes,
  Data,
  UPLC,
  InlineDatum,
  type UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";

import {
  createStandardScripts,
  stakingCredentialHash,
  protocolParamsDatum as buildProtocolParamsDatum,
  registryNodeDatum,
  paymentCredentialHash,
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
 * Fixed nonces so a rebuild against the same devnet yields the same hashes.
 *
 * always_fail now guards ONLY the issuance CBOR NFT — the protocol-params NFT
 * moved to coordination_spend, which takes its own nonce. That nonce is
 * arbitrary and per-deployment BY DESIGN: coordination_spend cannot be
 * parameterised by the params policy, because protocol_params_mint is itself
 * parameterised by coordination_spend's address, and the dependency would be
 * circular. The coordination UTxO is identified structurally instead.
 */
const ALWAYS_FAIL_NONCE_B = "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";
const COORDINATION_NONCE = "5c1d0f3ab7e64c2189af03d6e5b7c4128d9e6a0f3b2c5d8e1f4a7b0c3d6e9f21";

/**
 * The #106-vector-3 inline-datum bound written into params datum field 6.
 *
 * DEVNET FIXTURE VALUE ONLY (PLAN.md D-17). It is a security parameter with no
 * upstream guidance; 1024 is what upstream's own test fixtures use and is NOT a
 * recommendation. The production value is deferred to the freeze-and-seize epic.
 */
const MAX_INLINE_DATUM_BYTES = 1024n;

/** Placeholder minting-logic hash, split out of the issuance_mint CBOR body. */
const DUMMY_POLICY_ID = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef";

const SEED_ADA = 5_000_000n;
const MIN_WALLET_ADA = 200_000_000n;
/**
 * ADA, not lovelace — the admin API takes ADA.
 *
 * MEASURED: the devnet faucet rejects large requests with an opaque HTTP 500
 * and {"status":false,"message":"Topup failed"} — it does NOT clamp to what it
 * can afford. Each genesis account holds 10,000 ADA, and 500,000 (what this
 * previously requested) fails outright. The bootstrap needs ~200 ADA of
 * outputs plus fees, so 10,000 is ample with a wide margin.
 */
const TOPUP_ADA = 10_000n;

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
    readFileSync(resolve(ROOT, "blueprints/standard/v0.5.0-alpha.2/plutus.json"), "utf-8")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The three withdraw-0 delegates whose stake credentials a bootstrap must
 * register. Registering emits a Conway RegCert, which runs the script under the
 * PUBLISH purpose — so each needs a publish handler or the transaction dies at
 * evaluation with a bare "machine terminated" and an empty trace list.
 *
 * This precondition previously named programmable_logic_global and was the
 * BLOCKER that stopped the earlier version of this fixture: the 0.3.0 blueprint
 * had no publish handler at all. That blocker is gone, but not because it was
 * fixed — PLG was dissolved, and its three successors each carry one. The check
 * is kept because the failure it diagnoses is undiagnosable without it.
 */
const REQUIRED_PUBLISH_HANDLERS = [
  "transfer.transfer.publish",
  "third_party.third_party.publish",
  "unfracking.unfracking.publish",
] as const;

function requirePublishHandlers(blueprint: PlutusBlueprint): void {
  const titles = blueprint.validators.map((v) => v.title);
  const missing = REQUIRED_PUBLISH_HANDLERS.filter((t) => !titles.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `This blueprint cannot bootstrap a protocol: it lacks publish handler(s) ` +
        `${missing.join(", ")}, so registering the corresponding stake credential fails at ` +
        `script evaluation (purpose "publish") with no diagnostic.\n` +
        `Blueprint: "${blueprint.preamble.title}" v${blueprint.preamble.version}.\n` +
        `Present handlers: ${titles.filter((t) => t.endsWith(".publish")).join(", ") || "(none)"}`
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
  requirePublishHandlers(blueprint);
  const builders = createStandardScripts(blueprint);

  const alwaysFailB = builders.alwaysFail(ALWAYS_FAIL_NONCE_B);

  // coordination_spend is the lock target for the params NFT. It must be built
  // BEFORE protocol_params_mint, which takes its hash.
  const coordination = builders.coordinationSpend(COORDINATION_NONCE);
  const protocolParamsMint = builders.protocolParamsMint(utxo1Ref, coordination.hash);

  // Everything below hangs off the params-NFT POLICY, in parallel. This is no
  // longer a chain: PLB used to be parameterised by PLG's credential, so the
  // order was forced; it now takes params_policy like the delegates do.
  const paramsPolicy = protocolParamsMint.hash;
  const plb = builders.programmableLogicBase(paramsPolicy);
  const transfer = builders.transfer(paramsPolicy);
  const thirdParty = builders.thirdParty(paramsPolicy);
  const unfracking = builders.unfracking(paramsPolicy);
  const registrySpend = builders.registrySpend(paramsPolicy);

  const issuanceCborHexMint = builders.issuanceCborHexMint(utxo2Ref, alwaysFailB.hash);
  const registryMint = builders.registryMint(utxo1Ref, issuanceCborHexMint.hash, registrySpend.hash);

  // upstream's reference upgrade authority. Deployed and hash-asserted, but see
  // the block below: it is NOT the authority this fixture installs.
  const adminPkh = paymentCredentialHash(address);
  const upgradeMultisig = builders.upgradeMultisig([adminPkh], 1);

  // ---- The active upgrade authority, and why it is NOT upgrade_multisig ----
  //
  // coordination_spend's authorisation check is exactly
  //     self.withdrawals |> pairs.has_key_or_fail(old_params.upgrade_cred)
  // and it "never inspects that authority's internals". So the credential need
  // only be able to APPEAR IN A WITHDRAWALS MAP, which requires it to be a
  // registered stake credential.
  //
  // ⚠ upgrade_multisig CANNOT BE REGISTERED through this SDK's toolchain.
  //   * The blueprint gives it `withdraw` and `else` — NO `publish` handler.
  //     A Conway RegCert runs the script under the PUBLISH purpose, so a
  //     script-witnessed registration falls through to `else` and fails. This
  //     is the same shape as the blocker that stopped the 0.3.x fixture.
  //   * Registering WITHOUT a witness is refused client-side by Evolution:
  //     "Redeemer required for script-controlled stake credential registration"
  //     (OBSERVED on devnet). Whether the Conway ledger itself would permit a
  //     permissionless registration is UNTESTED — the SDK blocks it before a
  //     transaction is ever built, and the constitution allows no second
  //     Cardano library to test it with.
  //
  // Pointing upgrade_cred at an unregisterable credential is upstream's
  // documented ONE-WAY BRICK: "an unsatisfiable upgrade_cred makes this
  // validator's own authority check permanently unsatisfiable, with no repair
  // path." So the fixture installs a VERIFICATION-KEY authority instead — the
  // bootstrapping wallet's own stake key. That is the most literal reading of
  // PLAN.md D-15 ("a single key update is fine"), and it relaxes WHO may
  // authorise while leaving the mechanism — coordination UTxO, 7-field datum,
  // trampoline — fully wired, exactly as D-15 requires.
  const upgradeStakeKeyHash = stakingCredentialHash(address);

  // issuance_mint is parameterised per minting logic, which is not known until
  // a token is registered. Build it once against a placeholder and store the
  // CBOR either side of that placeholder, so registration can splice in the
  // real hash without re-deriving the whole script.
  const issuanceDummy = builders.issuanceMint(plb.hash, registryMint.hash, DUMMY_POLICY_ID, paramsPolicy);
  const dummyBody = scriptBodyHex(issuanceDummy.compiledCode);
  const splitParts = dummyBody.split(DUMMY_POLICY_ID);
  if (splitParts.length !== 2) {
    throw new Error(
      `Placeholder policy id appeared ${splitParts.length - 1} times in the issuance_mint body — expected exactly once`
    );
  }
  const [cborPre, cborPost] = splitParts;

  // ---- Step 3: addresses & datums ----------------------------------------
  // The params NFT lives at coordination_spend now — always_fail no longer
  // guards it. This single line is the whole of the lock-target change, and
  // nothing in the type system can tell it from the old one.
  const coordinationAddr = scriptAddress(networkId, coordination.hash);
  const issuanceAlwaysFailAddr = scriptAddress(networkId, alwaysFailB.hash);
  const registrySpendAddr = scriptAddress(networkId, registrySpend.hash);

  const paramsDatum = buildProtocolParamsDatum({
    registryNodeCs: registryMint.hash,
    progLogicCred: { type: "script", hash: plb.hash },
    transferCred: { type: "script", hash: transfer.hash },
    thirdPartyCred: { type: "script", hash: thirdParty.hash },
    unfrackingCred: { type: "script", hash: unfracking.hash },
    upgradeCred: { type: "key", hash: upgradeStakeKeyHash },
    maxInlineDatumBytes: MAX_INLINE_DATUM_BYTES,
  });

  // Sentinel head of the registry linked list: key "", next 0xff*30, and every
  // delegate slot empty. SEVEN fields now — minting_logic_script was inserted
  // at index 2 (#52) and unfracking_logic_script at index 5 (unfracking v2).
  const EMPTY_CRED = { type: "key" as const, hash: "" };
  const directoryDatum = registryNodeDatum({
    key: "",
    next: "ff".repeat(30),
    mintingLogicScript: EMPTY_CRED,
    transferLogicScript: EMPTY_CRED,
    thirdPartyTransferLogicScript: EMPTY_CRED,
    unfrackingLogicScript: EMPTY_CRED,
    globalStateCs: "",
  });

  const issuanceDatum = Data.constr(0n, [Data.bytearray(cborPre), Data.bytearray(cborPost)]);

  // ---- Step 4: asset units ------------------------------------------------
  const protocolParamNftUnit = protocolParamsMint.hash + stringToHex("ProtocolParams");
  const directoryNftUnit = registryMint.hash; // empty asset name
  const issuanceNftUnit = issuanceCborHexMint.hash + stringToHex("IssuanceCborHex");

  // ---- Step 5: assemble and submit ---------------------------------------
  //
  // THREE transactions, not one. This is a consequence of #110 that is invisible
  // in a parameter diff: dissolving programmable_logic_global turned one
  // withdraw-0 validator into three, and a bootstrap must publish and register
  // all of them. MEASURED: the single transaction the 0.3.x fixture used comes
  // to 21816 bytes against a 16384-byte protocol maximum.
  //
  // The split is chosen so each transaction has one job and nothing crosses a
  // boundary that cannot:
  //   1. MINTS  — consumes the one-shot seed UTxOs, mints the three NFTs and
  //      writes the three datum outputs. Must be first: the policies are
  //      parameterised by these exact outrefs.
  //   2. PUBLISH — writes the four reference scripts (PLB + the three
  //      delegates). Cannot be folded into (1); a transaction cannot reference
  //      a script it is itself creating.
  //   3. REGISTER — the three Conway RegCerts. Kept separate because each
  //      executes its script under the PUBLISH purpose, and carrying all three
  //      script bodies alongside the mint witnesses is what breaks the size cap.
  const submitAndWait = async (built: { signAndSubmit: () => Promise<unknown> }) => {
    const res = await built.signAndSubmit();
    const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res as never);
    await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 180_000);
    return hash;
  };
  const evaluator = createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337");

  // ---- Tx 1: mints + protocol state --------------------------------------
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
    address: EvoAddress.fromBech32(coordinationAddr),
    assets: outputAssets(2_000_000n, new Map([[protocolParamNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: paramsDatum }),
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

  tx = tx.attachScript({ script: buildEvoScript(registryMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(protocolParamsMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(issuanceCborHexMint.compiledCode) });

  const bootstrapTxHash = await submitAndWait(
    await tx.build({ changeAddress: addressObj, evaluator })
  );

  // ---- Tx 2: publish reference scripts ------------------------------------
  let refTx = client.newTx();
  for (const script of [plb, transfer, thirdParty, unfracking]) {
    refTx = refTx.payToAddress({
      address: addressObj,
      assets: outputAssets(20_000_000n),
      script: buildEvoScript(script.compiledCode),
    });
  }
  const refTxHash = await submitAndWait(
    await refTx.build({ changeAddress: addressObj, evaluator })
  );

  // ---- Tx 3: register the three delegate stake credentials -----------------
  //
  // Each RegCert executes its script under the PUBLISH purpose. programmable_
  // logic_base dispatches to these by credential and a credential that is not
  // registered cannot be withdrawn against, so the protocol is inoperable until
  // all three exist — this is not optional setup.
  // The upgrade authority's own stake credential, in its OWN transaction.
  // A withdraw-0 cannot reference an unregistered reward account, so without
  // this the upgrade path is dead on arrival — and coordination_spend offers no
  // repair path.
  //
  // Separate transaction because this credential is the WALLET'S, not the
  // protocol's: it survives across bootstraps, so a second instance on the same
  // devnet finds it already registered. That is a legitimate state, not an
  // error — but it is the ONLY error tolerated here. Anything else propagates,
  // because a blanket catch around a registration would hide exactly the
  // publish-purpose failure this fixture exists to surface.
  try {
    // Registration is not enough. CONWAY, OBSERVED: a withdrawal — INCLUDING a
    // zero withdrawal — from a credential not delegated to a DRep is rejected
    // with code 3150, "credentials that do not engage in on-chain governance".
    // coordination_spend's authority check is a withdraw-0, so without this
    // delegation the upgrade path is unusable even though the credential is
    // registered. Delegating to AlwaysAbstain is the neutral choice: it engages
    // with governance without casting an opinion.
    const keyRegTx = client
      .newTx()
      .registerAndDelegateTo({
        stakeCredential: Credential.makeKeyHash(Bytes.fromHex(upgradeStakeKeyHash)),
        drep: new DRep.AlwaysAbstainDRep({}),
      });
    await submitAndWait(await keyRegTx.build({ changeAddress: addressObj, evaluator }));
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const alreadyRegistered =
      msg.includes("already known credential") || msg.includes("3145");
    if (!alreadyRegistered) throw err;
    // Registered by an earlier bootstrap on this devnet. The DELEGATION still
    // has to exist for the withdraw-0 to be accepted, and re-delegating an
    // already-delegated credential is harmless.
    const delegateTx = client.newTx().delegateToDRep({
      stakeCredential: Credential.makeKeyHash(Bytes.fromHex(upgradeStakeKeyHash)),
      drep: new DRep.AlwaysAbstainDRep({}),
    });
    await submitAndWait(await delegateTx.build({ changeAddress: addressObj, evaluator }));
  }

  let regTx = client.newTx();
  for (const delegate of [transfer, thirdParty, unfracking]) {
    regTx = regTx.registerStake({
      stakeCredential: Credential.makeScriptHash(Bytes.fromHex(delegate.hash)),
      redeemer: voidData(),
    });
    regTx = regTx.attachScript({ script: buildEvoScript(delegate.compiledCode) });
  }
  await submitAndWait(await regTx.build({ changeAddress: addressObj, evaluator }));

  // ---- Step 6: assemble DeploymentParams ---------------------------------
  //
  // Output indices must match the payToAddress order above exactly. They are
  // positional and nothing checks them but the devnet test that follows.
  // Tx 1 outputs: 0 coordination (params NFT), 1 registry origin, 2 issuance CBOR NFT.
  // Tx 2 outputs: 0 PLB, 1 transfer, 2 third_party, 3 unfracking (publish order above).
  const OUT_COORDINATION = 0;
  const REF_PLB = 0;
  const REF_TRANSFER = 1;
  const REF_THIRD_PARTY = 2;
  const REF_UNFRACKING = 3;

  return {
    txHash: bootstrapTxHash,
    coordinationNonce: COORDINATION_NONCE,
    coordination: {
      scriptHash: coordination.hash,
      utxo: { txHash: bootstrapTxHash, outputIndex: OUT_COORDINATION },
    },
    protocolParams: {
      txInput: utxo1Ref,
      policyId: protocolParamsMint.hash,
      coordinationScriptHash: coordination.hash,
    },
    programmableLogicBase: { scriptHash: plb.hash },
    transfer: { scriptHash: transfer.hash },
    thirdParty: { scriptHash: thirdParty.hash },
    unfracking: { scriptHash: unfracking.hash },
    upgradeMultisig: { scriptHash: upgradeMultisig.hash },
    upgradeAuthority: { type: "key", hash: upgradeStakeKeyHash },
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
    programmableBaseRefInput: { txHash: refTxHash, outputIndex: REF_PLB },
    transferRefInput: { txHash: refTxHash, outputIndex: REF_TRANSFER },
    thirdPartyRefInput: { txHash: refTxHash, outputIndex: REF_THIRD_PARTY },
    unfrackingRefInput: { txHash: refTxHash, outputIndex: REF_UNFRACKING },
  };
}
