/**
 * Freeze-and-Seize substandard.
 *
 * Uses Evolution SDK directly — no adapter abstraction.
 *
 * Capabilities: register, mint, burn, transfer, freeze, unfreeze, seize.
 */

import { CIP171_METADATA_LABEL, buildCip171Metadatum } from "../../core/cip171.js";
import {
  Address as EvoAddress,
  Assets,
  Data,
  Transaction,
  TransactionHash as EvoTransactionHash,
  TransactionInput as EvoTransactionInput,
} from "@evolution-sdk/evolution";

import type { UTxO as EvoUTxO } from "@evolution-sdk/evolution";

import type { PlutusBlueprint, PlutusScript, DeploymentParams, HexString } from "../../types.js";
import type { ParameterizationEvent } from "../../standard/scripts.js";
import type {
  SubstandardPlugin,
  SubstandardContext,
  EvoClient,
  RegisterParams,
  MintParams,
  BurnParams,
  TransferParams,
  FreezeParams,
  UnfreezeParams,
  SeizeParams,
  InitComplianceParams,
  UnsignedTx,
} from "../interface.js";
import {
  sortTxInputs,
  findRefInputIndex,
  findRegistryNode,
  findCoveringNode,
  utxoToTxInput,
} from "../../core/registry.js";
import {
  buildEvoScript,
  scriptAddress,
  rewardAddress,
  baseAddress,
  stakingCredentialHash,
  paymentCredentialHash,
  stringToHex,
  MAX_NEXT,
  voidData,
  registryNodeDatum,
  decodeRegistryNode,
  blacklistNodeDatum,
  registryInsertRedeemer,
  blacklistInitRedeemer,
  blacklistAddRedeemer,
  blacklistRemoveRedeemer,
  extractConstrBytesField,
  extractCredentialField,
  getInlineDatum,
  utxoHasUnit,
  utxoUnitQty,
  utxoLovelace,
  utxoTxHash,
  utxoOutputIndex,
  outputAssets,
  mintAssetsFromMap,
  REGISTRY_NODE_MIN_ADA,
  Credential,
  KeyHash,
  InlineDatum,
  labeledAssetName,
  hasCIP67Label,
  buildCIP68FTDatum,
  minUtxoAtLeast,
  ceilToWholeAda,
  minUtxoForOutput,
} from "../../core/evo-utils.js";
import {
  baseSpendRedeemer,
  transferRedeemer,
  thirdPartyRedeemer,
  withdrawalIndexOf,
  plbWithdrawalPlan,
  issuancePlan,
  programmableLogicGlobalRedeemer,
  type WithdrawalKey,
} from "../../core/ledger-order.js";
/**
 * The flat amounts this plugin used to hardcode, kept as FLOORS rather than as
 * answers — see `minUtxoAtLeast`. Every output that carries caller-controlled
 * bytes now computes its requirement from live protocol parameters and takes
 * the larger of the two, so ordinary inputs emit exactly what they always did
 * and only the cases that were genuinely short move.
 *
 * MEASURED 2026-09-01 against preview (`coinsPerUtxoByte` 4310), which is how
 * we know these were not merely theoretical:
 *   - the (100) reference output needed 3,021,310 with every CIP-68 field at a
 *     consumer's own documented caps and a 12-byte asset name — the flat
 *     3,000,000 was SHORT by 21,310. With a maximal 32-byte CIP-67 name the
 *     same datum needs 3,111,820. Both axes are caller-controlled and this
 *     package caps NEITHER, so the true ceiling is unbounded.
 *   - a token output with a 32-byte CIP-67 asset name needed 1,318,860 — the
 *     flat 1,300,000 was SHORT by 18,860, rising to 44,720 at a maximal
 *     quantity.
 */
const TOKEN_OUTPUT_FLOOR = 1_300_000n;
const CIP68_REFERENCE_OUTPUT_FLOOR = 3_000_000n;

import { createFESScripts } from "./scripts.js";
import type { FESDeploymentParams } from "./types.js";

// Stake registration check is provided via ctx.checkStakeRegistration callback.
// No direct HTTP calls from the SDK — the caller provides the implementation.

// ---------------------------------------------------------------------------
// Resolved scripts — computed once at init, reused for all operations
// ---------------------------------------------------------------------------

interface ResolvedFESScripts {
  issuerAdmin: PlutusScript;
  transfer: PlutusScript;
  blacklistMint: PlutusScript;
  blacklistSpend: PlutusScript;
  issuanceMint: PlutusScript;
  tokenPolicyId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the transaction and extract unsigned CBOR + txHash.
 * Works with both ReadOnlyClient (TransactionResultBase) and SigningClient (SignBuilder).
 */
/**
 * The evaluator this plugin builds with, set by `init()`.
 *
 * Module-scoped rather than threaded through nine call sites. Without it every
 * script failure in this substandard surfaces as Kupmios's bare
 * "evaluateTx failed", naming neither the failing validator nor the reason —
 * which is the difference between a diagnosis and a guess, and it cost a cycle
 * here exactly as it did in `dummy` before the same fix.
 *
 * ⚠ Shared across instances of this plugin in one process. Acceptable because
 * it only affects DIAGNOSTICS, never the transaction built; if that ever stops
 * being true, thread it through instead.
 */
let sharedEvaluator: unknown | undefined;

async function buildAndSerialize(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  changeAddress: string,
  availableUtxos?: EvoUTxO.UTxO[],
  passAdditionalUtxos = false,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ cbor: string; txHash: string; chainAvailable?: EvoUTxO.UTxO[]; _signBuilder?: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildOpts: any = {
    changeAddress: EvoAddress.fromBech32(changeAddress),
  };
  if (sharedEvaluator) {
    buildOpts.evaluator = sharedEvaluator;
  }
  if (availableUtxos) {
    buildOpts.availableUtxos = availableUtxos;
  }
  if (passAdditionalUtxos) {
    buildOpts.passAdditionalUtxos = true;
  }
  const result = await builder.build(buildOpts);

  const tx = await result.toTransaction();
  const cbor = Transaction.toCBORHex(tx);

  // Extract txHash and chainResult — SignBuilder has chainResult
  let txHash = "";
  let chainAvailable: EvoUTxO.UTxO[] | undefined;
  if (typeof result.chainResult === "function") {
    const cr = result.chainResult();
    txHash = cr.txHash;
    chainAvailable = cr.available as EvoUTxO.UTxO[];
  }

  return { cbor, txHash, chainAvailable, _signBuilder: result };
}

/**
 * Wallet UTxOs that are SAFE TO SPEND.
 *
 * A deployment's reference scripts live in outputs somewhere on chain, and if
 * that somewhere is the operator's own wallet — which is exactly what the
 * devnet harness does — then `getUtxos(wallet)` hands them back alongside
 * ordinary funds. Spending one DESTROYS protocol infrastructure: the
 * `script_ref` is not carried into the change output, so the reference input
 * every later operation depends on simply ceases to exist.
 *
 * MEASURED, not theorised: `seize` consumed the deployment's `third_party`
 * reference-script UTxO this way, which is why it appeared to work at all —
 * a spent input's reference script counts as supplied (CIP-33) — and why the
 * next run failed with 3011.
 */
function spendableWalletUtxos(
  walletUtxos: EvoUTxO.UTxO[],
  deployment: DeploymentParams
): EvoUTxO.UTxO[] {
  const reservedRefs = [
      deployment.programmableBaseRefInput,
      // alpha.3: the dispatcher's reference script joined the set the bootstrap
      // publishes. Naming it here keeps the explicit list complete — the general
      // scriptRef rule below already covers it, but a named list that silently
      // omits a live deployment's script invites the next reader to trust it.
      // alpha.4 adds issuance_logic and upgrade_multisig; the newest member is
      // exactly the one least likely to be covered anywhere else.
      deployment.programmableLogicGlobalRefInput,
      deployment.transferRefInput,
      deployment.thirdPartyRefInput,
      deployment.unfrackingRefInput,
      deployment.issuanceLogicRefInput,
      deployment.upgradeMultisigRefInput,
    ].filter(Boolean);
  if (reservedRefs.length !== 7) {
    throw new Error(
      `spendableWalletUtxos: the named deployment reference-script reservation list must ` +
        `contain exactly 7 entries; got ${reservedRefs.length}. A membership-only list ` +
        `decays into a stale subset and silently stops protecting its newest member.`
    );
  }
  const reserved = new Set(
    reservedRefs.map((r) => `${r.txHash}#${r.outputIndex}`)
  );
  return walletUtxos.filter((u) => {
    // ⛔ ANY UTxO CARRYING A REFERENCE SCRIPT IS OFF LIMITS, not merely the four
    // this deployment names.
    //
    // MEASURED, THE EXPENSIVE WAY: the named-four filter was not enough. A
    // long-lived wallet accumulates reference scripts from EVERY deployment it
    // has ever made, and coin selection is free to spend any of them. On
    // preview it consumed two of the LIVE deployment's own four during a
    // failed retry — the deployment two VERIFIED CIP-171 records describe —
    // because those four were reached through a path that did not consult this
    // filter at all.
    //
    // Spending one destroys protocol infrastructure silently: the script_ref is
    // not carried into the change output, nothing errors, and the damage
    // surfaces only when a later operation needs the script. On mainnet this is
    // spending live reference scripts that running contracts depend on, and it
    // would look like a successful transaction.
    //
    // The safe rule needs no knowledge of WHOSE deployment a script belongs to:
    // if a wallet UTxO carries a reference script, it is infrastructure, not
    // funds.
    if ((u as { scriptRef?: unknown }).scriptRef) return false;
    const i = utxoToTxInput(u);
    return !reserved.has(`${i.txHash}#${i.outputIndex}`);
  });
}

function selectUtxosForAmount(
  utxos: EvoUTxO.UTxO[],
  unit: string,
  requiredAmount: bigint
): { selected: EvoUTxO.UTxO[]; totalTokenAmount: bigint } {
  const selected: EvoUTxO.UTxO[] = [];
  let total = 0n;

  for (const utxo of utxos) {
    const amount = utxoUnitQty(utxo, unit);
    if (amount <= 0n) continue;
    selected.push(utxo);
    total += amount;
    if (total >= requiredAmount) break;
  }

  if (total < requiredAmount) {
    throw new Error(`Insufficient token balance: have ${total}, need ${requiredAmount}`);
  }

  return { selected, totalTokenAmount: total };
}

/** Find protocol params UTxO by searching for the protocol params NFT */
async function findProtocolParamsUtxo(
  client: EvoClient,
  networkId: number,
  deployment: DeploymentParams
): Promise<EvoUTxO.UTxO> {
  const ppUnit = deployment.protocolParams.policyId + stringToHex("ProtocolParams");
  const addr = EvoAddress.fromBech32(
    // alpha.3: protocol_params is one validator whose hash is BOTH the NFT
    // policy and the address holding it — the minting policy naming itself.
    scriptAddress(networkId, deployment.protocolParams.policyId)
  );
  const utxos = await client.getUtxosWithUnit(addr, ppUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Protocol params UTxO not found (unit: ${ppUnit})`);
}

/** Find issuance CBOR hex UTxO */
async function findIssuanceCborHexUtxo(
  client: EvoClient,
  networkId: number,
  deployment: DeploymentParams
): Promise<EvoUTxO.UTxO> {
  const icUnit = deployment.issuance.policyId + stringToHex("IssuanceCborHex");
  const addr = EvoAddress.fromBech32(
    scriptAddress(networkId, deployment.issuance.alwaysFailScriptHash)
  );
  const utxos = await client.getUtxosWithUnit(addr, icUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Issuance CBOR hex UTxO not found (unit: ${icUnit})`);
}

/**
 * The `issuance_logic` reference-script UTxO.
 *
 * Its withdraw-0 rides on every mint and burn, making this the most
 * load-bearing reference-script output in the deployment. Attaching the body
 * here would hide a spent deployment output instead of naming the breakage.
 */
async function findIssuanceLogicRefUtxo(
  client: EvoClient,
  deployment: DeploymentParams
): Promise<EvoUTxO.UTxO> {
  const { txHash, outputIndex } = deployment.issuanceLogicRefInput;
  const utxos = await client.getUtxosByOutRef([
    new EvoTransactionInput.TransactionInput({
      transactionId: EvoTransactionHash.fromHex(txHash),
      index: BigInt(outputIndex),
    }),
  ]);
  if (utxos.length === 0) {
    throw new Error(
      `issuance_logic reference script not found on-chain at ${txHash}#${outputIndex}. ` +
        `Deployment reference scripts are load-bearing: if an earlier transaction SPENT this ` +
        `output, the deployment is broken and must be re-published.`
    );
  }
  return utxos[0]!;
}

/** Find the NFT unit in a covering node's value that belongs to a given policy */
function findCoveringNodeNftUnit(utxo: EvoUTxO.UTxO, policyId: string): string | undefined {
  const units = Assets.getUnits(utxo.assets);
  for (const unit of units) {
    if (unit === "lovelace" || unit === "") continue;
    if (unit.startsWith(policyId)) return unit;
  }
  return undefined;
}

/**
 * Find a blacklist node proving non-membership for a given staking credential.
 * Non-membership: node.key < stakingHash < node.next
 */
function findBlacklistCoveringNode(
  blacklistUtxos: EvoUTxO.UTxO[],
  stakingHash: string
): EvoUTxO.UTxO | undefined {
  return blacklistUtxos.find((utxo) => {
    const datum = getInlineDatum(utxo);
    if (!datum) return false;
    const key = extractConstrBytesField(datum, 0) ?? "";
    const next = extractConstrBytesField(datum, 1) ?? MAX_NEXT;
    return key < stakingHash && stakingHash < next;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function freezeAndSeizeSubstandard(config: {
  blueprint: PlutusBlueprint;
  deployment: FESDeploymentParams;
  /**
   * Observe every parameterisation this substandard performs.
   *
   * Required to build a CIP-171 record for a registration: the register path
   * parameterises SEVERAL scripts, and without this the caller can only see the
   * ones it happens to derive itself.
   *
   * ⛔ A PARTIAL MANIFEST IS THE DANGEROUS CASE, NOT AN OBVIOUS ONE. A record
   * built from a subset encodes cleanly, publishes, and VERIFIES — while the
   * scripts it omits have had their parameters silently never stated. There is
   * no error anywhere: the registry reports the omitted ones PARTIAL with a
   * null final hash inside a record whose status is VERIFIED.
   *
   * ⇒ Derive the record from this, never from a hand-written list. A second
   * list agrees with the deployment right up until it does not, and the
   * disagreement surfaces only as a hash that verifies to nothing.
   *
   * ⚠ FIRES ONCE PER PARAMETERISATION, NOT ONCE PER DISTINCT SCRIPT, and this
   * plugin parameterises inside `init`. So initialising twice — a re-render, or
   * `CIP113.init` alongside a direct `init` on this plugin — appends a SECOND
   * full set: 8 events, still 4 distinct scripts.
   *
   * ⇒ DEDUPE BY `rawScriptHash` BEFORE COUNTING. A guard that pins the expected
   * number against the raw event count refuses a perfectly correct record on
   * the second init, and the failure looks like a coverage bug rather than a
   * lifecycle one.
   *
   * The raw stream is deliberately not deduped here: it carries application
   * ORDER, which the record depends on and a deduped set would lose.
   */
  onParameterize?: (event: ParameterizationEvent) => void;
}): SubstandardPlugin {
  let ctx: SubstandardContext;
  let scripts: ResolvedFESScripts;
  let networkId: number;

  return {
    id: "freeze-and-seize",
    version: "0.1.0",
    blueprint: config.blueprint,

    init(context) {
      // ---------------------------------------------------------------------
      // MIGRATION STATE (W-E). Read this before assuming an operation works.
      // ---------------------------------------------------------------------
      //
      // The blanket refusal that D-14 installed is GONE: `register`, `mint`,
      // Every operation is migrated to CIP-113 0.5.0-alpha.3.
      //
      // `seize` and `burn` take the THIRD-PARTY route: the standalone
      // `third_party` validator's withdraw-0 with a ThirdPartyRedeemer, reached
      // through the `programmable_logic_global` dispatcher, plus a
      // BaseSpendRedeemer on every programmable input.
      //
      // ⚠ In alpha.2 the dispatch choice lived on that BaseSpendRedeemer as
      // `SpendViaThirdParty`. alpha.3 made the redeemer a single-constructor
      // record and moved the choice to the dispatcher's own redeemer. The two
      // encodings are BYTE-IDENTICAL for the transfer arm, so a stale builder
      // is not rejected — see the guards in core/ledger-order.ts.
      //
      // ⚠ The seize/burn paths still need re-validating against upstream #79
      // (UTxO contamination), #80 (issuance delegation scope) and #115 (datum
      // hashes and reference scripts banned on programmable outputs). Those are
      // SEMANTIC changes with no signature to catch them, so a green devnet run
      // is necessary and not sufficient.
      ctx = context;
      sharedEvaluator = ctx.evaluator;
      networkId = ctx.client.chain.id;
      const { adminPkh, assetName, blacklistNodePolicyId, blacklistInitTxInput } = config.deployment;
      const fes = createFESScripts(config.blueprint, config.onParameterize);
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;

      const issuerAdmin = fes.buildIssuerAdmin(adminPkh, assetName);
      const transfer = fes.buildTransfer(plbHash, blacklistNodePolicyId);
      const blacklistMint = fes.buildBlacklistMint(blacklistInitTxInput, adminPkh);
      const blacklistSpend = fes.buildBlacklistSpend(blacklistNodePolicyId);
      const issuanceMint = ctx.standardScripts.buildIssuanceMint(issuerAdmin.hash);

      scripts = {
        issuerAdmin,
        transfer,
        blacklistMint,
        blacklistSpend,
        issuanceMint,
        tokenPolicyId: issuanceMint.hash,
      };
    },

    // ====================================================================
    // REGISTER — first mint + registry insert
    // ====================================================================
    async register(params: RegisterParams): Promise<UnsignedTx> {
      const { feePayerAddress, assetName, quantity, recipientAddress } = params;
      const recipient = recipientAddress || feePayerAddress;
      const chainedUtxos = (params.chainedUtxos ?? []) as EvoUTxO.UTxO[];
      // Already hex: `assetName` is raw asset-name HEX at every API boundary in
      // this SDK. This previously ran stringToHex over it, double-encoding any
      // caller who followed the convention — and silently producing a DIFFERENT
      // token, under a policy derived from a different issuer_admin, so nothing
      // failed; the tokens simply were not where anyone looked for them.
      const assetNameHex = assetName;
      const hasCIP68 = !!params.cip68Metadata;
      const client = ctx.client;

      // When CIP-68 is enabled, prefix asset names with CIP-67 labels
      const userAssetNameHex = hasCIP68 ? labeledAssetName(333, assetNameHex) : assetNameHex;
      const unit = scripts.tokenPolicyId + userAssetNameHex;

      // Reference token (only when CIP-68)
      const refAssetNameHex = hasCIP68 ? labeledAssetName(100, assetNameHex) : null;
      const refUnit = refAssetNameHex ? scripts.tokenPolicyId + refAssetNameHex : null;

      // 1. Find covering registry node
      // ⚑ ONE HASH, TWO ROLES. registry_mint and registry_spend merged (#117), so
      // the node NFT policy id and the node address's payment credential are the
      // same value — the minting policy naming itself. The old names
      // (registrySpendAddr / registryMintPolicyId) asserted a distinction that no
      // longer exists and would tell a reader to look for two hashes.
      const registryAddr = scriptAddress(networkId, ctx.standardScripts.registry.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registryAddr));
      const coveringNodeUtxo = findCoveringNode(registryUtxos, scripts.tokenPolicyId);
      if (!coveringNodeUtxo) throw new Error("Could not find covering registry node for insertion");

      const coveringDatum = getInlineDatum(coveringNodeUtxo);
      const coveringKey = extractConstrBytesField(coveringDatum, 0) ?? "";
      const coveringNext = extractConstrBytesField(coveringDatum, 1) ?? MAX_NEXT;

      // 2. Get reference inputs
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);
      const issuanceCborHexUtxo = await findIssuanceCborHexUtxo(client, networkId, ctx.deployment);
      const issuanceLogicRefUtxo = await findIssuanceLogicRefUtxo(client, ctx.deployment);
      // One array supplies both the plan's index arithmetic and the transaction.
      // Constructing either set twice would let two valid integer indices drift.
      const refUtxos = [protocolParamsUtxo, issuanceCborHexUtxo, issuanceLogicRefUtxo];

      // 3. Build datums
      // The index-based reads that used to be here (2/3/4) were silently wrong
      // when RegistryNode grew. Replaced with decodeRegistryNode, which is
      // positional-safe and fails loudly on a short record.
      //
      // ⚑ RegistryNode is STILL SEVEN FIELDS in alpha.3 — it is the PARAMS datum
      // that went 7 -> 4, not this one. Two adjacent records, one changed and one
      // did not, is exactly the pairing that invites a "consistency" edit; the
      // decoder's arity check is what stops it.
      if (!coveringDatum) {
        throw new Error(
          "register: the covering registry node has no inline datum. The directory " +
            "cannot be traversed without it — a node with no datum is malformed, not empty."
        );
      }
      const covering = decodeRegistryNode(coveringDatum);

      const updatedCoveringDatum = registryNodeDatum({
        ...covering,
        key: coveringKey,
        next: scripts.tokenPolicyId,
      });

      const newRegistryNodeDatum = registryNodeDatum({
        key: scripts.tokenPolicyId,
        next: coveringNext,
        mintingLogicScript: { type: "script", hash: scripts.issuerAdmin.hash },
        transferLogicScript: { type: "script", hash: scripts.transfer.hash },
        thirdPartyTransferLogicScript: { type: "script", hash: scripts.issuerAdmin.hash },
        // ⚠ UNASSIGNED, NOT DECIDED. Upstream added an unfracking delegate per
        // registry node; freeze-and-seize has no unfracking concept and the
        // choice belongs to its own epic. Pointing it at issuerAdmin keeps the
        // shape valid; it is NOT a design decision and is never emitted, because
        // init() throws before any of this runs.
        unfrackingLogicScript: { type: "script", hash: scripts.issuerAdmin.hash },
        globalStateCs: "",
      });

      // The former branch-dependent registry-output literal is gone. The index
      // now derives from the declared output set, so adding an output shifts it
      // automatically instead of requiring a second edit in step. Its CIP-68
      // branch has never executed on chain: no test has passed
      // `cip68Metadata` yet; T-F04-4 owns that first execution.
      const outputTags = [
        "user-token",
        ...(hasCIP68 ? ["cip68-reference"] : []),
        "covering-node",
        "new-node",
      ];
      // No plgHash: register spends a registry node and wallet funds, never a
      // programmable_logic_base input.
      const plan = issuancePlan({
        issuanceLogicHash: ctx.deployment.issuanceLogic.scriptHash,
        otherWithdrawals: [{ hash: scripts.issuerAdmin.hash, isScript: true }],
        referenceInputs: refUtxos.map(utxoToTxInput),
        paramsRefInput: utxoToTxInput(protocolParamsUtxo),
        outputs: outputTags,
        issued: [
          {
            policyId: scripts.tokenPolicyId,
            proof: { kind: "output", tag: "new-node" },
          },
        ],
      });
      const registryMintRedeemer = registryInsertRedeemer(scripts.issuanceMint.hash, { type: "script", hash: scripts.issuerAdmin.hash });
      const tokenDatum = voidData();

      // 5. Determine if chaining from initCompliance
      const useChaining = chainedUtxos.length > 0;

      // 6. Build addresses
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipient);
      const registryPolicyId = ctx.standardScripts.registry.hash;

      // 7. Build asset maps — include CIP-68 ref token in the same mint (same policy + redeemer)
      const mintEntries = new Map<string, bigint>([[unit, quantity]]);
      if (hasCIP68 && refUnit) {
        mintEntries.set(refUnit, 1n);
      }
      const tokenAssets = mintAssetsFromMap(mintEntries);
      const registryNftUnit = registryPolicyId + scripts.tokenPolicyId;
      const registryNftAssets = mintAssetsFromMap(new Map([[registryNftUnit, 1n]]));
      const coveringNftUnit = findCoveringNodeNftUnit(coveringNodeUtxo, registryPolicyId);

      // 8. Build transaction
      let tx = client.newTx();
      // CIP-171 provenance, carried by the transaction that parameterises the
      // scripts it describes. Optional: absent, this behaves exactly as before.
      if (params.cip171Record) {
        tx = tx.attachMetadata({
          label: CIP171_METADATA_LABEL,
          metadata: buildCip171Metadatum(params.cip171Record),
        });
      }


      tx = tx.collectFrom({ inputs: [coveringNodeUtxo], redeemer: voidData() });

      const withdrawalSpecs = [
        { hash: scripts.issuerAdmin.hash, redeemer: voidData() },
        {
          hash: ctx.deployment.issuanceLogic.scriptHash,
          redeemer: plan.issuanceLogicRedeemer,
        },
      ];
      if (withdrawalSpecs.length !== plan.withdrawals.length) {
        throw new Error(
          `register: issuance plan declares ${plan.withdrawals.length} withdrawals but ` +
            `${withdrawalSpecs.length} are emitted`
        );
      }
      for (const withdrawal of withdrawalSpecs) {
        tx = tx.withdraw({
          stakeCredential: Credential.makeScriptHash(
            new Uint8Array(Buffer.from(withdrawal.hash, "hex"))
          ),
          amount: 0n,
          redeemer: withdrawal.redeemer,
        });
      }

      tx = tx.mintAssets({ assets: tokenAssets, redeemer: plan.issuanceRedeemer });
      tx = tx.mintAssets({ assets: registryNftAssets, redeemer: registryMintRedeemer });

      // min-UTxO is sized from live protocol parameters, not guessed: `unit`
      // carries a caller-supplied asset name and `quantity` a caller-supplied
      // magnitude, and both widen the serialised output.
      const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;

      // outputTags: "user-token" — minted supply at the recipient's PLB.
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(
          minUtxoAtLeast(TOKEN_OUTPUT_FLOOR, {
            address: recipientPlbAddr,
            assets: outputAssets(0n, new Map([[unit, quantity]])),
            datum: tokenDatum,
            coinsPerUtxoByte,
          }),
          new Map([[unit, quantity]]),
        ),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });

      // outputTags: "cip68-reference" — optional reference token and metadata.
      if (hasCIP68 && refUnit) {
        const issuerPlbAddr = baseAddress(networkId, plbHash, feePayerAddress);
        const cip68Datum = buildCIP68FTDatum(params.cip68Metadata!);
        // ⛔ THE ONE OUTPUT SIZED BY USER-SUPPLIED STRINGS. Rounded UP TO A
        // WHOLE ADA deliberately: the reference implementation this SDK is
        // diffed against does the same, and a builder-equivalence check is only
        // useful while both sides agree. The cost is at most ~1 ADA, once, on an
        // output that exists for the life of the token.
        tx = tx.payToAddress({
          address: EvoAddress.fromBech32(issuerPlbAddr),
          assets: outputAssets(
            ceilToWholeAda(
              minUtxoAtLeast(CIP68_REFERENCE_OUTPUT_FLOOR, {
                address: issuerPlbAddr,
                assets: outputAssets(0n, new Map([[refUnit, 1n]])),
                datum: cip68Datum,
                coinsPerUtxoByte,
              }),
            ),
            new Map([[refUnit, 1n]]),
          ),
          datum: new InlineDatum.InlineDatum({ data: cip68Datum }),
        });
      }

      // outputTags: "covering-node" — predecessor with its updated link.
      const coveringNodeTokenMap = new Map<string, bigint>();
      if (coveringNftUnit) coveringNodeTokenMap.set(coveringNftUnit, 1n);
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registryAddr),
        assets: outputAssets(utxoLovelace(coveringNodeUtxo), coveringNodeTokenMap),
        datum: new InlineDatum.InlineDatum({ data: updatedCoveringDatum }),
      });

      // outputTags: "new-node" — the node named by the issuance proof.
      //
      // 3 ADA, not 2: the RegistryNode datum is SEVEN fields in 0.5.x and
      // min-UTxO scales with serialised output size. MEASURED at 2,038,630 for
      // a node of this shape — the inherited 2,000,000 was sized for the
      // five-field datum, and the ledger reports the shortfall as
      // "insufficient Ada" with a number, never as "your datum grew".
      // (The covering-node output above needs no change: it carries the
      // covering UTxO's OWN lovelace forward, so it inherits whatever the
      // bootstrap funded the origin with.)
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registryAddr),
        assets: outputAssets(REGISTRY_NODE_MIN_ADA, new Map([[registryNftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: newRegistryNodeDatum }),
      });

      // Reference inputs
      // ⛔ THE PROTOCOL-PARAMS REFERENCE INPUT STAYS — and as of S-11 that is a
      // MEASURED decision, not a cautious one.
      //
      // alpha.3's registry no longer reads it (#117). `issuance_mint` does, to
      // pull the LIVE delegate credentials from its datum, and that locate is
      // DELIBERATELY NON-FAILING: absent params UTxO means "no delegation",
      // falling back to local `no_escape` custody. So removing it raises no
      // error — it silently selects a different custody path.
      //
      // MEASURED ON DEVNET (S-11): removing it from BOTH substandards' register
      // paths, the full lifecycle still passes — dummy 2/2, FES 3/3. The two
      // custody branches do converge here, as the reasoning predicted.
      //
      // ⇒ AND IT STAYS ANYWAY, for a reason the measurement itself supplies:
      // the tests pass EITHER WAY. That is precisely what makes dropping it
      // unsafe to keep. Nothing in this suite would notice if `issuance_mint`'s
      // delegation semantics changed and the absent input started to matter —
      // the guard against that is the input being there, not a test. The saving
      // is one reference input on a once-per-token transaction; the exposure is
      // a silent custody change nobody would see.
      // alpha.4 makes the params reference input mandatory rather than an
      // optional custody hint: with_protocol_params_fields uses expect_at.
      tx = tx.readFrom({ referenceInputs: refUtxos });

      // Attach scripts
      // ⚑ ONE attach, not two. registry_mint and registry_spend merged into a
      // single validator (#117): this transaction both MINTS a node NFT and
      // SPENDS the covering node, which in alpha.2 needed two scripts. It is
      // now one script serving both purposes — attaching it twice would put a
      // duplicate witness in the transaction.
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.registry.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuerAdmin.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuanceMint.compiledCode) });

      // Required signer
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(config.deployment.adminPkh) });

      const built = await buildAndSerialize(
        tx, feePayerAddress,
        useChaining ? chainedUtxos : undefined,
        useChaining,
      );
      return {
        cbor: built.cbor,
        txHash: built.txHash,
        _signBuilder: built._signBuilder,
        tokenPolicyId: scripts.tokenPolicyId,
        metadata: {
          issuerAdminScriptHash: scripts.issuerAdmin.hash,
          transferScriptHash: scripts.transfer.hash,
          outputIndices: {
            OUT_NEW_NODE: plan.outputIndexOf("new-node"),
          },
          ...(hasCIP68 && {
            cip68Enabled: true,
            userAssetNameHex,
            refAssetNameHex,
          }),
        },
      };
    },

    // ====================================================================
    // MINT — subsequent mint with RefInput proof
    // ====================================================================
    async mint(params: MintParams): Promise<UnsignedTx> {
      const { feePayerAddress, tokenPolicyId, assetName, quantity, recipientAddress } = params;
      const recipient = recipientAddress || feePayerAddress;
      const unit = tokenPolicyId + assetName;
      const client = ctx.client;

      if (tokenPolicyId !== scripts.tokenPolicyId) {
        throw new Error(`Token policy ${tokenPolicyId} does not match this FES instance (${scripts.tokenPolicyId})`);
      }

      // 1. Find registry node as RefInput proof
      const registryAddr = scriptAddress(networkId, ctx.standardScripts.registry.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registryAddr));
      const registryUtxo = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!registryUtxo) throw new Error(`Registry node not found for ${tokenPolicyId}`);

      // 2. Find the two alpha.4 protocol reference inputs. The params input is
      // NEW here: with_protocol_params_fields begins with a hard expect_at,
      // and S-7's open mint-vs-burn inconsistency is answered at this site.
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);
      const issuanceLogicRefUtxo = await findIssuanceLogicRefUtxo(client, ctx.deployment);
      const refUtxos = [protocolParamsUtxo, registryUtxo, issuanceLogicRefUtxo];
      const plan = issuancePlan({
        issuanceLogicHash: ctx.deployment.issuanceLogic.scriptHash,
        otherWithdrawals: [{ hash: scripts.issuerAdmin.hash, isScript: true }],
        referenceInputs: refUtxos.map(utxoToTxInput),
        paramsRefInput: utxoToTxInput(protocolParamsUtxo),
        issued: [
          {
            policyId: tokenPolicyId,
            proof: { kind: "reference-input", input: utxoToTxInput(registryUtxo) },
          },
        ],
      });

      // 3. Build redeemers
      const tokenDatum = voidData();

      // 4. Build PLB address
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipient);

      // 5. Get wallet UTxOs
      const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));

      // 6. Build transaction
      const tokenAssets = mintAssetsFromMap(new Map([[unit, quantity]]));

      let tx = client.newTx();
      const spendableUtxos = spendableWalletUtxos(walletUtxos, ctx.deployment);
      tx = tx.collectFrom({ inputs: spendableUtxos.slice(0, 2) });
      const withdrawalSpecs = [
        { hash: scripts.issuerAdmin.hash, redeemer: voidData() },
        {
          hash: ctx.deployment.issuanceLogic.scriptHash,
          redeemer: plan.issuanceLogicRedeemer,
        },
      ];
      if (withdrawalSpecs.length !== plan.withdrawals.length) {
        throw new Error(
          `mint: issuance plan declares ${plan.withdrawals.length} withdrawals but ` +
            `${withdrawalSpecs.length} are emitted`
        );
      }
      for (const withdrawal of withdrawalSpecs) {
        tx = tx.withdraw({
          stakeCredential: Credential.makeScriptHash(
            new Uint8Array(Buffer.from(withdrawal.hash, "hex"))
          ),
          amount: 0n,
          redeemer: withdrawal.redeemer,
        });
      }
      tx = tx.mintAssets({ assets: tokenAssets, redeemer: plan.issuanceRedeemer });
      const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(
          minUtxoAtLeast(TOKEN_OUTPUT_FLOOR, {
            address: recipientPlbAddr,
            assets: outputAssets(0n, new Map([[unit, quantity]])),
            datum: tokenDatum,
            coinsPerUtxoByte,
          }),
          new Map([[unit, quantity]]),
        ),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });
      tx = tx.readFrom({ referenceInputs: refUtxos });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuerAdmin.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuanceMint.compiledCode) });
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(config.deployment.adminPkh) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, feePayerAddress, spendableUtxos);
      return { cbor, txHash, tokenPolicyId, _signBuilder };
    },

    // ====================================================================
    // BURN
    // ====================================================================
    async burn(params: BurnParams): Promise<UnsignedTx> {

      const { feePayerAddress, tokenPolicyId, assetName, utxoTxHash: targetTxHash, utxoOutputIndex: targetIdx } = params;
      const holder = params.holderAddress || feePayerAddress;
      const unit = tokenPolicyId + assetName;
      const client = ctx.client;

      if (tokenPolicyId !== scripts.tokenPolicyId) {
        throw new Error(`Token policy ${tokenPolicyId} does not match this FES instance`);
      }

      // 1. Find UTxO to burn at the holder's PLB address
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const holderPlbAddr = baseAddress(networkId, plbHash, holder);
      const allUtxos = await client.getUtxos(EvoAddress.fromBech32(holderPlbAddr));
      const utxoToBurn = allUtxos.find(u =>
        utxoTxHash(u) === targetTxHash && utxoOutputIndex(u) === targetIdx
      );
      if (!utxoToBurn) throw new Error(`UTxO ${targetTxHash}#${targetIdx} not found`);

      const burnAmount = utxoUnitQty(utxoToBurn, unit);
      if (burnAmount <= 0n) throw new Error(`No tokens of ${unit} in UTxO`);

      // 2. Find reference inputs
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);
      const registryAddr = scriptAddress(networkId, ctx.standardScripts.registry.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registryAddr));
      const registryUtxo = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!registryUtxo) throw new Error(`Registry node not found for ${tokenPolicyId}`);
      const issuanceLogicRefUtxo = await findIssuanceLogicRefUtxo(client, ctx.deployment);
      const refUtxos = [protocolParamsUtxo, registryUtxo, issuanceLogicRefUtxo];

      // 0.5.x third-party route. `ThirdPartyAct` was DELETED by #110: the
      // administrative path is now the standalone `third_party` validator, and
      // programmable_logic_base withdraws through the dispatcher, whose redeemer
      // carries ThirdPartyAct — so this transaction never loads the `transfer`
      // reference script at all.
      //
      // The withdrawal set is BOTH scripts: the framework delegate, and the
      // issuer authority the registry node names in
      // `third_party_transfer_logic_script`. `third_party` requires the latter
      // by name — it is the only thing standing between a holder's tokens and
      // anyone who wants them, and for FES it is a real issuer-admin check
      // rather than dummy's unconditional one.
      const thirdPartyKey: WithdrawalKey = {
        hash: ctx.standardScripts.thirdParty.hash,
        isScript: true,
      };
      const issuerAuthorityKey: WithdrawalKey = { hash: scripts.issuerAdmin.hash, isScript: true };
      // One plan owns the COMPLETE four-withdrawal and three-reference-input
      // sets. In particular, adding issuance_logic's reference script can move
      // every reference-input index that sorts after it.
      const plan = issuancePlan({
        issuanceLogicHash: ctx.deployment.issuanceLogic.scriptHash,
        plgHash: ctx.standardScripts.programmableLogicGlobal.hash,
        otherWithdrawals: [thirdPartyKey, issuerAuthorityKey],
        referenceInputs: refUtxos.map(utxoToTxInput),
        paramsRefInput: utxoToTxInput(protocolParamsUtxo),
        issued: [
          {
            policyId: tokenPolicyId,
            proof: { kind: "reference-input", input: utxoToTxInput(registryUtxo) },
          },
        ],
      });
      const registryIdx = plan.referenceInputIndexOf(utxoToTxInput(registryUtxo));

      // outputs_start_idx = 0: `third_party` PAIRS each programmable input with
      // the NEXT output (same address, datum and reference script, lovelace
      // ratcheting up) and reads the seized amount as the DELTA. Destination
      // outputs must therefore sit AMONG THE LEADING ones it skips.
      // See docs/api-reference.md — getting this backwards fails with an EMPTY
      // TRACE LIST, because it is a structural expect and not a traced check.
      // params_idx dropped: delegates no longer read the params datum.
      // ThirdPartyRedeemer.registry_node_idx and the issuance map's
      // RefInput{index} MUST be the same integer: upstream
      // third_party_covers_own_registry_node compares them. One plan computes
      // both, so the pair cannot drift when a reference input is added.
      const plgRedeemer = thirdPartyRedeemer(registryIdx, 0);
      const plbSpendRedeemer = baseSpendRedeemer(plan.paramsIdx, plan.plgIdx());
      const tokenDatum = voidData();

      // 5. Compute remaining assets (remove burned token's policy)
      const remainingTokens = new Map<string, bigint>();
      const allUnits = Assets.getUnits(utxoToBurn.assets);
      for (const u of allUnits) {
        if (u === "lovelace" || u === "") continue;
        if (u.startsWith(tokenPolicyId)) continue;
        const qty = Assets.getByUnit(utxoToBurn.assets, u);
        if (qty > 0n) remainingTokens.set(u, qty);
      }

      // 6. Build burn assets
      const burnAssets = mintAssetsFromMap(new Map([[unit, -burnAmount]]));

      // 7. Get wallet UTxOs
      const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));

      // 8. Build transaction
      let tx = client.newTx();
      const spendableUtxos = spendableWalletUtxos(walletUtxos, ctx.deployment);
      tx = tx.collectFrom({ inputs: spendableUtxos.slice(0, 2) });
      tx = tx.collectFrom({ inputs: [utxoToBurn], redeemer: plbSpendRedeemer });
      const withdrawalSpecs = [
        { hash: scripts.issuerAdmin.hash, redeemer: voidData() },
        {
          hash: ctx.standardScripts.programmableLogicGlobal.hash,
          redeemer: programmableLogicGlobalRedeemer("THIRD_PARTY"),
        },
        { hash: ctx.standardScripts.thirdParty.hash, redeemer: plgRedeemer },
        {
          hash: ctx.deployment.issuanceLogic.scriptHash,
          redeemer: plan.issuanceLogicRedeemer,
        },
      ];
      if (withdrawalSpecs.length !== plan.withdrawals.length) {
        throw new Error(
          `burn: issuance plan declares ${plan.withdrawals.length} withdrawals but ` +
            `${withdrawalSpecs.length} are emitted`
        );
      }
      for (const withdrawal of withdrawalSpecs) {
        tx = tx.withdraw({
          stakeCredential: Credential.makeScriptHash(
            new Uint8Array(Buffer.from(withdrawal.hash, "hex"))
          ),
          amount: 0n,
          redeemer: withdrawal.redeemer,
        });
      }
      // ⚑ NO min-UTxO COMPUTATION HERE, AND THAT IS CORRECT — do not "fix" it to
      // match the other outputs. This is the PAIRED CONTINUATION: `third_party`
      // requires it to preserve the input's address, datum and reference script
      // with lovelace only ratcheting UP, so it carries the INPUT'S OWN lovelace
      // forward. That figure was already min-UTxO-valid when the input was
      // created, and burning REMOVES tokens — a smaller output has a LOWER
      // requirement. Carrying it forward is therefore always sufficient, and
      // recomputing could only produce a smaller number, which the ratchet rule
      // forbids.
      tx = tx.payToAddress({
        address: utxoToBurn.address,
        assets: outputAssets(utxoLovelace(utxoToBurn), remainingTokens.size > 0 ? remainingTokens : undefined),
        // The PAIRED continuation: `third_party` requires it to preserve the
        // input's ADDRESS, DATUM and REFERENCE SCRIPT exactly. Carry the input's
        // own datum rather than a fresh void one — they happen to be equal today
        // because every programmable output here is void-datumed, and that is a
        // coincidence rather than a guarantee.
        datum: new InlineDatum.InlineDatum({ data: getInlineDatum(utxoToBurn) ?? tokenDatum }),
      });
      tx = tx.mintAssets({ assets: burnAssets, redeemer: plan.issuanceRedeemer });
      tx = tx.readFrom({ referenceInputs: refUtxos });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicBase.compiledCode) });
      // ⛔ THE DISPATCHER'S OWN SCRIPT WITNESS. A withdraw-0 needs the script in
      // full, not just a redeemer — alpha.3 added the dispatcher's withdrawal to
      // every programmable transaction, and S-6 wired the withdrawal and the
      // redeemer but not this. The ledger says "An associated script witness is
      // missing" on purpose=withdraw, which names the shape but not the script.
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicGlobal.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.thirdParty.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuerAdmin.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuanceMint.compiledCode) });
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(config.deployment.adminPkh) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, feePayerAddress, spendableUtxos);
      return { cbor, txHash, _signBuilder };
    },

    // ====================================================================
    // TRANSFER
    // ====================================================================
    async transfer(params: TransferParams): Promise<UnsignedTx> {
      const { senderAddress, recipientAddress, tokenPolicyId, assetName, quantity } = params;
      const unit = tokenPolicyId + assetName;
      const client = ctx.client;

      if (tokenPolicyId !== scripts.tokenPolicyId) {
        throw new Error(`Token policy ${tokenPolicyId} does not match this FES instance (${scripts.tokenPolicyId})`);
      }

      const plbHash = ctx.standardScripts.programmableLogicBase.hash;

      // 1. Build PLB addresses
      const senderPlbAddr = baseAddress(networkId, plbHash, senderAddress);
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipientAddress);

      // 2. Find sender's token UTxOs
      const allUtxos = await client.getUtxos(EvoAddress.fromBech32(senderPlbAddr));
      const tokenUtxos = allUtxos.filter(u => utxoUnitQty(u, unit) > 0n);
      if (tokenUtxos.length === 0) {
        throw new Error(`No token UTxOs found at ${senderPlbAddr} for ${unit}`);
      }

      // 3. Select enough UTxOs
      const { selected, totalTokenAmount } = selectUtxosForAmount(tokenUtxos, unit, quantity);
      const returningAmount = totalTokenAmount - quantity;

      // 4. Find registry node reference input
      const registryAddr = scriptAddress(networkId, ctx.standardScripts.registry.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registryAddr));
      const registryUtxo = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!registryUtxo) throw new Error(`Registry node not found for ${tokenPolicyId}`);

      // 5. Find protocol params reference input
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);

      // 6. Find blacklist non-membership proofs
      const senderStakingHash = stakingCredentialHash(senderAddress);
      const blacklistSpendAddr = scriptAddress(networkId, scripts.blacklistSpend.hash);
      const blacklistUtxos = await client.getUtxos(EvoAddress.fromBech32(blacklistSpendAddr));

      const proofUtxos: EvoUTxO.UTxO[] = [];
      for (const _inputUtxo of selected) {
        const proofUtxo = findBlacklistCoveringNode(blacklistUtxos, senderStakingHash);
        if (!proofUtxo) {
          throw new Error(`Sender ${senderStakingHash} is blacklisted — transfer denied`);
        }
        if (!proofUtxos.some(p =>
          utxoTxHash(p) === utxoTxHash(proofUtxo) && utxoOutputIndex(p) === utxoOutputIndex(proofUtxo)
        )) {
          proofUtxos.push(proofUtxo);
        }
      }

      // 7. Sort ALL reference inputs
      const allRefInputRefs = [
        ...proofUtxos.map(utxoToTxInput),
        utxoToTxInput(protocolParamsUtxo),
        utxoToTxInput(registryUtxo),
      ];
      const sortedRefInputs = sortTxInputs(allRefInputRefs);
      // ⚠ NOTE THE ASYMMETRY WITH `register`, WHICH S-11 MEASURED: there,
      // removing the params reference input is behaviour-preserving. HERE it is
      // not, and the reason has nothing to do with custody — see below. Two
      // transactions, one shared input, two unrelated dependencies on it.
      //
      // ⛔ A SECOND REASON THE PROTOCOL-PARAMS REFERENCE INPUT MUST STAY, beyond
      // the custody one recorded at `register`.
      //
      // Every index below — the blacklist proof indices, registryIdx, paramsIdx
      // — is a position in THIS sorted set. FES's own transfer validator reads
      // its blacklist nodes with `list.at(reference_inputs, node_idx)`, an
      // INDEX, not a search. Removing the params UTxO from the set therefore
      // shifts every proof index that sorts after it, and the failure is a
      // blacklist proof resolving to the WRONG NODE — a well-formed proof about
      // something else.
      //
      // So "the registry no longer needs this input" (#117) is true and still
      // does not license dropping it: two unrelated consumers in this same
      // transaction depend on it, one for custody semantics and one for index
      // arithmetic. Requirements belong to the TRANSACTION, not to the
      // component being edited.

      const proofIndices: number[] = selected.map(() =>
        findRefInputIndex(sortedRefInputs, utxoToTxInput(proofUtxos[0]))
      );

      const registryIdx = findRefInputIndex(sortedRefInputs, utxoToTxInput(registryUtxo));
      const paramsIdx = findRefInputIndex(sortedRefInputs, utxoToTxInput(protocolParamsUtxo));

      // 8. Get sender's wallet UTxOs
      const senderWalletUtxos = await client.getUtxos(EvoAddress.fromBech32(senderAddress));

      // 9. Build redeemers — 0.5.x shapes.
      //
      // The withdrawal set must be COMPLETE and in LEDGER order: script
      // credentials before key credentials, bytewise within each. alpha.3 makes
      // it THREE, all scripts — the dispatcher, the framework's `transfer`
      // delegate, and this substandard's own transfer logic. Every index in the
      // transaction shifted when the dispatcher joined.
      const coreTransferKey: WithdrawalKey = {
        hash: ctx.standardScripts.transfer.hash,
        isScript: true,
      };
      const fesLogicKey: WithdrawalKey = { hash: scripts.transfer.hash, isScript: true };
      const transferPlan = plbWithdrawalPlan({
        plgHash: ctx.standardScripts.programmableLogicGlobal.hash,
        others: [coreTransferKey, fesLogicKey],
      });

      if (process.env.DUMP_TX_STRUCTURE) {
        // Computed indices, printed beside the artefact's own order so the two
        // can be COMPARED rather than reasoned about. A structural expect in
        // programmable_logic_base fails with an empty trace list, so this is the
        // only way to see which index is wrong.
        // eslint-disable-next-line no-console
        console.error(
          "=== FES transfer COMPUTED ===\n" +
            `  refs (sorted): ${sortedRefInputs.map((r) => `${r.txHash.slice(0, 8)}#${r.outputIndex}`).join(" ")}\n` +
            `  paramsIdx=${paramsIdx} -> ${sortedRefInputs[paramsIdx]?.txHash?.slice(0, 8)}#${sortedRefInputs[paramsIdx]?.outputIndex}\n` +
            `  registryIdx=${registryIdx}\n` +
            `  coreTransfer=${ctx.standardScripts.transfer.hash}\n` +
            `  fesLogic    =${scripts.transfer.hash}\n` +
            `  plgWdrlIdx=${transferPlan.plgIdx}\n` +
            "=== END COMPUTED ==="
        );
      }
      const fesTransferRedeemer = Data.list(
        proofIndices.map((idx) => Data.constr(0n, [Data.int(BigInt(idx))]))
      );
      // TransferRedeemer { proofs } — params_idx was dropped in alpha.3; the
      // delegates stop reading the params datum entirely.
      const plgRedeemer = transferRedeemer([{ type: "exists", nodeIdx: registryIdx }]);
      // PLB witnesses where the DISPATCHER's withdrawal sits; the dispatch
      // choice itself moved to the dispatcher's own redeemer.
      const spendRdmr = baseSpendRedeemer(paramsIdx, transferPlan.plgIdx);
      const tokenDatum = voidData();

      // 10. Build transaction
      let tx = client.newTx();

      tx = tx.collectFrom({ inputs: selected, redeemer: spendRdmr });

      // The TRANSFER delegate — not third_party. programmable_logic_base
      // resolves the withdrawal at `wdrl_idx` and requires it to equal the
      // credential the params datum names for THIS dispatch arm, so withdrawing
      // the wrong delegate fails the spend with an empty trace list.
      // The DISPATCHER's own withdraw-0 — new in alpha.3, required on every
      // programmable transaction, and the entry PLB's wdrl_idx resolves to.
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(
          new Uint8Array(Buffer.from(ctx.standardScripts.programmableLogicGlobal.hash, "hex"))
        ),
        amount: 0n,
        redeemer: programmableLogicGlobalRedeemer("TRANSFER"),
      });
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(
          new Uint8Array(Buffer.from(ctx.standardScripts.transfer.hash, "hex"))
        ),
        amount: 0n,
        redeemer: plgRedeemer,
      });

      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(scripts.transfer.hash, "hex"))),
        amount: 0n,
        redeemer: fesTransferRedeemer,
      });

      const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;

      if (returningAmount > 0n) {
        tx = tx.payToAddress({
          address: EvoAddress.fromBech32(senderPlbAddr),
          assets: outputAssets(
            minUtxoAtLeast(TOKEN_OUTPUT_FLOOR, {
              address: senderPlbAddr,
                assets: outputAssets(0n, new Map([[unit, returningAmount]])),
              datum: tokenDatum,
              coinsPerUtxoByte,
            }),
            new Map([[unit, returningAmount]]),
          ),
          datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
        });
      }

      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(
          minUtxoAtLeast(TOKEN_OUTPUT_FLOOR, {
            address: recipientPlbAddr,
            assets: outputAssets(0n, new Map([[unit, quantity]])),
            datum: tokenDatum,
            coinsPerUtxoByte,
          }),
          new Map([[unit, quantity]]),
        ),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });

      tx = tx.readFrom({ referenceInputs: [...proofUtxos, protocolParamsUtxo, registryUtxo] });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicBase.compiledCode) });
      // ⛔ THE DISPATCHER'S OWN SCRIPT WITNESS. A withdraw-0 needs the script in
      // full, not just a redeemer — alpha.3 added the dispatcher's withdrawal to
      // every programmable transaction, and S-6 wired the withdrawal and the
      // redeemer but not this. The ledger says "An associated script witness is
      // missing" on purpose=withdraw, which names the shape but not the script.
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicGlobal.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.transfer.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.transfer.compiledCode) });

      tx = tx.addSigner({ keyHash: KeyHash.fromHex(senderStakingHash) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, senderAddress, senderWalletUtxos);
      return { cbor, txHash, _signBuilder };
    },

    // ====================================================================
    // INIT COMPLIANCE — initialize blacklist
    // ====================================================================
    async initCompliance(params: InitComplianceParams): Promise<UnsignedTx> {
      const { feePayerAddress, adminAddress, assetName } = params;
      const client = ctx.client;

      // 1. Build blacklist origin node
      const originDatum = blacklistNodeDatum("", MAX_NEXT);

      // 2. Compute addresses
      const blacklistSpendAddr = scriptAddress(networkId, scripts.blacklistSpend.hash);

      // 3. Build blacklist origin NFT
      const blacklistOriginUnit = scripts.blacklistMint.hash + "";
      const blacklistOriginAssets = mintAssetsFromMap(new Map([[blacklistOriginUnit, 1n]]));

      // 4. Get the bootstrap UTxO (must be consumed for one-shot minting policy)
      let bootstrapUtxos: EvoUTxO.UTxO[];
      if (params.bootstrapUtxo) {
        bootstrapUtxos = [params.bootstrapUtxo as EvoUTxO.UTxO];
      } else {
        const { blacklistInitTxInput } = config.deployment;
        bootstrapUtxos = await client.getUtxosByOutRef([
          new EvoTransactionInput.TransactionInput({
            transactionId: EvoTransactionHash.fromHex(blacklistInitTxInput.txHash),
            index: BigInt(blacklistInitTxInput.outputIndex),
          }),
        ]);
      }
      if (bootstrapUtxos.length === 0) throw new Error("Bootstrap UTxO not found on-chain");

      // 5. Build transaction
      let tx = client.newTx();

      // Must consume bootstrap UTxO (one-shot check in blacklist mint validator)
      tx = tx.collectFrom({ inputs: bootstrapUtxos });

      tx = tx.mintAssets({ assets: blacklistOriginAssets, redeemer: blacklistInitRedeemer() });

      // Output: chain output (40 ADA for next tx)
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(feePayerAddress),
        assets: outputAssets(40_000_000n),
      });

      // Output: blacklist origin node.
      //
      // ✅ FLAT CONSTANT IS CORRECT HERE, AND IT IS PROVABLE RATHER THAN
      // ASSUMED — this output carries NO caller-controlled bytes. The unit is
      // `blacklistMint.hash + ""` (an EMPTY asset name, fixed above), and the
      // datum is `blacklistNodeDatum("", MAX_NEXT)` — an empty key and a
      // 30-byte sentinel, both constants. MEASURED on preview
      // (coinsPerUtxoByte 4310): 1,198,180 required against 1,300,000 supplied,
      // 101,820 of headroom, and the live origin node on preview sits at
      // exactly 1,300,000. Nothing a caller types can move it.
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(blacklistSpendAddr),
        assets: outputAssets(1_300_000n, new Map([[blacklistOriginUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: originDatum }),
      });

      // Register stake addresses only if not already registered on-chain.
      // Check via backend API (reliable, unlike Blockfrost getDelegation).
      const stakeScripts = [
        { hash: scripts.issuerAdmin.hash, code: scripts.issuerAdmin.compiledCode },
        { hash: scripts.transfer.hash, code: scripts.transfer.compiledCode },
      ];
      for (const s of stakeScripts) {
        const stakeAddr = rewardAddress(networkId, s.hash);
        const registered = ctx.checkStakeRegistration
          ? await ctx.checkStakeRegistration(stakeAddr)
          : false; // no callback → assume not registered → register
        console.log(`[CIP-113] Stake ${stakeAddr}: registered=${registered}`);
        if (!registered) {
          tx = tx.registerStake({
            stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(s.hash, "hex"))),
            redeemer: voidData(),
          });
          tx = tx.attachScript({ script: buildEvoScript(s.code) });
        }
      }

      tx = tx.attachScript({ script: buildEvoScript(scripts.blacklistMint.compiledCode) });

      const built = await buildAndSerialize(tx, feePayerAddress);
      return {
        cbor: built.cbor,
        txHash: built.txHash,
        chainAvailable: built.chainAvailable,
        _signBuilder: built._signBuilder,
        metadata: {
          blacklistNodePolicyId: scripts.blacklistMint.hash,
          blacklistSpendScriptHash: scripts.blacklistSpend.hash,
          issuerAdminScriptHash: scripts.issuerAdmin.hash,
          transferScriptHash: scripts.transfer.hash,
        },
      };
    },

    // ====================================================================
    // FREEZE — add address to blacklist
    // ====================================================================
    async freeze(params: FreezeParams): Promise<UnsignedTx> {
      const { feePayerAddress, tokenPolicyId: _tokenPolicyId, assetName: _assetName, targetAddress } = params;
      const client = ctx.client;

      const targetStakingHash = stakingCredentialHash(targetAddress);

      const blacklistSpendAddr = scriptAddress(networkId, scripts.blacklistSpend.hash);
      const blacklistUtxos = await client.getUtxos(EvoAddress.fromBech32(blacklistSpendAddr));
      const coveringNode = findBlacklistCoveringNode(blacklistUtxos, targetStakingHash);
      if (!coveringNode) throw new Error(`Cannot find blacklist covering node for ${targetStakingHash} — may already be blacklisted`);

      const coveringDatum = getInlineDatum(coveringNode);
      const coveringKey = extractConstrBytesField(coveringDatum, 0) ?? "";
      const coveringNext = extractConstrBytesField(coveringDatum, 1) ?? MAX_NEXT;

      const updatedCoveringDatum = blacklistNodeDatum(coveringKey, targetStakingHash);
      const newNodeDatum = blacklistNodeDatum(targetStakingHash, coveringNext);

      const nftUnit = scripts.blacklistMint.hash + targetStakingHash;
      const nftAssets = mintAssetsFromMap(new Map([[nftUnit, 1n]]));

      const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));

      let tx = client.newTx();
      const spendableUtxos = spendableWalletUtxos(walletUtxos, ctx.deployment);
      tx = tx.collectFrom({ inputs: spendableUtxos.slice(0, 2) });
      tx = tx.collectFrom({ inputs: [coveringNode], redeemer: voidData() });

      tx = tx.mintAssets({ assets: nftAssets, redeemer: blacklistAddRedeemer(targetStakingHash) });

      // Output 0: updated covering node
      const coveringNftUnit = findCoveringNodeNftUnit(coveringNode, scripts.blacklistMint.hash);
      const coveringTokenMap = new Map<string, bigint>();
      if (coveringNftUnit) coveringTokenMap.set(coveringNftUnit, 1n);
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(blacklistSpendAddr),
        assets: outputAssets(utxoLovelace(coveringNode), coveringTokenMap),
        datum: new InlineDatum.InlineDatum({ data: updatedCoveringDatum }),
      });

      // Output 1: new blacklist node.
      //
      // ✅ FLAT CONSTANT IS CORRECT HERE TOO, for the same provable reason. The
      // unit is `blacklistMint.hash + targetStakingHash` — a 28-byte staking
      // credential, fixed width — and the datum is two hashes. A blacklist entry
      // has no user-supplied strings in it at all. MEASURED: 1,448,160 required
      // against 2,000,000 supplied, 551,840 of headroom.
      //
      // ⚠ If a future node datum gains a field, this stops being true silently.
      // That is exactly how REGISTRY_NODE_MIN_ADA went wrong when the registry
      // datum grew from five fields to seven.
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(blacklistSpendAddr),
        assets: outputAssets(2_000_000n, new Map([[nftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: newNodeDatum }),
      });

      tx = tx.attachScript({ script: buildEvoScript(scripts.blacklistSpend.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.blacklistMint.compiledCode) });
      const managerPkh = paymentCredentialHash(feePayerAddress);
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(managerPkh) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, feePayerAddress, spendableUtxos);
      return { cbor, txHash, _signBuilder };
    },

    // ====================================================================
    // UNFREEZE — remove address from blacklist
    // ====================================================================
    async unfreeze(params: UnfreezeParams): Promise<UnsignedTx> {
      const { feePayerAddress, tokenPolicyId: _tokenPolicyId, assetName: _assetName, targetAddress } = params;
      const client = ctx.client;

      const targetStakingHash = stakingCredentialHash(targetAddress);

      const blacklistSpendAddr = scriptAddress(networkId, scripts.blacklistSpend.hash);
      const blacklistUtxos = await client.getUtxos(EvoAddress.fromBech32(blacklistSpendAddr));

      const nodeToRemove = blacklistUtxos.find(u => {
        const datum = getInlineDatum(u);
        return datum ? extractConstrBytesField(datum, 0) === targetStakingHash : false;
      });
      if (!nodeToRemove) throw new Error(`Blacklist node not found for ${targetStakingHash}`);

      const precedingNode = blacklistUtxos.find(u => {
        const datum = getInlineDatum(u);
        return datum ? extractConstrBytesField(datum, 1) === targetStakingHash : false;
      });
      if (!precedingNode) throw new Error(`Preceding blacklist node not found for ${targetStakingHash}`);

      const precedingDatum = getInlineDatum(precedingNode);
      const precedingKey = extractConstrBytesField(precedingDatum, 0) ?? "";
      const removedDatum = getInlineDatum(nodeToRemove);
      const removedNext = extractConstrBytesField(removedDatum, 1) ?? MAX_NEXT;
      const updatedPrecedingDatum = blacklistNodeDatum(precedingKey, removedNext);

      const nftUnit = scripts.blacklistMint.hash + targetStakingHash;
      const burnAssets = mintAssetsFromMap(new Map([[nftUnit, -1n]]));

      const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));

      let tx = client.newTx();
      const spendableUtxos = spendableWalletUtxos(walletUtxos, ctx.deployment);
      tx = tx.collectFrom({ inputs: spendableUtxos.slice(0, 2) });
      tx = tx.collectFrom({ inputs: [nodeToRemove], redeemer: voidData() });
      tx = tx.collectFrom({ inputs: [precedingNode], redeemer: voidData() });

      tx = tx.mintAssets({ assets: burnAssets, redeemer: blacklistRemoveRedeemer(targetStakingHash) });

      // Output: updated preceding node
      const precedingNftUnit = findCoveringNodeNftUnit(precedingNode, scripts.blacklistMint.hash);
      const precedingTokenMap = new Map<string, bigint>();
      if (precedingNftUnit) precedingTokenMap.set(precedingNftUnit, 1n);
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(blacklistSpendAddr),
        assets: outputAssets(utxoLovelace(precedingNode), precedingTokenMap),
        datum: new InlineDatum.InlineDatum({ data: updatedPrecedingDatum }),
      });

      tx = tx.attachScript({ script: buildEvoScript(scripts.blacklistSpend.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.blacklistMint.compiledCode) });
      const managerPkh = paymentCredentialHash(feePayerAddress);
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(managerPkh) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, feePayerAddress, spendableUtxos);
      return { cbor, txHash, _signBuilder };
    },

    // ====================================================================
    // SEIZE
    // ====================================================================
    async seize(params: SeizeParams): Promise<UnsignedTx> {

      const { feePayerAddress, tokenPolicyId, assetName, utxoTxHash: targetTxHash, utxoOutputIndex: targetIdx, destinationAddress } = params;
      const unit = tokenPolicyId + assetName;
      const client = ctx.client;

      if (tokenPolicyId !== scripts.tokenPolicyId) {
        throw new Error(`Token policy ${tokenPolicyId} does not match this FES instance`);
      }

      // 1. Find UTxO to seize
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      let utxoToSeize: EvoUTxO.UTxO | undefined;

      // Search the holder's PLB address first, then fall back to feePayer and destination
      const searchAddresses: string[] = [];
      if (params.holderAddress) {
        searchAddresses.push(baseAddress(networkId, plbHash, params.holderAddress));
      }
      searchAddresses.push(
        baseAddress(networkId, plbHash, feePayerAddress),
        baseAddress(networkId, plbHash, destinationAddress),
      );
      // Deduplicate
      const uniqueAddresses = [...new Set(searchAddresses)];

      for (const addr of uniqueAddresses) {
        const utxos = await client.getUtxos(EvoAddress.fromBech32(addr));
        utxoToSeize = utxos.find(u =>
          utxoTxHash(u) === targetTxHash && utxoOutputIndex(u) === targetIdx
        );
        if (utxoToSeize) break;
      }

      if (!utxoToSeize) throw new Error(`UTxO ${targetTxHash}#${targetIdx} not found`);

      const seizedAmount = utxoUnitQty(utxoToSeize, unit);
      if (seizedAmount <= 0n) throw new Error(`No tokens of ${unit} in UTxO`);

      // 2. Find reference inputs
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);
      const registryAddr = scriptAddress(networkId, ctx.standardScripts.registry.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registryAddr));
      const registryUtxo = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!registryUtxo) throw new Error(`Registry node not found for ${tokenPolicyId}`);

      // 3. Sort reference inputs
      // `third_party`'s script is supplied EXPLICITLY, as a reference input.
      //
      // ⚠ It used to arrive BY ACCIDENT: the bootstrap publishes reference
      // scripts to the fee payer's own address, so `getUtxos(wallet)` returns
      // them and `slice(0, 2)` sometimes SPENT one. A spent input's reference
      // script counts as supplied (CIP-33), so the transaction validated —
      // and CONSUMED the deployment's reference-script UTxO in the process.
      // When the draw went the other way the script was absent entirely and
      // the ledger rejected with 3011 (missing script witness). One root
      // cause, two opposite symptoms; the earlier 3104 was its third face,
      // an explicit attach duplicating what the spent input already supplied.
      const thirdPartyRefUtxos = await client.getUtxosByOutRef([
        new EvoTransactionInput.TransactionInput({
          transactionId: EvoTransactionHash.fromHex(ctx.deployment.thirdPartyRefInput.txHash),
          index: BigInt(ctx.deployment.thirdPartyRefInput.outputIndex),
        }),
      ]);
      if (thirdPartyRefUtxos.length === 0) {
        throw new Error(
          `third_party reference script not found on-chain at ` +
            `${ctx.deployment.thirdPartyRefInput.txHash}#${ctx.deployment.thirdPartyRefInput.outputIndex}. ` +
            `Deployment reference scripts are load-bearing: if an earlier transaction SPENT this ` +
            `output, the deployment is broken and must be re-published.`
        );
      }
      const thirdPartyRefUtxo = thirdPartyRefUtxos[0]!;

      const allRefInputRefs = [
        utxoToTxInput(protocolParamsUtxo),
        utxoToTxInput(registryUtxo),
        utxoToTxInput(thirdPartyRefUtxo),
      ];
      const sortedRefInputs = sortTxInputs(allRefInputRefs);
      const registryIdx = findRefInputIndex(sortedRefInputs, utxoToTxInput(registryUtxo));

      // 4. Build redeemers
      const paramsIdx = findRefInputIndex(sortedRefInputs, utxoToTxInput(protocolParamsUtxo));

      // 0.5.x third-party route. `ThirdPartyAct` was DELETED by #110: the
      // administrative path is now the standalone `third_party` validator, and
      // programmable_logic_base withdraws through the dispatcher, whose redeemer
      // carries ThirdPartyAct — so this transaction never loads the `transfer`
      // reference script at all.
      //
      // The withdrawal set is BOTH scripts: the framework delegate, and the
      // issuer authority the registry node names in
      // `third_party_transfer_logic_script`. `third_party` requires the latter
      // by name — it is the only thing standing between a holder's tokens and
      // anyone who wants them, and for FES it is a real issuer-admin check
      // rather than dummy's unconditional one.
      const thirdPartyKey: WithdrawalKey = {
        hash: ctx.standardScripts.thirdParty.hash,
        isScript: true,
      };
      const issuerAuthorityKey: WithdrawalKey = { hash: scripts.issuerAdmin.hash, isScript: true };
      // alpha.3: the DISPATCHER withdraws on every programmable transaction and
      // PLB's wdrl_idx points at IT, not at the delegate.
      const plan = plbWithdrawalPlan({
        plgHash: ctx.standardScripts.programmableLogicGlobal.hash,
        others: [thirdPartyKey, issuerAuthorityKey],
      });

      // outputs_start_idx = 1: `third_party` PAIRS each programmable input with
      // the NEXT output (same address, datum and reference script, lovelace
      // ratcheting up) and reads the seized amount as the DELTA. Destination
      // outputs must therefore sit AMONG THE LEADING ones it skips.
      // See docs/api-reference.md — getting this backwards fails with an EMPTY
      // TRACE LIST, because it is a structural expect and not a traced check.
      // params_idx dropped: delegates no longer read the params datum.
      const plgRedeemer = thirdPartyRedeemer(registryIdx, 1);
      const plbSpendRedeemer = baseSpendRedeemer(paramsIdx, plan.plgIdx);
      const tokenDatum = voidData();

      // 5. Build recipient PLB address
      const recipientPlbAddr = baseAddress(networkId, plbHash, destinationAddress);

      // 6. Compute remaining assets
      const remainingTokens = new Map<string, bigint>();
      const allUnits = Assets.getUnits(utxoToSeize.assets);
      for (const u of allUnits) {
        if (u === "lovelace" || u === "" || u === unit) continue;
        const qty = Assets.getByUnit(utxoToSeize.assets, u);
        if (qty > 0n) remainingTokens.set(u, qty);
      }

      // 7. Get wallet UTxOs
      const walletUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));
      // NEVER spend a deployment reference-script UTxO — see spendableWalletUtxos.
      const spendableUtxos = spendableWalletUtxos(walletUtxos, ctx.deployment);

      // 8. Build transaction
      let tx = client.newTx();
      tx = tx.collectFrom({ inputs: spendableUtxos.slice(0, 2) });
      tx = tx.collectFrom({ inputs: [utxoToSeize], redeemer: plbSpendRedeemer });

      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(scripts.issuerAdmin.hash, "hex"))),
        amount: 0n,
        redeemer: voidData(),
      });
      // The DISPATCHER's own withdraw-0 — new in alpha.3, required on every
      // programmable transaction, and the entry PLB's wdrl_idx resolves to.
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(
          new Uint8Array(Buffer.from(ctx.standardScripts.programmableLogicGlobal.hash, "hex"))
        ),
        amount: 0n,
        redeemer: programmableLogicGlobalRedeemer("THIRD_PARTY"),
      });
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(
          new Uint8Array(Buffer.from(ctx.standardScripts.thirdParty.hash, "hex"))
        ),
        amount: 0n,
        redeemer: plgRedeemer,
      });

      const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;

      // Output 0: seized tokens to recipient
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(
          minUtxoAtLeast(TOKEN_OUTPUT_FLOOR, {
            address: recipientPlbAddr,
            assets: outputAssets(0n, new Map([[unit, seizedAmount]])),
            datum: tokenDatum,
            coinsPerUtxoByte,
          }),
          new Map([[unit, seizedAmount]]),
        ),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });

      // Output 1: remaining value to original address
      tx = tx.payToAddress({
        address: utxoToSeize.address,
        assets: outputAssets(utxoLovelace(utxoToSeize), remainingTokens.size > 0 ? remainingTokens : undefined),
        // The PAIRED continuation: `third_party` requires it to preserve the
        // input's ADDRESS, DATUM and REFERENCE SCRIPT exactly. Carry the input's
        // own datum rather than a fresh void one — they happen to be equal today
        // because every programmable output here is void-datumed, and that is a
        // coincidence rather than a guarantee.
        datum: new InlineDatum.InlineDatum({ data: getInlineDatum(utxoToSeize) ?? tokenDatum }),
      });

      tx = tx.readFrom({ referenceInputs: [protocolParamsUtxo, registryUtxo, thirdPartyRefUtxo] });
      if (process.env.DUMP_TX_STRUCTURE) {
        // eslint-disable-next-line no-console
        console.error(
          "=== SEIZE attached scripts ===\n" +
            `  programmableLogicBase=${ctx.standardScripts.programmableLogicBase.hash}\n` +
            `  thirdParty           =${ctx.standardScripts.thirdParty.hash}\n` +
            `  issuerAdmin          =${scripts.issuerAdmin.hash}\n` +
            "=== END SEIZE SCRIPTS ==="
        );
      }
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicBase.compiledCode) });
      // ⛔ THE DISPATCHER'S OWN SCRIPT WITNESS. A withdraw-0 needs the script in
      // full, not just a redeemer — alpha.3 added the dispatcher's withdrawal to
      // every programmable transaction, and S-6 wired the withdrawal and the
      // redeemer but not this. The ledger says "An associated script witness is
      // missing" on purpose=withdraw, which names the shape but not the script.
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicGlobal.compiledCode) });
      // ⚠ `third_party` is NOT attached here. Its withdrawal already carries the
      // script witness, and attaching it again makes the duplicate extraneous —
      // the ledger rejects the whole transaction with code 3104. MEASURED: the
      // hash it names is third_party's, while the withdrawal for that same
      // credential is present and correct.
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuerAdmin.compiledCode) });
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(config.deployment.adminPkh) });

      const { cbor, txHash, _signBuilder } = await buildAndSerialize(tx, feePayerAddress, spendableUtxos);
      return { cbor, txHash, _signBuilder };
    },
  };
}

// Re-export types and utilities
export type { FESDeploymentParams } from "./types.js";
export { createFESScripts } from "./scripts.js";
