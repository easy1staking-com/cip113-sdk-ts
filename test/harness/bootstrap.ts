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
 * TARGETS CIP-113 0.5.0-alpha.4 (upstream d37ca8d).
 *
 * The topology this fixture stands up, and the three things alpha.4 changed:
 *
 *  * THE ISSUANCE SPLIT. `issuance_mint` is the PERMANENT half — it is still
 *    parameterised per minting-logic hash and still owns the policy id, so it
 *    can never be replaced without moving every token's policy. It now
 *    dispatches to a REPLACEABLE half, `issuance_logic`, named by the params
 *    datum's field 1 rather than baked in. Every mint AND every burn carries
 *    that withdraw-0, so `issuance_logic`'s stake credential is on the critical
 *    path of both and must be registered here, not opportunistically later.
 *  * THE PARAMS DATUM IS SIX FIELDS. `issuance_logic_cred` was INSERTED at
 *    index 1 and `pending_upgrade_cred` appended at index 5. The insertion
 *    displaced `transfer_cred` to index 2 — both are `Credential`, so a datum
 *    written in alpha.3's order with two fields appended has the right arity,
 *    decodes cleanly, and hands `issuance_mint` the wrong authority.
 *  * THE MULTISIG CONFIG UTxO. `upgrade_multisig` is parameterised by its own
 *    one-shot `utxo_ref` and holds its signer tree in a config UTxO rather than
 *    in its parameters — which is what makes it DERIVABLE from a recorded
 *    `DeploymentParams` for the first time, and what makes it usable as the
 *    upgrade authority (see the `publish` note where the authority is built).
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
  minUtxoAtLeast,
  multisigScriptDatum,
  decodeMultisigScript,
  getInlineDatum,
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
/**
 * The floor below which the bootstrap tops up from the faucet.
 *
 * RAISED FROM 200 ADA FOR alpha.4, and the arithmetic is the whole reason:
 *
 *   tx2 reference outputs   7 x 20 ADA = 140   (was 5 x 20 = 100 — issuance_logic
 *                                               and upgrade_multisig joined)
 *   tx1 protocol state      2 + 3 + 15  =  20   (params, registry origin, issuance CBOR)
 *   tx0 multisig config             ~2  =   2   (min-UTxO for the NFT + Signature tree)
 *   three seed UTxOs         3 x 5 ADA =  15
 *                                        -----
 *                                          177  before a single fee
 *
 * 200 no longer clears that with anything worth calling a margin, and the way it
 * fails is not "insufficient funds" — coin selection simply runs out partway and
 * the failure names whichever output it could not fund. 400 covers the 177 plus
 * fees, collateral and the change churn of six transactions, with room for the
 * next two scripts to join tx2 without this constant needing a third revision.
 */
const MIN_WALLET_ADA = 400_000_000n;
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
  // need THREE independent UTxOs, each consumed by the transaction that mints
  // against it: utxo1 -> protocol_params + registry, utxo2 -> issuance_cbor_hex,
  // utxo3 -> upgrade_multisig.
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
  // ⛔ THREE, NOT TWO. The loop above already asked for three; this bound
  // tolerated two and would have handed `undefined` to the third consumer.
  if (fragUtxos.length < 3) {
    throw new Error(`Fragmentation produced ${fragUtxos.length} seed UTxOs, need ≥3`);
  }
  fragUtxos.sort((a, b) => Number(a.index) - Number(b.index));

  const utxo1 = fragUtxos[0];
  const utxo2 = fragUtxos[1];
  const utxo3 = fragUtxos[2];
  const utxo1Ref: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo1.transactionId),
    outputIndex: Number(utxo1.index),
  };
  const utxo2Ref: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo2.transactionId),
    outputIndex: Number(utxo2.index),
  };
  /**
   * ⛔ A DISTINCT SEED FOR `upgrade_multisig`, NOT A REUSE OF utxo1.
   *
   * Reusing utxo1 would build and deploy perfectly well — a one-shot outref is
   * consumed once and both policies would be consuming it in different
   * transactions, so nothing on chain objects. The reason it must be distinct
   * is OFF chain: `DeploymentParams` now carries TWO same-typed one-shot
   * outrefs, `protocolParams.txInput` and `upgradeMultisig.txInput`, and
   * `assertDeploymentScripts` derives a hash from each. A fixture that gives
   * them ONE value makes the `upgrade_multisig` check pass whichever field the
   * code reads — so the check cannot fail, and a real defect in which field is
   * read is invisible.
   *
   * That is not hypothetical here. It is the S-11 vacuity trap in its alpha.4
   * shape: the alpha.3 `upgrade_multisig` check derived the script from
   * `upgradeAuthority.hash` — a payment-vs-stake relationship that does not
   * exist — and passed for an entire migration because the offline fixture used
   * one value for both fields. A conflated fixture cannot test whether the code
   * conflates them.
   */
  const utxo3Ref: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo3.transactionId),
    outputIndex: Number(utxo3.index),
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

  // ---- The upgrade authority, built FIRST because it depends on nothing ----
  //
  // ⚑ ONE ARGUMENT IN alpha.4, and the change of kind matters more than the
  // change of arity. alpha.3 took `([signer], threshold)` — the signer set was
  // a compile-time parameter, so it was a deployment choice `DeploymentParams`
  // did not record and the script could NOT be re-derived from a record. alpha.4
  // takes a one-shot `utxo_ref` and moves the signer tree into a config UTxO,
  // which is what makes this the ninth and tenth derivable check rather than an
  // undecidable one.
  //
  // Depends on nothing but utxo3Ref, so it is built here and its config UTxO is
  // minted in tx0 — BEFORE the protocol genesis names it. See tx0.
  const adminPkh = paymentCredentialHash(address);
  const upgradeMultisig = builders.upgradeMultisig(utxo3Ref);

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

  /**
   * `issuance_logic` — the REPLACEABLE half of issuance, new in alpha.4.
   *
   * ⛔ PARAMETERS 2 AND 3 ARE TWO ADJACENT `PolicyId`s AND BOTH ARE `string`.
   * The order, written down here because nothing else can enforce it:
   *
   *     1  progLogicCred        = plb.hash        (programmable_logic_base,
   *                                                NOT the dispatcher — same as
   *                                                the three delegates)
   *     2  registryPolicy       = registry.hash   <- registry_node_cs
   *     3  paramsPolicy         = paramsPolicy    <- params_policy
   *     4  maxInlineDatumBytes
   *
   * Swapping 2 and 3 yields a script that builds, hashes, deploys and is
   * registered without a murmur — it simply looks for the registry under the
   * params policy for the rest of its life. No type can tell them apart and no
   * on-chain rail catches it at deploy time; only `assertDeploymentScripts`
   * re-deriving the hash does.
   *
   * Built AFTER `registry` and `protocolParams`, because it names both.
   */
  const issuanceLogic = builders.issuanceLogic(
    plb.hash,
    registry.hash,
    paramsPolicy,
    MAX_INLINE_DATUM_BYTES,
  );

  // ---- Why a SCRIPT authority is safe here, and was not in alpha.3 ---------
  //
  // ⚑ THIS IS THE RECORD OF A REMOVED CONSTRAINT, NOT AN ABSENCE. Until
  // alpha.4 this fixture installed the WALLET'S VERIFICATION KEY as the upgrade
  // authority and carried an essay explaining why it had to. The constraint was
  // real and the reasoning was sound:
  //
  //   * protocol_params' authorisation check only requires `upgrade_cred` to
  //     appear in `tx.withdrawals` — it never inspects the authority's
  //     internals — so the credential must be a REGISTERED stake credential.
  //   * alpha.3's `upgrade_multisig` had `withdraw` and `else` and NO `publish`
  //     handler. A Conway RegCert runs the script under the PUBLISH purpose, so
  //     a script-witnessed registration fell through to `else` and failed; and
  //     Evolution refuses an unwitnessed one outright ("Redeemer required for
  //     script-controlled stake credential registration", OBSERVED on devnet).
  //   * Naming a credential that cannot be registered is upstream's documented
  //     ONE-WAY BRICK: the authority check becomes "permanently unsatisfiable,
  //     with no repair path".
  //
  // ⇒ WHAT REMOVED IT, precisely: upstream d37ca8d gives `upgrade_multisig` a
  //   `publish` handler — `publish(_r, c, _s) { when c is { RegisterCredential
  //   { .. } -> True; _ -> False } }`. That single handler, and nothing else, is
  //   why tx5 can register this script's stake credential and why `upgrade_cred`
  //   may now be `Script(upgrade_multisig)`. It is not a relaxation of the rule
  //   above — the rule still holds, and the credential now satisfies it.
  //
  // ⚠ The handler admits `RegisterCredential` ONLY. See tx5: a combined
  //   register-and-delegate certificate is a different `Certificate`
  //   constructor and this handler returns False for it.
  //
  // The wallet's own stake key is still derived and still registered (tx3/tx4),
  // but as the HANDOVER NOMINEE rather than as the authority.
  const upgradeStakeKeyHash = stakingCredentialHash(address);

  // issuance_mint is parameterised per minting logic, which is not known until
  // a token is registered. Build it once against a placeholder and store the
  // CBOR either side of that placeholder, so registration can splice in the
  // real hash without re-deriving the whole script.
  //
  // ⚑ TWO ARGUMENTS IN alpha.4, AND THE CREDENTIAL MOVED TO FIRST:
  // `(mintingLogicHash, paramsPolicy)`. It was `(plb, registry, DUMMY, params)`.
  // The delegate credentials it used to be compiled against now reach it
  // through the params datum instead — which is the whole point of the split.
  // ⚠ The arity change is the ONLY reason a mistake here is caught: under the
  // alpha.3 call `plb.hash` sat in first position, and `plb.hash` and
  // `DUMMY_POLICY_ID` are both 28-byte hex.
  const issuanceDummy = builders.issuanceMint(DUMMY_POLICY_ID, paramsPolicy);
  const dummyBody = scriptBodyHex(issuanceDummy.compiledCode);
  const splitParts = dummyBody.split(DUMMY_POLICY_ID);
  /**
   * ⛔ KEEP THIS AS A HARD FAILURE. The splice reassembles the script from
   * `cborPre + <real minting logic hash> + cborPost`, so it is only correct
   * while the placeholder occurs EXACTLY ONCE. Zero occurrences means the
   * parameter is no longer inlined where we think; two means the splice would
   * silently rewrite an unrelated byte run.
   *
   * MEASURED on the vendored alpha.4 artefact (Ticket Owner, 2026-09-10): one
   * occurrence, prefix 688 B, postfix 37 B, byte-aligned. The
   * `IssuanceCborHex` datum shrinks from ~2,061 B to ~725 B accordingly.
   *
   * ⚠ THE CUT MOVED. In alpha.3 the placeholder was the THIRD of four
   * parameters; in alpha.4 it is the FIRST of two, so the split now cuts near
   * the start of the parameter block rather than near its end. And flat UPLC is
   * BIT-packed: a parameter is only findable as a whole number of hex bytes
   * when it happens to land on a byte boundary. That alignment is a property to
   * be MEASURED per artefact, never assumed — this check is what measures it,
   * which is why it must not become a warning.
   */
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

  /**
   * SIX fields in alpha.4, written BY NAME and never as a positional spread.
   *
   * ⛔ INDEX 1 CHANGED MEANING BETWEEN alpha.3 AND alpha.4. `issuance_logic_cred`
   * was INSERTED at index 1, displacing `transfer_cred` to index 2. Both are
   * `Credential` — same constructor, same 28 bytes — so a datum written in
   * alpha.3's order with two fields appended to the end:
   *
   *     [plg, transfer, thirdParty, upgrade, <two more>]   WRONG
   *     [plg, issuanceLogic, transfer, thirdParty, upgrade, pending]   RIGHT
   *
   * is SIX fields long, passes the arity check, passes `params_wellformed`
   * (which only asserts each credential is 28 bytes), decodes cleanly into a
   * well-formed record, and hands `issuance_mint` the TRANSFER credential as
   * its issuance authority. Nothing at deploy time can catch it; it surfaces as
   * a mint failing against a script that was never meant to gate mints. Keying
   * the record is what makes the compiler an ally here — a positional spread
   * would accept the wrong order silently.
   *
   * ⛔ `pendingUpgradeCred` MUST BE `null` AT GENESIS. `protocol_params` runs
   * `params_wellformed(genesis_params, is_init: True)`, and `is_init: True` is
   * exactly what forbids a nomination baked into the genesis datum. A `Some(..)`
   * here does not deploy — it fails the mint.
   *
   * plgCred and the delegate creds must still be written TOGETHER with the
   * dispatcher compiled against them. Nothing on chain checks that.
   */
  const paramsDatum = buildProtocolParamsDatum({
    plgCred: { type: "script", hash: plg.hash },
    issuanceLogicCred: { type: "script", hash: issuanceLogic.hash },
    transferCred: { type: "script", hash: transfer.hash },
    thirdPartyCred: { type: "script", hash: thirdParty.hash },
    upgradeCred: { type: "script", hash: upgradeMultisig.hash },
    pendingUpgradeCred: null,
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

  // ---- Tx 0: the UpgradeMultisig config UTxO, BEFORE the protocol genesis --
  //
  // ⛔ THE ORDER IS THE POINT, AND IT IS NOT A STYLE CHOICE.
  //
  // tx1 writes a genesis datum naming `upgrade_cred = Script(upgrade_multisig)`.
  // That authority is only usable while its config UTxO exists — the tree lives
  // there, not in the script's parameters. If the multisig genesis were to run
  // AFTER the protocol genesis and fail, the protocol would exist on chain
  // naming an authority whose config UTxO does not exist: upstream's documented
  // ONE-WAY BRICK, with no repair path, manufactured by our own transaction
  // ordering rather than by any defect in the validators.
  //
  // Failing BEFORE the irreversible step costs a devnet transaction and nothing
  // else. (Upstream's genesis mint does NOT require the authority to withdraw,
  // so the config UTxO need only exist before the first UPGRADE — but "before
  // the genesis" is the only ordering that cannot strand anything.)
  //
  // The four rails `upgrade_multisig.mint` enforces, all in this one output:
  //   1. the named UTxO (utxo3Ref) is consumed              -> collectFrom
  //   2. exactly one "UpgradeMultisig" token of this policy -> mintAssets
  //   3. an output found by `has_nft_strict`                -> see below
  //   4. well_formed(tree), no reference script, address == from_script(policy)
  const multisigNftUnit = upgradeMultisig.hash + stringToHex("UpgradeMultisig");
  const multisigAddr = scriptAddress(networkId, upgradeMultisig.hash);
  const multisigDatum = multisigScriptDatum({ type: "signature", keyHash: adminPkh });
  const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;
  // ⛔ THE NFT AND NOTHING ELSE. `has_nft_strict` is strict about the WHOLE
  // value: bundling any other asset with the config NFT means the output is
  // simply NOT FOUND by `list.expect_find`, and the genesis fails naming
  // nothing about bundling. Change is a separate output; this one carries the
  // token and lovelace only.
  const multisigAssets = new Map([[multisigNftUnit, 1n]]);
  // ⚠ Evolution does NOT rescue an under-funded payToAddress output. A shortfall
  // survives to submission and is reported as "insufficient Ada" — never as
  // "your datum grew". Solve for it instead of guessing a flat figure.
  const multisigLovelace = minUtxoAtLeast(2_000_000n, {
    address: multisigAddr,
    assets: outputAssets(0n, multisigAssets),
    datum: multisigDatum,
    coinsPerUtxoByte,
  });

  let msTx = client.newTx();
  msTx = msTx.collectFrom({ inputs: [utxo3] });
  msTx = msTx.mintAssets({
    assets: mintAssetsFromMap(new Map([[multisigNftUnit, 1n]])),
    redeemer: voidData(),
  });
  msTx = msTx.payToAddress({
    address: EvoAddress.fromBech32(multisigAddr),
    assets: outputAssets(multisigLovelace, multisigAssets),
    datum: new InlineDatum.InlineDatum({ data: multisigDatum }),
    // NO `script:` here — rail 4 requires `reference_script == None`. The
    // reference script is published in tx2 like every other one.
  });
  /**
   * A DECOY: a second, NFT-FREE UTxO parked at the multisig address.
   *
   * ⛔ THIS IS A FIXTURE FOR THE GATE BELOW, NOT PROTOCOL STATE. It exists so
   * the policy-correlation clause in the config-UTxO lookup is exercised rather
   * than merely claimed. MEASURED (audit r1, F-2): with only ONE UTxO at this
   * address, replacing that filter with "take anything at this address" changed
   * nothing — both the harness gate and the devnet test stayed green, while
   * their comments asserted the filter asked the question the validator asks. A
   * lookup that has never had to discriminate has not been shown to.
   *
   * ⚑ It is also a REAL condition, not an invented one. Upstream at d37ca8d,
   * `upgrade_multisig.spend`, contemplates it explicitly: "a second UTxO at the
   * address cannot carry the one-shot NFT ... junk UTxOs parked at the address
   * cannot interfere." Anyone may pay to a script address at any time.
   *
   * ⚠ Safe against `upgrade_multisig.mint`: rail 3 uses `list.expect_find` over
   * outputs, which SKIPS a non-matching output rather than rejecting it, and
   * rails 1/2/4 constrain the mint, the token count and `nft_output` only. This
   * output carries no NFT, so `has_nft_strict` never matches it.
   *
   * ⚠ It is permanently unspendable (no datum, so `expect Some(old_tree)` in the
   * spend handler fails). That is deliberate and costs one min-UTxO of devnet
   * ADA per bootstrap. It does not accumulate: every bootstrap derives a NEW
   * upgrade_multisig from a new seed, hence a new address.
   */
  const decoyLovelace = minUtxoAtLeast(2_000_000n, {
    address: multisigAddr,
    assets: outputAssets(0n),
    coinsPerUtxoByte,
  });
  msTx = msTx.payToAddress({
    address: EvoAddress.fromBech32(multisigAddr),
    assets: outputAssets(decoyLovelace),
  });
  msTx = msTx.attachScript({ script: buildEvoScript(upgradeMultisig.compiledCode) });

  const multisigTxHash = await submitAndWait(
    await msTx.build({
      changeAddress: addressObj,
      evaluator,
      availableUtxos: spendable(await client.getUtxos(addressObj)),
    }),
    "tx0-upgrade-multisig-genesis"
  );

  // ---- The authority is OPERABLE, not merely named ------------------------
  //
  // ⛔ AN OPERABILITY GATE, NOT DECORATION. The measured instance of "correct
  // and useless" in this repo is a deployment that named an authority credential
  // which could not be registered at all: every hash reproduced, every read-back
  // matched, every test passed, and the protocol's upgrade path was permanently
  // unsatisfiable. "It exists and is well-formed" left "and can be used"
  // untested.
  //
  // So before tx1 writes the genesis datum that names this authority, READ THE
  // CONFIG UTxO BACK OFF THE CHAIN and refuse loudly by name if it is not what
  // we meant. This is what makes it structurally impossible for the genesis
  // datum to name an authority that does not exist — rather than a comment
  // saying it must not.
  await settleIndexer();
  const multisigAtAddress = await client.getUtxos(EvoAddress.fromBech32(multisigAddr));
  // ⚑ PROVE THE FILTER HAS SOMETHING TO REJECT. tx0 parked a decoy alongside the
  // config UTxO precisely so this lookup must discriminate; if the decoy is not
  // there, the filter below is passing over a population of one and this gate is
  // back to being a claim rather than a check. Fail loudly rather than silently
  // reverting to vacuity.
  if (multisigAtAddress.length < 2) {
    throw new Error(
      `upgrade_multisig address ${multisigAddr} holds ${multisigAtAddress.length} UTxO(s); the ` +
        `bootstrap parks a decoy beside the config UTxO so the policy filter below is exercised. ` +
        `With fewer than 2 there is nothing to discriminate and the gate proves nothing.`
    );
  }
  const multisigCandidates = multisigAtAddress
    // ⚑ STRUCTURALLY, BY POLICY, EXACTLY AS THE VALIDATOR DOES — `has_currency_
    // symbol`, not an equality test against a unit string we just built. A
    // lookup keyed on our own constructed unit shares a blind spot with the
    // code that constructed it: get the asset name wrong in both places and the
    // check agrees with itself. Asking "is there any asset under this policy?"
    // is a question our own bug cannot answer for us.
    //
    // ⛔ AND THE CLAUSE IS LOAD-BEARING, NOT DECORATIVE — which is only true
    // because of the decoy above. Audit r1 F-2 measured this exact filter
    // surviving replacement by "take anything at this address", because there
    // was only ever one UTxO here. Delete the decoy and this comment becomes a
    // lie again.
    .filter((u: EvoUTxO.UTxO) =>
      EvoAssets.getUnits(u.assets).some((unit) => unit !== "lovelace" && unit.slice(0, 56) === upgradeMultisig.hash)
    );
  if (multisigCandidates.length !== 1) {
    throw new Error(
      `upgrade_multisig config UTxO: expected exactly 1 UTxO at ${multisigAddr} carrying an ` +
        `asset of policy ${upgradeMultisig.hash}, found ${multisigCandidates.length}. The NFT is ` +
        `one-shot, so zero means the genesis output was not found where the validator locks it, ` +
        `and more than one means this address is not what we think it is. Refusing to write a ` +
        `genesis datum naming an authority whose config UTxO is not exactly one well-formed UTxO.`
    );
  }
  const multisigUtxo = multisigCandidates[0]!;
  const multisigDatumOnChain = getInlineDatum(multisigUtxo);
  if (!multisigDatumOnChain) {
    throw new Error(
      `upgrade_multisig config UTxO ${multisigTxHash}#${Number(multisigUtxo.index)} carries no ` +
        `inline datum. The tree IS the authority; without it the credential is unsatisfiable.`
    );
  }
  // ⚠ `decodeMultisigScript` deliberately enforces none of upstream's
  // `well_formed` rules — that asymmetry with the encoder is intentional and is
  // not to be tidied. So assert the SHAPE here, by name.
  const multisigTree = decodeMultisigScript(multisigDatumOnChain);
  if (multisigTree.type !== "signature" || multisigTree.keyHash !== adminPkh) {
    throw new Error(
      `upgrade_multisig config UTxO holds the wrong authority tree: expected ` +
        `Signature(${adminPkh}) — the bootstrapping wallet's payment credential — but the chain ` +
        `holds ${JSON.stringify(multisigTree)}. An authority nobody can satisfy is a permanent ` +
        `brick with no repair path, so this refuses before the genesis rather than after it.`
    );
  }
  const multisigUtxoRef: TxInput = {
    txHash: EvoTransactionHash.toHex(multisigUtxo.transactionId),
    outputIndex: Number(multisigUtxo.index),
  };

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

  // ⚠ SOLVED, NOT FLAT. The datum grew from four fields to six and min-UTxO
  // scales with serialised output size; the inherited flat 2 ADA was sized for
  // the four-field layout. An under-funded output is not rescued by Evolution —
  // the shortfall survives to submission and is reported as "insufficient Ada",
  // which sends the reader to the wallet balance rather than to the datum.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(paramsAddr),
    assets: outputAssets(
      minUtxoAtLeast(2_000_000n, {
        address: paramsAddr,
        assets: outputAssets(0n, new Map([[protocolParamNftUnit, 1n]])),
        datum: paramsDatum,
        coinsPerUtxoByte,
      }),
      new Map([[protocolParamNftUnit, 1n]])
    ),
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
  // SEVEN scripts now, not five: `issuance_logic` rides every mint and burn,
  // and `upgrade_multisig` is needed by every upgrade authorisation — its body
  // is far past what an authorisation can afford to inline, so publishing it
  // without recording where it landed would leave the authority satisfiable in
  // principle and unusable in practice.
  //
  // ⛔ APPENDED, NEVER INSERTED. Order is load-bearing: this array and the
  // recorded output indices are ONE FACT, since `refIdx` derives the constants
  // from it (see REF_SCRIPT_ORDER below). alpha.3 inserted the dispatcher at
  // index 1 and shifted all three delegates down — and its own comment records
  // what that cost. Appending cannot move an index that already exists.
  let refTx = client.newTx();
  for (const script of [plb, plg, transfer, thirdParty, unfracking, issuanceLogic, upgradeMultisig]) {
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
  // ---- Tx 3 / Tx 4: the wallet's stake key, REGISTERED **AND** DELEGATED ---
  //
  // ⛔ THE POSTCONDITION IS A FACT ABOUT THE DOMAIN, NOT ABOUT THE ROW:
  //    THIS CREDENTIAL MUST END THIS FUNCTION BOTH REGISTERED AND DELEGATED.
  //
  // Under alpha.4 this key is no longer the upgrade authority — the multisig is
  // — but T-F03-3's handover needs it as the NOMINEE, and a nominee promotes
  // itself by presenting its OWN withdraw-0. That is a KEY withdraw-0, and
  // Conway rejects a withdrawal from an undelegated credential with code 3150
  // ("credentials that do not engage in on-chain governance") EVEN AT ZERO.
  // Registration alone is therefore not enough, and never was.
  //
  // ⚠ THE OLD GUARD SKIPPED BOTH. It asked "is it registered?" and, on yes,
  // skipped the registration AND the DRep delegation with it — reading the
  // question as though registration were the whole postcondition. A credential
  // registered by an earlier bootstrap and never delegated then reached the
  // handover undelegated, and the failure names a governance rule rather than a
  // missing certificate. So on the already-registered path we still submit the
  // delegation: re-delegating an already-delegated credential is idempotent and
  // costs one transaction; not delegating an undelegated one costs the handover.
  //
  // Separate transaction because this credential is the WALLET'S, not the
  // protocol's: it survives across bootstraps, so a second instance on the same
  // devnet legitimately finds it already registered. That is the ONLY tolerated
  // error. Anything else propagates — a blanket catch around a registration
  // would hide exactly the publish-purpose failure this fixture exists to
  // surface.
  const upgradeStakeAddr = rewardAddressFromKeyHash(networkId, upgradeStakeKeyHash);
  const delegateOnly = async () => {
    const delegateTx = client.newTx().delegateToDRep({
      stakeCredential: Credential.makeKeyHash(Bytes.fromHex(upgradeStakeKeyHash)),
      drep: new DRep.AlwaysAbstainDRep({}),
    });
    await submitAndWait(
      await delegateTx.build({
        changeAddress: addressObj,
        evaluator,
        availableUtxos: spendable(await client.getUtxos(addressObj)),
      }),
      "tx4-delegate"
    );
  };
  const alreadyRegisteredUpfront = opts.isStakeRegistered
    ? await opts.isStakeRegistered(upgradeStakeAddr)
    : false;
  if (alreadyRegisteredUpfront) {
    console.error(
      `  [bootstrap] nominee stake key ${upgradeStakeAddr} is already registered — ` +
        `delegating anyway (the postcondition is registered AND delegated)`
    );
    await delegateOnly();
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
    await submitAndWait(
      await keyRegTx.build({
        changeAddress: addressObj,
        evaluator,
        availableUtxos: spendable(await client.getUtxos(addressObj)),
      }),
      "tx3-key-register-delegate"
    );
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const alreadyRegistered =
      msg.includes("already known credential") || msg.includes("3145");
    if (!alreadyRegistered) throw err;
    // Registered by an earlier bootstrap on this devnet. The DELEGATION still
    // has to exist for the withdraw-0 to be accepted, and re-delegating an
    // already-delegated credential is harmless.
    await delegateOnly();
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
  // ⛔ SIX NOW, NOT FOUR. `issuance_logic` carries a withdraw-0 on EVERY mint
  // and EVERY burn; `upgrade_multisig` carries one on every upgrade
  // authorisation. Both fail the same undiagnosable way when unregistered —
  // code 3141, "rewards withdrawals must consume rewards in full", which reads
  // as a balance problem and is really an unregistered credential.
  //
  // ⛔ `registerStake` + `attachScript` + `voidData()`, EXACTLY AS THE FOUR
  // EXISTING ONES — never `registerAndDelegateTo` for a SCRIPT credential.
  // MEASURED (substandard-setup.ts:72-85): a combined certificate is a Conway
  // `vote_reg_deleg_cert`, which arrives at the `publish` handler as a DIFFERENT
  // `Certificate` constructor, and both `upgrade_multisig.publish` and
  // `issuance_logic.publish` admit `RegisterCredential` and nothing else.
  //
  // ⚠ And the DRep delegation the wallet key needs (tx3/tx4) is NOT missing
  // here by oversight: a script withdraw-0 needs three things — a script
  // witness, a registration, and the withdrawal itself. The DRep delegation is
  // the FOURTH thing a KEY credential needs, and a script cannot have one.
  let regTx = client.newTx();
  for (const delegate of [plg, transfer, thirdParty, unfracking, issuanceLogic, upgradeMultisig]) {
    regTx = regTx.registerStake({
      stakeCredential: Credential.makeScriptHash(Bytes.fromHex(delegate.hash)),
      redeemer: voidData(),
    });
    regTx = regTx.attachScript({ script: buildEvoScript(delegate.compiledCode) });
  }
  await submitAndWait(
    await regTx.build({
      changeAddress: addressObj,
      evaluator,
      availableUtxos: spendable(await client.getUtxos(addressObj)),
    }),
    "tx5-script-stake-register"
  );

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
  const REF_SCRIPT_ORDER = [
    "plb",
    "plg",
    "transfer",
    "thirdParty",
    "unfracking",
    // APPENDED for alpha.4 — see the tx2 loop, which must list the same names
    // in the same order. Appending leaves indices 0..4 exactly where the
    // alpha.3 deployment put them.
    "issuanceLogic",
    "upgradeMultisig",
  ] as const;
  const refIdx = (name: (typeof REF_SCRIPT_ORDER)[number]) => REF_SCRIPT_ORDER.indexOf(name);

  const OUT_COORDINATION = 0;
  const REF_PLB = refIdx("plb");
  const REF_PLG = refIdx("plg");
  const REF_TRANSFER = refIdx("transfer");
  const REF_THIRD_PARTY = refIdx("thirdParty");
  const REF_UNFRACKING = refIdx("unfracking");
  const REF_ISSUANCE_LOGIC = refIdx("issuanceLogic");
  const REF_UPGRADE_MULTISIG = refIdx("upgradeMultisig");

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
    issuanceLogic: { scriptHash: issuanceLogic.hash },
    upgradeMultisig: {
      scriptHash: upgradeMultisig.hash,
      // ⚠ utxo3Ref, and NOT utxo1Ref. Same type as protocolParams.txInput and
      // not interchangeable with it — see the utxo3Ref declaration for why one
      // value in both slots makes the derivation check vacuous.
      txInput: utxo3Ref,
      // MUTABLE STATE: the config UTxO holding the NFT and the signer tree, as
      // read back off the chain above rather than assumed from tx0's outputs.
      // A signer rotation spends and recreates it, so this record goes stale.
      utxo: multisigUtxoRef,
    },
    // ⛔ THE RECORD MUST SAY WHAT THE DATUM SAYS. This is the deployment's
    // account of the ACTIVE authority, and the genesis datum above writes
    // `upgradeCred: Script(upgradeMultisig.hash)`. Nothing derives one from the
    // other and nothing may check them against each other on chain — which is
    // exactly why they have to be written together, and why the devnet test
    // reads the datum back and compares it to this field.
    upgradeAuthority: { type: "script", hash: upgradeMultisig.hash },
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
    issuanceLogicRefInput: { txHash: refTxHash, outputIndex: REF_ISSUANCE_LOGIC },
    upgradeMultisigRefInput: { txHash: refTxHash, outputIndex: REF_UPGRADE_MULTISIG },
  };
}
