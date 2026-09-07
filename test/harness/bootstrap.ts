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
  REGISTRY_NODE_MIN_ADA,
  outputAssets,
  type DeploymentParams,
  type PlutusBlueprint,
  type TxInput,
} from "../../dist/index.js";

import { makeClient, topupAddress } from "./yaci.mjs";
import { createOgmiosEvaluator } from "./ogmios-evaluator.js";
import { buildDeploymentRecord } from "./cip171-record.js";
import { explainError } from "./explain-error.js";
import { STANDARD_VALIDATORS, TARGET_PROTOCOL_VERSION } from "../../dist/standard/blueprint.js";
import { rewardAddressFromKeyHash } from "../../dist/index.js";
import { buildCip171Metadatum, CIP171_METADATA_LABEL } from "../../dist/index.js";
import type { ParameterizationEvent } from "../../dist/standard/scripts.js";
import type { Evaluator } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import { Transaction as EvoTx } from "@evolution-sdk/evolution";

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

/**
 * The bundled blueprint directory for the version the SDK actually TARGETS.
 *
 * ⛔ DERIVED, NEVER TYPED. This was hardcoded to `v0.5.0-alpha.2` and stayed
 * there through the whole alpha.3 migration: S-3 vendored alpha.3, S-4 flipped
 * TARGET_PROTOCOL_VERSION, and this line kept loading the old artefact. The
 * offline suite could not see it — those tests load blueprints by explicit
 * path — so 119/119 stayed green while every devnet bootstrap built against a
 * blueprint the SDK no longer supports.
 *
 * The failure was loud when it finally ran ("Validator
 * protocol_params.protocol_params.mint not found in ... v0.5.0-alpha.2"), but it
 * took a live devnet to run at all. A version written in two places is one fact
 * that can disagree with itself; deriving it from the constant removes the
 * second place.
 */
export function standardBlueprintDir(): string {
  return resolve(ROOT, `blueprints/standard/v${TARGET_PROTOCOL_VERSION}`);
}

export function loadStandardBlueprint(): PlutusBlueprint {
  return JSON.parse(readFileSync(resolve(standardBlueprintDir(), "plutus.json"), "utf-8"));
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
 * Bootstrap a protocol instance on a TESTNET. Returns DeploymentParams.
 *
 * Defaults to the local Yaci devnet. Pass `client`/`evaluator` to run the same
 * sequence against another testnet — preview, say, via a Blockfrost provider.
 * Only two things were ever devnet-specific: where the client points, and the
 * evaluator. The faucet call is already self-skipping (it is guarded on
 * balance < MIN_WALLET_ADA), and indexer settling is provider-agnostic.
 *
 * Refuses any non-testnet, injected client or not.
 */
export async function bootstrapProtocol(
  opts: {
    client?: any;
    evaluator?: Evaluator;
    /**
     * Positive check for "is this reward account already registered?".
     *
     * The upgrade authority's stake credential belongs to the WALLET, so it
     * survives across deployments and a second bootstrap legitimately finds it
     * registered. That was previously tolerated by MATCHING THE ERROR TEXT
     * ("already known credential" / "3145") — which is Ogmios's vocabulary.
     * Blockfrost returns an opaque "submitTx failed" for the same condition, so
     * the tolerance silently did not apply and a redeploy failed outright.
     * Ask the chain instead of parsing a provider's prose.
     */
    isStakeRegistered?: (stakeAddress: string) => Promise<boolean>;
    /**
     * Wait for a transaction to be visible on chain.
     *
     * ⚠ MEASURED: Evolution's own awaitTx gave up after 90s on preview while
     * the transaction had ALREADY been included — Blockfrost's confirmation
     * view lags block inclusion. A deployment then aborted on a transaction
     * that had succeeded. The devnet's default is fine; a public provider
     * wants a poller that asks the same source the deployment will be read
     * from afterwards.
     */
    awaitTx?: (txHash: string) => Promise<void>;
  } = {}
): Promise<DeploymentParams> {
  const client = opts.client ?? (await makeClient());
  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  const networkId = client.chain.id;

  if (networkId !== 0) {
    throw new Error("bootstrapProtocol is devnet-only; refusing to run against a non-testnet");
  }

  // ---- Preflight: wait for the indexer to catch up ------------------------
  //
  // Kupo and yaci-store lag the node. Immediately after another transaction —
  // typically the previous test file's — `getUtxos` still reports inputs the
  // node already knows are spent, and the resulting submission is rejected with
  // code 3117, "unknown UTxO references as inputs".
  //
  // That error names a UTxO and reads as a builder bug. It is not: the builder
  // faithfully used what the provider told it. Waiting for two consecutive
  // IDENTICAL reads is a cheap proxy for "the indexer has settled" — a single
  // read cannot distinguish a settled view from a stale one.
  const utxoFingerprint = async () =>
    (await client.getUtxos(addressObj))
      .map((u: EvoUTxO.UTxO) => `${EvoTransactionHash.toHex(u.transactionId)}#${u.index}`)
      .sort()
      .join(",");
  const settleIndexer = async () => {
    let previousView = await utxoFingerprint();
    for (let i = 0; i < 20; i++) {
      await sleep(1_000);
      const current = await utxoFingerprint();
      if (current === previousView) return;
      previousView = current;
    }
  };
  await settleIndexer();

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
  // Record every parameterisation as it happens. The CIP-171 record is DERIVED
  // from this, never transcribed alongside it: the unapplied hash and the
  // application-order arguments are properties of these calls and nothing else.
  const paramEvents: ParameterizationEvent[] = [];
  const builders = createStandardScripts(blueprint, (e) => paramEvents.push(e));

  const alwaysFailB = builders.alwaysFail(ALWAYS_FAIL_NONCE_B);

  // NO NONCE, AND NO ORDERING EDGE. protocol_params takes only its one-shot
  // utxo_ref now: the mint side no longer depends on a spend-side address, so
  // the cycle that forced coordination_spend to be built first is dissolved and
  // there is no nonce to choose. Its hash is BOTH the NFT policy id and the
  // address payment credential -- the minting policy naming itself.
  const protocolParams = builders.protocolParams(utxo1Ref);
  const paramsPolicy = protocolParams.hash;

  const plb = builders.programmableLogicBase(paramsPolicy);

  // The registry no longer touches the params chain at all -- it reads its own
  // policy off its own input payment credential -- so it can be built as soon
  // as issuance_cbor_hex_mint exists. Its hash is also BOTH policy and address.
  const issuanceCborHexMint = builders.issuanceCborHexMint(utxo2Ref, alwaysFailB.hash);
  const registry = builders.registry(utxo1Ref, issuanceCborHexMint.hash);

  // Delegates: (prog_logic_cred, registry_node_cs, max_inline_datum_bytes).
  // prog_logic_cred is PLB, NOT the dispatcher -- the dispatcher is
  // parameterised BY these three, so the reverse would be a parameter cycle.
  const transfer = builders.transfer(plb.hash, registry.hash, MAX_INLINE_DATUM_BYTES);
  const thirdParty = builders.thirdParty(plb.hash, registry.hash, MAX_INLINE_DATUM_BYTES);
  const unfracking = builders.unfracking(plb.hash, registry.hash, MAX_INLINE_DATUM_BYTES);

  // Built LAST: it names all three delegates at compile time. Replacing ONE
  // delegate therefore requires deploying a new dispatcher too.
  const plg = builders.programmableLogicGlobal(transfer.hash, thirdParty.hash, unfracking.hash);

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
  const issuanceDummy = builders.issuanceMint(plb.hash, registry.hash, DUMMY_POLICY_ID, paramsPolicy);
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
  // policy == address: the params UTxO lives at protocol_params own address.
  const paramsAddr = scriptAddress(networkId, paramsPolicy);
  const issuanceAlwaysFailAddr = scriptAddress(networkId, alwaysFailB.hash);
  const registryAddr = scriptAddress(networkId, registry.hash);

  // FOUR fields in alpha.3. registry_node_cs, prog_logic_cred, unfracking_cred
  // and max_inline_datum_bytes are all gone from the datum -- the first two
  // because their readers derive them elsewhere, unfracking because the
  // dispatcher names it at compile time, and max_inline_datum_bytes because it
  // became a script PARAMETER, so re-tuning it is a redeployment now rather
  // than a datum rewrite.
  //
  // plgCred and the two delegate creds must be written TOGETHER with the
  // dispatcher that was compiled against them. Nothing on chain checks it.
  const paramsDatum = buildProtocolParamsDatum({
    plgCred: { type: "script", hash: plg.hash },
    transferCred: { type: "script", hash: transfer.hash },
    thirdPartyCred: { type: "script", hash: thirdParty.hash },
    upgradeCred: { type: "key", hash: upgradeStakeKeyHash },
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
  const protocolParamNftUnit = paramsPolicy + stringToHex("ProtocolParams");
  const directoryNftUnit = registry.hash; // empty asset name
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
  // `label` names WHICH transaction failed. Without it a bootstrap failure
  // reports only "submitTx failed" across five distinct submissions.
  /**
   * Wallet UTxOs that are safe to SPEND.
   *
   * ⛔ EXCLUDES ANY UTxO CARRYING A REFERENCE SCRIPT, whoever created it — not
   * merely this deployment's four. MEASURED on preview: after three
   * deployments the wallet held 11 script-bearing UTxOs of 22, and Evolution's
   * coin selection is free to pick them. Spending one DESTROYS that
   * deployment's infrastructure AND drags the script's bytes into the
   * transaction, which is what burst the 16,384-byte cap on tx2.
   *
   * The narrower filter in the FES plugin knows only about the CURRENT
   * DeploymentParams. On a long-lived testnet wallet that is not enough: every
   * past deployment left four behind.
   */
  const spendable = (all: EvoUTxO.UTxO[]) => all.filter((u: any) => !u.scriptRef);

  const submitAndWait = async (built: { signAndSubmit: () => Promise<unknown> }, label = "?") => {
    if (process.env.TX_SIZE_DIAG) {
      try {
        const cbor = EvoTx.toCBORHex(await (built as any).toTransaction());
        console.error(`  [tx size] ${label}: ${cbor.length / 2} bytes (limit 16384)`);
      } catch (e) {
        console.error(`  [tx size] unavailable: ${(e as Error).message}`);
      }
    }
    let res: unknown;
    try {
      res = await built.signAndSubmit();
    } catch (err: any) {
      // Effect wraps the provider error; the ledger's reason is nested. Walk it.
      const parts: string[] = [];
      const walk = (o: any, d = 0) => {
        if (!o || d > 8) return;
        if (typeof o === "string") { if (o.length > 3) parts.push(o.slice(0, 800)); return; }
        if (typeof o !== "object") return;
        for (const v of Object.values(o)) walk(v, d + 1);
        if (o.cause) walk(o.cause, d + 1);
      };
      walk(err);
      console.error(`  [submit error] ${label}:\n  | ` + explainError(err));
      throw err;
    }
    const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res as never);
    if (opts.awaitTx) await opts.awaitTx(hash);
    else await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 180_000);
    return hash;
  };
  // An injected client brings its own evaluation; only the devnet needs the
  // custom Ogmios evaluator (it exists for the Aiken traces, which Blockfrost
  // does not return).
  const evaluator =
    opts.evaluator ??
    (opts.client
      ? undefined
      : createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"));

  // ---- CIP-171 provenance, carried by Tx 1 --------------------------------
  // Attached to the bootstrap transaction because that is what was asked for
  // and because one artefact is easier to inspect. It is NOT required to ride
  // this tx: the registry's ingest filters on `label == 1984` alone and never
  // sees the transaction's scripts, so association happens later, by script
  // hash, at lookup time.
  //
  // ⚠ A wrong-arity constr-0 record is DISCARDED SILENTLY — no error, no
  // REJECTED row, no trace. From outside, dropped and never-published are
  // indistinguishable. Verify with a POSITIVE lookup by tx hash; "no error
  // appeared" is consistent with total success and total failure alike.
  // `issuance_mint` is EXCLUDED, and the exclusion is semantic rather than
  // convenient: it is parameterised PER MINTING-LOGIC HASH — once per
  // substandard — so the instance built here belongs to the dummy fixture, not
  // to the core deployment. Its applied hash is deployed by a substandard
  // registration, so it belongs in that substandard's record. Recording it here
  // would name a script this deployment does not run.
  const coreEvents = paramEvents.filter((e) => e.title !== STANDARD_VALIDATORS.ISSUANCE_MINT);
  const cip171Chunks = buildCip171Metadatum(
    buildDeploymentRecord(standardBlueprintDir(), coreEvents) as never
  );

  // ---- Tx 1: mints + protocol state --------------------------------------
  let tx = client.newTx();
  tx = tx.attachMetadata({ label: CIP171_METADATA_LABEL, metadata: cip171Chunks });
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
    address: EvoAddress.fromBech32(paramsAddr),
    assets: outputAssets(2_000_000n, new Map([[protocolParamNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: paramsDatum }),
  });
  // 3 ADA, not 2: the origin node's datum is SEVEN fields now and min-UTxO
  // scales with serialised output size. MEASURED at 2,038,630 for a node of
  // this shape — the inherited 2,000,000 was sized for the five-field datum.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(registryAddr),
    assets: outputAssets(REGISTRY_NODE_MIN_ADA, new Map([[directoryNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: directoryDatum }),
  });
  // The issuance datum carries ~5kB of CBOR; min-UTxO scales with serialized
  // output size, hence the much larger ADA floor here.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(issuanceAlwaysFailAddr),
    assets: outputAssets(15_000_000n, new Map([[issuanceNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: issuanceDatum }),
  });

  tx = tx.attachScript({ script: buildEvoScript(registry.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(protocolParams.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(issuanceCborHexMint.compiledCode) });

  const bootstrapTxHash = await submitAndWait(
    await tx.build({ changeAddress: addressObj, evaluator, availableUtxos: spendable(await client.getUtxos(addressObj)) }), "tx1-protocol-state"
  );

  // ---- Tx 2: publish reference scripts ------------------------------------
  // FIVE scripts now, not four: the dispatcher's reference script joins them.
  // Every programmable transaction withdraws through it, so it needs the same
  // on-chain availability the delegates have.
  // ⚠ Order is load-bearing: it defines the reference-input indices recorded in
  // DeploymentParams (see REF_SCRIPT_ORDER below, which must list the same
  // names in the same order).
  let refTx = client.newTx();
  for (const script of [plb, plg, transfer, thirdParty, unfracking]) {
    refTx = refTx.payToAddress({
      address: addressObj,
      assets: outputAssets(20_000_000n),
      script: buildEvoScript(script.compiledCode),
    });
  }
  const refTxHash = await submitAndWait(
    await refTx.build({ changeAddress: addressObj, evaluator, availableUtxos: spendable(await client.getUtxos(addressObj)) }), "tx2-reference-scripts"
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
  const upgradeStakeAddr = rewardAddressFromKeyHash(networkId, upgradeStakeKeyHash);
  const alreadyRegisteredUpfront = opts.isStakeRegistered
    ? await opts.isStakeRegistered(upgradeStakeAddr)
    : false;
  if (alreadyRegisteredUpfront) {
    console.error(
      `  [bootstrap] upgrade authority ${upgradeStakeAddr} is already registered — skipping`
    );
  } else try {
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
    await submitAndWait(await keyRegTx.build({ changeAddress: addressObj, evaluator }), "tx3-key-register-delegate");
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
    await submitAndWait(await delegateTx.build({ changeAddress: addressObj, evaluator }), "tx4-delegate");
  }

  // ⛔ FOUR, NOT THREE — the dispatcher is a withdraw-0 validator too.
  //
  // alpha.3 puts programmable_logic_global's withdrawal on EVERY programmable
  // transaction, and a withdraw-0 cannot appear against an unregistered reward
  // account. Registering only the three delegates leaves the protocol
  // inoperable in a way that names nothing useful: the ledger answers code 3141
  // ("rewards withdrawals must consume rewards in full"), which reads as a
  // balance problem and is really an unregistered credential.
  //
  // MEASURED on devnet — this is not a precaution. Every programmable operation
  // failed with 3141 until the dispatcher joined this list.
  let regTx = client.newTx();
  for (const delegate of [plg, transfer, thirdParty, unfracking]) {
    regTx = regTx.registerStake({
      stakeCredential: Credential.makeScriptHash(Bytes.fromHex(delegate.hash)),
      redeemer: voidData(),
    });
    regTx = regTx.attachScript({ script: buildEvoScript(delegate.compiledCode) });
  }
  await submitAndWait(await regTx.build({ changeAddress: addressObj, evaluator }), "tx5-script-stake-register");

  // The caller will immediately build against this wallet, and the indexer is
  // still catching up with the three transactions above. Settling here rather
  // than in every caller keeps the hazard in one place — a bootstrap that hands
  // back a DeploymentParams the chain agrees with, but a wallet view it does
  // not, is a trap for every test that follows.
  await settleIndexer();

  // ---- Step 6: assemble DeploymentParams ---------------------------------
  //
  // Output indices must match the payToAddress order above EXACTLY. They are
  // positional and nothing checks them but the devnet test that follows.
  //
  // Tx 1 outputs: 0 params NFT, 1 registry origin, 2 issuance CBOR NFT.
  // Tx 2 outputs: the ref-script loop, in ITS order.
  //
  // ⚠ THE LOOP ORDER AND THESE CONSTANTS ARE ONE FACT WRITTEN TWICE. alpha.3
  // inserted the dispatcher at index 1, shifting all three delegates down — a
  // mismatch here does not fail loudly, it hands out a reference input carrying
  // the WRONG script and the transaction dies at evaluation naming neither.
  // Derived from the array below rather than counted by hand.
  const REF_SCRIPT_ORDER = ["plb", "plg", "transfer", "thirdParty", "unfracking"] as const;
  const refIdx = (name: (typeof REF_SCRIPT_ORDER)[number]) => REF_SCRIPT_ORDER.indexOf(name);

  const OUT_COORDINATION = 0;
  const REF_PLB = refIdx("plb");
  const REF_PLG = refIdx("plg");
  const REF_TRANSFER = refIdx("transfer");
  const REF_THIRD_PARTY = refIdx("thirdParty");
  const REF_UNFRACKING = refIdx("unfracking");

  return {
    txHash: bootstrapTxHash,
    protocolParams: {
      txInput: utxo1Ref,
      // ONE value: policy id AND address payment credential.
      policyId: paramsPolicy,
      utxo: { txHash: bootstrapTxHash, outputIndex: OUT_COORDINATION },
    },
    programmableLogicBase: { scriptHash: plb.hash },
    transfer: { scriptHash: transfer.hash },
    thirdParty: { scriptHash: thirdParty.hash },
    unfracking: { scriptHash: unfracking.hash },
    programmableLogicGlobal: { scriptHash: plg.hash },
    maxInlineDatumBytes: Number(MAX_INLINE_DATUM_BYTES),
    upgradeMultisig: { scriptHash: upgradeMultisig.hash },
    upgradeAuthority: { type: "key", hash: upgradeStakeKeyHash },
    issuance: {
      txInput: utxo2Ref,
      policyId: issuanceCborHexMint.hash,
      alwaysFailScriptHash: alwaysFailB.hash,
    },
    registry: {
      txInput: utxo1Ref,
      issuanceScriptHash: issuanceCborHexMint.hash,
      // ONE value again: node NFT policy AND node address payment credential.
      scriptHash: registry.hash,
    },
    programmableBaseRefInput: { txHash: refTxHash, outputIndex: REF_PLB },
    programmableLogicGlobalRefInput: { txHash: refTxHash, outputIndex: REF_PLG },
    transferRefInput: { txHash: refTxHash, outputIndex: REF_TRANSFER },
    thirdPartyRefInput: { txHash: refTxHash, outputIndex: REF_THIRD_PARTY },
    unfrackingRefInput: { txHash: refTxHash, outputIndex: REF_UNFRACKING },
  };
}
