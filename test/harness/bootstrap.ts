/**
 * CIP-113 protocol bootstrap — devnet test fixture.
 *
 * Deploys a fresh protocol instance into a local devnet and returns the
 * resulting DeploymentParams, so devnet tests have something to operate
 * against.
 *
 * ⚑ THIS FILE NO LONGER BUILDS ANY TRANSACTION. Since T-D51-1 the five
 * deployment transactions are built by the SDK's own exported builders
 * (`src/standard/bootstrap.ts`); what remains here is ORCHESTRATION and
 * FIXTURE VALUES, which is exactly the split CLAUDE.md's 2026-09-17 amendment
 * draws. A harness that drifted from the exported path would be the same defect
 * the amendment exists to remove, one level in — and because the devnet suite
 * is the only thing that exercises this code against a chain, a harness that
 * stopped calling the export would leave the export untested.
 *
 * ⛔ EVERYTHING THE EXPORT MUST NOT SHIP LIVES HERE INSTEAD, and the relocation
 * is the point: the devnet mnemonic (in `yaci.mjs`), the localhost endpoints,
 * the fixture `max_inline_datum_bytes`, the fixed nonce, the faucet arithmetic,
 * the indexer settling, the retry policy, the decoy UTxO, and the wallet's own
 * nominee stake key. Each is a value or a decision this fixture makes for
 * itself and no deployment should inherit.
 *
 * It is not a supported way to deploy a production protocol. Do not point it at
 * preprod or mainnet.
 *
 * TARGETS CIP-113 v0.0.1 (upstream 6b75ba3286b4692ca23059ff51285db357fb09c6), which is a
 * BYTE-IDENTICAL RELABEL of 0.5.0-alpha.5 (b83a041) — so every alpha.5 statement below is
 * still true of these bytes, and every derived hash is unchanged. The blueprint directory is
 * derived from TARGET_PROTOCOL_VERSION below, so this comment is the only place the version
 * is written out.
 *
 * ⚠ alpha.5 changed ONE thing in this sequence and it is not in the list
 * below: the protocol genesis now carries a withdraw-0 from `upgrade_cred`, so
 * the stake registrations moved AHEAD of it (a reward account cannot be
 * withdrawn from in the transaction that registers it). The topology itself is
 * unchanged.
 *
 * The topology this fixture stands up, and the three things alpha.4 changed:
 *
 *  * THE ISSUANCE SPLIT. `issuance_mint` is the PERMANENT half — it is still
 *    parameterised per minting-logic hash and still owns the policy id. It now
 *    dispatches to a REPLACEABLE half, `issuance_logic`, named by the params
 *    datum's field 1 rather than baked in. Every mint AND every burn carries
 *    that withdraw-0, so `issuance_logic`'s stake credential is on the critical
 *    path of both and must be registered by the bootstrap.
 *  * THE PARAMS DATUM IS SIX FIELDS, with `issuance_logic_cred` INSERTED at
 *    index 1 and `pending_upgrade_cred` appended at index 5.
 *  * THE MULTISIG CONFIG UTxO. `upgrade_multisig` is parameterised by its own
 *    one-shot `utxo_ref` and holds its signer tree in a config UTxO rather than
 *    in its parameters — which is what makes it DERIVABLE from a recorded
 *    `DeploymentParams` and usable as the upgrade authority.
 *
 * All three now live in the export's own documentation, where the code that
 * depends on them is. What is left in this file is why the FIXTURE does what it
 * does.
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
  type UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";

import {
  // The export under test.
  planBootstrap,
  buildSeedTx,
  selectBootstrapSeeds,
  buildMultisigGenesisTx,
  assertMultisigConfigUtxo,
  buildProtocolGenesisTx,
  buildReferenceScriptsTx,
  buildStakeRegistrationTx,
  assembleDeploymentParams,
  // Fixture-side helpers.
  minUtxoAtLeast,
  outputAssets,
  paymentCredentialHash,
  rewardAddressFromKeyHash,
  stakingCredentialHash,
  type BootstrapPlan,
  type BootstrapSeedUtxos,
  type DeploymentParams,
  type MultisigScriptTree,
  type PlutusBlueprint,
  type TxInput,
  type UnsignedTx,
  type UpstreamPin,
} from "../../dist/index.js";

import { makeClient, topupAddress, retryTransient } from "./yaci.mjs";
import { createOgmiosEvaluator } from "./ogmios-evaluator.js";
import { explainError } from "./explain-error.js";
import { TARGET_PROTOCOL_VERSION } from "../../dist/standard/blueprint.js";
import type { Evaluator } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A fixed nonce so a rebuild against the same devnet yields the same hashes.
 *
 * ⛔ A FIXTURE VALUE, AND IT STAYS HERE. Reproducibility across rebuilds is what
 * a devnet fixture wants and what a production deployment usually does not; the
 * SDK takes `alwaysFailNonce` as a REQUIRED input precisely so that a value
 * chosen for this machine's convenience cannot become everyone's default.
 */
const ALWAYS_FAIL_NONCE_B = "fa5b084bbdc0336c1e3c086617d99cf6ecff1a190116784a0dd54aeca948e8fe";

/**
 * The #106-vector-3 inline-datum bound written into the delegates' parameters.
 *
 * ⛔ DEVNET FIXTURE VALUE ONLY (PLAN.md D-17). It is a SECURITY PARAMETER with
 * no upstream guidance; 1024 is what upstream's own test fixtures use and is
 * NOT a recommendation. The production value is deferred to the freeze-and-seize
 * epic. The SDK requires it rather than defaulting it for exactly this reason.
 */
const MAX_INLINE_DATUM_BYTES = 1024n;

const SEED_ADA = 5_000_000n;
/** Lovelace parked on each published reference script. */
const REF_SCRIPT_ADA = 20_000_000n;
/**
 * The floor below which the bootstrap tops up from the faucet.
 *
 *   step 4 reference outputs  7 x 20 ADA = 140
 *   step 3 protocol state      solved     ~ 20   (params, registry origin, issuance CBOR)
 *   step 2 multisig config          ~2  =   2
 *   the harness decoy               ~1  =   1
 *   three seed UTxOs         3 x 5 ADA =   15
 *                                        -----
 *                                          178  before a single fee
 *
 * 400 covers that plus fees, collateral and the change churn of seven
 * transactions, with room for the next two scripts to join step 4 without this
 * constant needing another revision.
 */
const MIN_WALLET_ADA = 400_000_000n;
/**
 * ADA, not lovelace — the admin API takes ADA.
 *
 * MEASURED: the devnet faucet rejects large requests with an opaque HTTP 500 and
 * {"status":false,"message":"Topup failed"} — it does NOT clamp to what it can
 * afford. Each genesis account holds 10,000 ADA, and 500,000 fails outright.
 */
const TOPUP_ADA = 10_000n;

/**
 * The bundled blueprint directory for the version the SDK actually TARGETS.
 *
 * ⛔ DERIVED, NEVER TYPED. This was hardcoded to `v0.5.0-alpha.2` and stayed
 * there through the whole alpha.3 migration, so every devnet bootstrap built
 * against a blueprint the SDK no longer supported while the offline suite
 * stayed green — those tests load blueprints by explicit path. A version
 * written in two places is one fact that can disagree with itself.
 */
export function standardBlueprintDir(): string {
  return resolve(ROOT, `blueprints/standard/v${TARGET_PROTOCOL_VERSION}`);
}

export function loadStandardBlueprint(): PlutusBlueprint {
  return JSON.parse(readFileSync(resolve(standardBlueprintDir(), "plutus.json"), "utf-8"));
}

/** The provenance pin shipped beside the blueprint. Read from disk; the SDK reads no files. */
function loadUpstreamPin(): UpstreamPin {
  return JSON.parse(readFileSync(resolve(standardBlueprintDir(), "UPSTREAM_PIN.json"), "utf-8"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What {@link bootstrapProtocol}'s `beforeProtocolGenesis` hook is handed.
 *
 * Everything the genesis step is about to use, and nothing else — so a caller
 * can build a VARIANT of that transaction against the very same plan, seeds and
 * config UTxO. Any difference between the two is then the variant's own.
 */
export interface BeforeProtocolGenesisContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client: any;
  readonly plan: BootstrapPlan;
  readonly evaluator: Evaluator | undefined;
  /** Bech32 change address — the fixture wallet's. */
  readonly changeAddress: string;
  /** The same UTxO reservation the genesis will use. */
  readonly availableUtxos: () => Promise<EvoUTxO.UTxO[]>;
  readonly protocolParamsSeedUtxo: EvoUTxO.UTxO;
  readonly issuanceSeedUtxo: EvoUTxO.UTxO;
  /** The config UTxO, read back off the chain and vetted. */
  readonly upgradeMultisigConfigUtxo: EvoUTxO.UTxO;
  /** The key hash this fixture's one-leaf `Signature` tree names. */
  readonly upgradeAuthoritySigner: string;
}

/**
 * Bootstrap a protocol instance on a TESTNET. Returns DeploymentParams.
 *
 * Defaults to the local Yaci devnet. Pass `client`/`evaluator` to run the same
 * sequence against another testnet — preview, say, via a Blockfrost provider.
 * Only two things were ever devnet-specific: where the client points, and the
 * evaluator.
 *
 * Refuses any non-testnet, injected client or not.
 */
export async function bootstrapProtocol(
  opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client?: any;
    evaluator?: Evaluator;
    /**
     * Positive check for "is this reward account already registered?".
     *
     * The nominee's stake credential belongs to the WALLET, so it survives
     * across deployments and a second bootstrap legitimately finds it
     * registered. That was previously tolerated by MATCHING THE ERROR TEXT,
     * which is Ogmios's vocabulary; Blockfrost returns an opaque "submitTx
     * failed" for the same condition, so the tolerance silently did not apply
     * and a redeploy failed outright. Ask the chain instead of parsing prose.
     */
    isStakeRegistered?: (stakeAddress: string) => Promise<boolean>;
    /**
     * Wait for a transaction to be visible on chain.
     *
     * ⚠ MEASURED: Evolution's own awaitTx gave up after 90s on preview while the
     * transaction had ALREADY been included — Blockfrost's confirmation view
     * lags block inclusion. The devnet's default is fine; a public provider
     * wants a poller that asks the same source the deployment will be read from
     * afterwards.
     */
    awaitTx?: (txHash: string) => Promise<void>;
    /**
     * FIXTURE HOOK — runs immediately before the protocol genesis is built,
     * with the plan and everything the genesis itself is about to use.
     *
     * ⛔ IT EXISTS FOR ONE THING: THE NEGATIVE CONTROL. alpha.5's genesis
     * carries a withdraw-0 from `upgrade_cred`, and a bootstrap that SUCCEEDS
     * cannot distinguish "the new check passed" from "the new check never ran".
     * Only submitting the same genesis WITHOUT the withdrawal, at the same
     * seeds, and watching the ledger refuse it, tells those two apart.
     *
     * ⚠ AND THE BYPASS LIVES IN THE CALLER, NOT HERE. This hook hands over the
     * materials; `test/devnet/upgrade-activation.test.ts` builds the
     * alpha.4-shaped genesis itself. Putting a "skip the activation" flag on
     * the exported builder — or on this harness — would be shipping the
     * footgun in order to test the safety catch.
     *
     * ⚠ A refused submission consumes nothing, so the seeds this runs against
     * are still unspent when the real genesis follows it.
     */
    beforeProtocolGenesis?: (ctx: BeforeProtocolGenesisContext) => Promise<void>;
  } = {}
): Promise<DeploymentParams> {
  const client = opts.client ?? (await makeClient());
  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);
  const networkId: number = client.chain.id;

  if (networkId !== 0) {
    throw new Error("bootstrapProtocol is devnet-only; refusing to run against a non-testnet");
  }

  // ---- Preflight: wait for the indexer to catch up ------------------------
  //
  // ⛔ ORCHESTRATION, AND DELIBERATELY NOT IN THE SDK. Kupo and yaci-store lag
  // the node. Immediately after another transaction — typically the previous
  // test file's — `getUtxos` still reports inputs the node already knows are
  // spent, and the resulting submission is rejected with code 3117, "unknown
  // UTxO references as inputs". That error names a UTxO and reads as a builder
  // bug. It is not: the builder faithfully used what the provider told it.
  //
  // Waiting for two consecutive IDENTICAL reads is a cheap proxy for "the
  // indexer has settled" — a single read cannot distinguish a settled view from
  // a stale one. What counts as settled is a property of the CALLER's provider,
  // which is why the SDK takes UTxOs as an argument and never polls.
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
  let utxos: EvoUTxO.UTxO[] = await client.getUtxos(addressObj);
  const totalLovelace = (all: EvoUTxO.UTxO[]) =>
    all.reduce((s: bigint, u: EvoUTxO.UTxO) => s + EvoAssets.lovelaceOf(u.assets), 0n);
  let balance = totalLovelace(utxos);
  if (balance < MIN_WALLET_ADA) {
    await topupAddress(address, TOPUP_ADA);
    for (let i = 0; i < 20 && balance < MIN_WALLET_ADA; i++) {
      await sleep(1_500);
      utxos = await client.getUtxos(addressObj);
      balance = totalLovelace(utxos);
    }
  }
  if (balance < MIN_WALLET_ADA) {
    throw new Error(`Bootstrap needs ≥${MIN_WALLET_ADA} lovelace, wallet has ${balance}`);
  }

  // An injected client brings its own evaluation; only the devnet needs the
  // custom Ogmios evaluator (it exists for the Aiken traces, which Blockfrost
  // does not return). ⛔ THE ENDPOINT LIVES HERE, NOT IN THE SDK.
  const evaluator: Evaluator | undefined =
    opts.evaluator ??
    (opts.client
      ? undefined
      : createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"));

  // ---- Submission, waiting and diagnosis — all of it the caller's ---------
  //
  // `label` names WHICH transaction failed. Without it a bootstrap failure
  // reports only "submitTx failed" across seven distinct submissions.
  const submitAndWait = async (
    built: { signAndSubmit: () => Promise<unknown> },
    label = "?",
    // ⛔ T-D20: an EXPECTED submit failure (see the nominee call site) must not
    // print as a defect in exactly the region a real one would appear. This
    // narrows what gets the loud [submit error] treatment; it changes NOTHING
    // about what is rethrown — `tolerate` only picks which line logs it.
    submitOpts?: { tolerate?: (msg: string) => boolean; tolerateNote?: string }
  ) => {
    let res: unknown;
    try {
      res = await built.signAndSubmit();
    } catch (err: unknown) {
      const msg = String((err as Error)?.message ?? err);
      if (submitOpts?.tolerate?.(msg)) {
        console.error(
          `  [expected] ${label}: ${submitOpts.tolerateNote ?? "tolerated outcome"} — ${msg.slice(0, 200)}`
        );
        throw err;
      }
      console.error(`  [submit error] ${label}:\n  | ` + explainError(err));
      throw err;
    }
    const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res as never);
    if (opts.awaitTx) await opts.awaitTx(hash);
    else await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 180_000);
    return hash;
  };

  /**
   * Submit an UnsignedTx the SDK returned.
   *
   * ⚑ THE SIZE IS A PROPERTY OF THE OBJECT IN HAND. Since the builders return
   * CBOR, `TX_SIZE_DIAG` no longer has to reach inside a private closure to
   * instrument a build — it measures what was returned.
   */
  const submitUnsigned = async (
    unsigned: UnsignedTx,
    label: string,
    submitOpts?: { tolerate?: (msg: string) => boolean; tolerateNote?: string }
  ) => {
    if (process.env.TX_SIZE_DIAG) {
      console.error(
        `  [tx size] ${label}: ${unsigned.cbor.length / 2} bytes (limit 16384)`
      );
    }
    return submitAndWait(
      unsigned._signBuilder as { signAndSubmit: () => Promise<unknown> },
      label,
      submitOpts
    );
  };

  /**
   * Wallet UTxOs that are safe to SPEND.
   *
   * ⛔ EXCLUDES ANY UTxO CARRYING A REFERENCE SCRIPT, whoever created it — not
   * merely this deployment's seven. MEASURED on preview: after three
   * deployments the wallet held 11 script-bearing UTxOs of 22, and Evolution's
   * coin selection is free to pick them. Spending one DESTROYS that
   * deployment's infrastructure AND drags the script's bytes into the
   * transaction, which is what burst the 16,384-byte cap on the publish step.
   *
   * ⛔ AND IT EXCLUDES THE SEEDS A LATER STEP STILL NEEDS — `reserve`. MEASURED
   * at b0bcf09: with the seeds left in, coin selection took one for fees during
   * the multisig genesis, and the protocol genesis then named a spent input.
   * The ledger answered code 3117, "unknown UTxO references as inputs", which
   * names a UTxO and reads as a builder bug. It is not: the builder used
   * exactly what it was told it could spend. The SDK requires `availableUtxos`
   * so a caller can say this; saying it is the caller's job.
   */
  const spendable = async (reserve: readonly TxInput[] = []) => {
    const reserved = new Set(
      reserve.map((r) => `${r.txHash.toLowerCase()}#${r.outputIndex}`)
    );
    const all: EvoUTxO.UTxO[] = await client.getUtxos(addressObj);
    return all.filter(
      (u) =>
        !(u as { scriptRef?: unknown }).scriptRef &&
        !reserved.has(
          `${EvoTransactionHash.toHex(u.transactionId).toLowerCase()}#${Number(u.index)}`
        )
    );
  };

  // =========================================================================
  // STEP 1 — fragment the wallet into three distinct seed UTxOs
  // =========================================================================
  const seedTx = await buildSeedTx({
    client,
    changeAddress: address,
    availableUtxos: await spendable(),
    evaluator,
    ownerAddress: address,
    seedLovelace: SEED_ADA,
  });
  const seedTxHash = await submitUnsigned(seedTx, "step1-seed");

  let seedUtxos: BootstrapSeedUtxos | undefined;
  let seeds: ReturnType<typeof selectBootstrapSeeds>["seeds"] | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const picked = selectBootstrapSeeds(await client.getUtxos(addressObj), seedTxHash);
      seedUtxos = picked.utxos;
      seeds = picked.seeds;
      break;
    } catch {
      await sleep(1_500);
    }
  }
  if (!seedUtxos || !seeds) {
    throw new Error(
      `Fragmentation transaction ${seedTxHash} never showed three seed UTxOs in the wallet view`
    );
  }

  // =========================================================================
  // THE PLAN — pure, offline, and the whole of this deployment's identity
  // =========================================================================
  const blueprint = loadStandardBlueprint();
  const plan: BootstrapPlan = planBootstrap({
    blueprint,
    networkId,
    seeds,
    // ⬇ The three fixture values, passed IN rather than shipped.
    alwaysFailNonce: ALWAYS_FAIL_NONCE_B,
    maxInlineDatumBytes: MAX_INLINE_DATUM_BYTES,
    // This devnet instance has unfracking ENABLED and records the real hash. A
    // deployment that wants unfracking deployed but unreachable passes
    // "disabled" instead — the two are different protocols.
    unfracking: "enabled",
  });

  /**
   * The authority tree: the bootstrapping wallet's own payment credential.
   *
   * ⛔ A FIXTURE CHOICE, AND THE SDK REFUSES TO HAVE ONE. Who controls a
   * protocol is the single most consequential decision a deployment makes, and
   * shipping a default would ship a decision about every deployment made with
   * this package.
   */
  const adminPkh = paymentCredentialHash(address);
  const upgradeMultisigTree: MultisigScriptTree = { type: "signature", keyHash: adminPkh };

  // =========================================================================
  // STEP 2 — the upgrade authority's config UTxO, BEFORE the protocol genesis
  // =========================================================================
  const multisigTx = await buildMultisigGenesisTx({
    client,
    changeAddress: address,
    // Reserve the two seeds the protocol genesis has not spent yet.
    availableUtxos: await spendable([seeds.protocolParams, seeds.issuance]),
    evaluator,
    plan,
    seedUtxo: seedUtxos.upgradeMultisig,
    upgradeMultisigTree,
  });
  await submitUnsigned(multisigTx, "step2-upgrade-multisig-genesis");

  // ---- FIXTURE ONLY: a decoy UTxO parked at the multisig address -----------
  //
  // ⛔ A FIXTURE FOR THE GATE BELOW, NOT PROTOCOL STATE — which is why it is
  // this harness's own transaction and not part of the exported genesis. A
  // production deployment should not mint a permanently unspendable junk UTxO.
  //
  // It exists so the policy-correlation clause in the config-UTxO lookup is
  // EXERCISED rather than merely claimed. MEASURED (audit r1, F-2): with only
  // ONE UTxO at this address, replacing that filter with "take anything at this
  // address" changed nothing — both the gate and the devnet test stayed green
  // while their comments asserted the filter asked the question the validator
  // asks. A lookup that has never had to discriminate has not been shown to.
  //
  // ⚑ It is also a REAL condition, not an invented one. Upstream's
  // `upgrade_multisig.spend` contemplates it explicitly: "junk UTxOs parked at
  // the address cannot interfere." Anyone may pay to a script address.
  //
  // ⚠ Safe against `upgrade_multisig.mint` either way: rail 3 uses
  // `list.expect_find` over outputs, which SKIPS a non-matching output rather
  // than rejecting it. This output carries no NFT, so `has_nft_strict` never
  // matches it — and it is now in a different transaction besides.
  //
  // ⚠ Permanently unspendable (no datum, so `expect Some(old_tree)` in the
  // spend handler fails). Deliberate, and it does not accumulate: every
  // bootstrap derives a NEW upgrade_multisig from a new seed, hence a new
  // address.
  const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;
  const decoyLovelace = minUtxoAtLeast(2_000_000n, {
    address: plan.addresses.upgradeMultisig,
    assets: outputAssets(0n),
    coinsPerUtxoByte,
  });
  let decoyTx = client.newTx();
  decoyTx = decoyTx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.upgradeMultisig),
    assets: outputAssets(decoyLovelace),
  });
  await submitAndWait(
    await decoyTx.build({
      changeAddress: addressObj,
      evaluator,
      availableUtxos: await spendable([seeds.protocolParams, seeds.issuance]),
    }),
    "fixture-multisig-decoy"
  );

  // ---- The authority is OPERABLE, not merely named ------------------------
  //
  // ⛔ AN OPERABILITY GATE, NOT DECORATION. The measured instance of "correct
  // and useless" in this repo is a deployment that named an authority credential
  // which could not be registered at all: every hash reproduced, every read-back
  // matched, every test passed, and the protocol's upgrade path was permanently
  // unsatisfiable. "It exists and is well-formed" left "and can be used"
  // untested. The decision is `assertMultisigConfigUtxo`'s — exported, pure, and
  // therefore available to the platform too; fetching is ours.
  await settleIndexer();
  const multisigAtAddress: EvoUTxO.UTxO[] = await client.getUtxos(
    EvoAddress.fromBech32(plan.addresses.upgradeMultisig)
  );
  // ⚑ PROVE THE FILTER HAS SOMETHING TO REJECT. The decoy above exists so the
  // lookup must discriminate; if it is not there, the filter is passing over a
  // population of one and the gate is back to being a claim. Fail loudly rather
  // than silently reverting to vacuity. ⛔ This assertion is the FIXTURE's, not
  // the protocol's — a real deployment's address legitimately holds one UTxO.
  if (multisigAtAddress.length < 2) {
    throw new Error(
      `upgrade_multisig address ${plan.addresses.upgradeMultisig} holds ` +
        `${multisigAtAddress.length} UTxO(s); this fixture parks a decoy beside the config UTxO ` +
        `so the policy filter in assertMultisigConfigUtxo is exercised. With fewer than 2 there ` +
        `is nothing to discriminate and the gate proves nothing.`
    );
  }
  const multisigConfig = assertMultisigConfigUtxo({
    plan,
    utxosAtAddress: multisigAtAddress,
    expectedTree: upgradeMultisigTree,
  });

  // =========================================================================
  // STEP 3 — register the six withdraw-0 stake credentials
  // =========================================================================
  //
  // ⛔ BEFORE THE GENESIS SINCE alpha.5, AND THIS IS A LEDGER RULE. The genesis
  // now carries a withdraw-0 from `upgrade_cred` = Script(upgrade_multisig),
  // and withdrawals are applied against the reward-account state BEFORE
  // certificates — so the credential cannot be registered in the transaction
  // that withdraws from it. It used to be last because nothing needed it yet.
  //
  // ⛔ T-D19, MEASURED: `registerStake`'s own `build()` raises the same
  // `Kupmios getProtocolParameters failed` transient from Evolution's
  // Stake.ts:64. Wrapped for the same reason — a stake op's build is
  // side-effect-free until submitAndWait runs.
  const regTx = await retryTransient(
    async () =>
      buildStakeRegistrationTx({
        client,
        changeAddress: address,
        availableUtxos: await spendable(),
        evaluator,
        plan,
      }),
    { label: "step3-stake-registrations build" }
  );
  await submitUnsigned(regTx, "step3-stake-registrations");

  // The withdrawal in STEP 4 reads reward-account state that this transaction
  // just wrote. Settling here is not belt-and-braces: an unregistered
  // credential is refused as Conway 3141, "rewards withdrawals must consume
  // rewards in full", which reads as a balance problem and sends the reader to
  // the wallet rather than to the certificate that had not landed yet.
  await settleIndexer();

  if (opts.beforeProtocolGenesis) {
    await opts.beforeProtocolGenesis({
      client,
      plan,
      evaluator,
      changeAddress: address,
      availableUtxos: () => spendable(),
      protocolParamsSeedUtxo: seedUtxos.protocolParams,
      issuanceSeedUtxo: seedUtxos.issuance,
      upgradeMultisigConfigUtxo: multisigConfig.utxo,
      upgradeAuthoritySigner: adminPkh,
    });
    // The hook submits a transaction the ledger is expected to REFUSE. A
    // refusal consumes nothing, but the wallet view still churns, and the
    // genesis below names specific seeds.
    await settleIndexer();
  }

  // =========================================================================
  // STEP 4 — the protocol genesis
  // =========================================================================
  //
  // ⚠ CIP-171 provenance rides this transaction because that is what was asked
  // for and because one artefact is easier to inspect. It is NOT required to
  // ride it: the registry's ingest filters on `label == 1984` alone and never
  // sees the transaction's scripts, so association happens later, by script
  // hash, at lookup time. A wrong-arity record is DISCARDED SILENTLY — verify
  // with a POSITIVE lookup by tx hash, never by the absence of an error.
  const genesisTx = await buildProtocolGenesisTx({
    client,
    changeAddress: address,
    availableUtxos: await spendable(),
    evaluator,
    plan,
    protocolParamsSeedUtxo: seedUtxos.protocolParams,
    issuanceSeedUtxo: seedUtxos.issuance,
    provenancePin: loadUpstreamPin(),
    // ⛔ THE ACTIVATION, alpha.5. The config UTxO is the one read back off the
    // chain and vetted by `assertMultisigConfigUtxo` above — not a
    // reconstruction — because `upgrade_multisig.withdraw` decides on the tree
    // it finds in the REFERENCE INPUTS.
    upgradeMultisigConfigUtxo: multisigConfig.utxo,
    // ⛔ A FIXTURE VALUE, AND THE EXPORT SHIPS NO DEFAULT FOR IT. This harness
    // configures a one-leaf `Signature` tree over its own wallet, so the
    // satisfying signer set is that one key hash. A real deployment's tree may
    // be `AnyOf`/`AtLeast`, where WHICH branch to satisfy is a decision nothing
    // can make on the caller's behalf.
    upgradeAuthoritySigners: [adminPkh],
  });
  const protocolGenesisTxHash = await submitUnsigned(genesisTx, "step4-protocol-genesis");

  // =========================================================================
  // STEP 5 — publish the reference scripts
  // =========================================================================
  const refTx = await buildReferenceScriptsTx({
    client,
    changeAddress: address,
    availableUtxos: await spendable(),
    evaluator,
    plan,
    // ⚠ The fixture's wallet, which is why `spendable` above must exclude
    // script-bearing UTxOs for the rest of this devnet's life.
    referenceScriptAddress: address,
    referenceScriptLovelace: REF_SCRIPT_ADA,
  });
  const referenceScriptsTxHash = await submitUnsigned(refTx, "step5-reference-scripts");

  // ---- FIXTURE ONLY: the wallet's own stake key, REGISTERED **AND** DELEGATED
  //
  // ⛔ NOT PART OF STANDING UP A PROTOCOL, which is why it is not one of the
  // export's five steps. Under alpha.4 this key is no longer the upgrade
  // authority — the multisig is, and its credential is registered in step 5 —
  // but T-F03-3's handover test needs it as the NOMINEE, and a nominee promotes
  // itself by presenting its OWN withdraw-0.
  //
  // ⛔ THE POSTCONDITION IS A FACT ABOUT THE DOMAIN, NOT ABOUT THE ROW:
  //    THIS CREDENTIAL MUST END THIS FUNCTION BOTH REGISTERED AND DELEGATED.
  // That is a KEY withdraw-0, and Conway rejects a withdrawal from an
  // undelegated credential with code 3150 ("credentials that do not engage in
  // on-chain governance") EVEN AT ZERO. Registration alone was never enough.
  //
  // ⚠ THE OLD GUARD SKIPPED BOTH. It asked "is it registered?" and, on yes,
  // skipped the registration AND the DRep delegation with it. A credential
  // registered by an earlier bootstrap and never delegated then reached the
  // handover undelegated, and the failure names a governance rule rather than a
  // missing certificate. So on the already-registered path we still submit the
  // delegation: re-delegating is idempotent and costs one transaction; not
  // delegating an undelegated one costs the handover.
  const upgradeStakeKeyHash = stakingCredentialHash(address);
  const upgradeStakeAddr = rewardAddressFromKeyHash(networkId, upgradeStakeKeyHash);
  // ⛔ T-D19: MEASURED, the transient this repo has actually hit fires inside
  // Evolution's OWN Stake.ts:64 — its `getProtocolParameters()`, called while
  // BUILDING a stake certificate. So the retry wraps `.build()` itself
  // (side-effect-free: nothing is submitted until submitAndWait runs).
  const delegateOnly = async () => {
    const built = await retryTransient(
      async () => {
        const delegateTx = client.newTx().delegateToDRep({
          stakeCredential: Credential.makeKeyHash(Bytes.fromHex(upgradeStakeKeyHash)),
          drep: new DRep.AlwaysAbstainDRep({}),
        });
        return delegateTx.build({
          changeAddress: addressObj,
          evaluator,
          availableUtxos: await spendable(),
        });
      },
      { label: "fixture-nominee-delegate build" }
    );
    await submitAndWait(built, "fixture-nominee-delegate");
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
    const built = await retryTransient(
      async () => {
        const keyRegTx = client.newTx().registerAndDelegateTo({
          stakeCredential: Credential.makeKeyHash(Bytes.fromHex(upgradeStakeKeyHash)),
          drep: new DRep.AlwaysAbstainDRep({}),
        });
        return keyRegTx.build({
          changeAddress: addressObj,
          evaluator,
          availableUtxos: await spendable(),
        });
      },
      { label: "fixture-nominee-register-delegate build" }
    );
    // ⛔ T-D20: on every devnet run after the first bootstrap this key is
    // ALREADY registered (it is the wallet's, and survives across bootstraps),
    // so this submission is EXPECTED to fail with Conway 3145 on every run but
    // the first. `tolerate` labels that one outcome as [expected] instead of
    // the loud [submit error] block, without changing what is rethrown.
    await submitAndWait(built, "fixture-nominee-register-delegate", {
      // ⛔ \b3145\b, NOT includes("3145"): the real message is a full Ogmios
      // JSON body carrying tx hashes, policy ids and lovelace figures, so an
      // unanchored "3145" matches a substring of an unrelated number at a
      // percent-level rate — and a false positive prints a FALSE explanation in
      // place of the full dump, which is strictly worse than the loud output.
      tolerate: (msg) => msg.includes("already known credential") || /\b3145\b/.test(msg),
      tolerateNote:
        "credential already registered on this devnet — expected, delegateOnly() runs next",
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Same predicate as `tolerate` above, and anchored for the same reason.
    const alreadyRegistered =
      msg.includes("already known credential") || /\b3145\b/.test(msg);
    if (!alreadyRegistered) throw err;
    await delegateOnly();
  }


  // The caller will immediately build against this wallet, and the indexer is
  // still catching up. Settling here rather than in every caller keeps the
  // hazard in one place — a bootstrap that hands back a DeploymentParams the
  // chain agrees with, but a wallet view it does not, is a trap for every test
  // that follows.
  await settleIndexer();

  return assembleDeploymentParams(plan, {
    protocolGenesisTxHash,
    referenceScriptsTxHash,
    // ⚠ Read back off the chain above, never assumed from step 2's outputs: it
    // is mutable state, and a signer rotation spends and recreates it.
    multisigConfigUtxo: multisigConfig.ref,
  });
}
