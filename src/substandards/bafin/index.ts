/**
 * BaFin securities substandard.
 *
 * Uses Evolution SDK directly — no adapter abstraction.
 *
 * Operations:
 * - initCompliance: Initialize both power_users and users linked lists
 * - addPowerUser: Add a power user to the linked list (exported helper)
 * - addUser: Add a user to the linked list (exported helper)
 * - register: First mint + CIP-113 registry insert + global state update
 *
 * Remaining: mint, burn, transfer, freeze, seize (not yet implemented)
 */

import {
  Address as EvoAddress,
  Assets,
  Data,
  Transaction,
  TransactionHash as EvoTransactionHash,
} from "@evolution-sdk/evolution";

import type { UTxO as EvoUTxO } from "@evolution-sdk/evolution";

import type { PlutusBlueprint, PlutusScript, DeploymentParams, HexString } from "../../types.js";
import type {
  SubstandardPlugin,
  SubstandardContext,
  EvoClient,
  RegisterParams,
  MintParams,
  BurnParams,
  TransferParams,
  InitComplianceParams,
  UnsignedTx,
} from "../interface.js";
import {
  findCoveringNode,
} from "../../core/registry.js";
import {
  buildEvoScript,
  scriptAddress,
  rewardAddress,
  baseAddress,
  stringToHex,
  MAX_NEXT,
  voidData,
  registryNodeDatum,
  issuanceRedeemerFirstMint,
  registryInsertRedeemer,
  extractConstrBytesField,
  extractCredentialField,
  getInlineDatum,
  utxoLovelace,
  outputAssets,
  mintAssetsFromMap,
  Credential,
  KeyHash,
  InlineDatum,
  labeledAssetName,
  buildCIP68FTDatum,
} from "../../core/evo-utils.js";
import { createBaFinScripts } from "./scripts.js";
import type { BaFinDeploymentParams } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Linked list root key — empty asset name */
const LL_ROOT_KEY = "";
/** Linked list node key prefix — "Node" in hex */
const LL_NODE_PREFIX_HEX = stringToHex("Node");

// ---------------------------------------------------------------------------
// Resolved scripts — computed once at init, reused for all operations
// ---------------------------------------------------------------------------

interface ResolvedBaFinScripts {
  mintingLogic: PlutusScript;
  transferLogic: PlutusScript;
  thirdPartyTransferLogic: PlutusScript;
  globalStateMint: PlutusScript;
  globalStateSpend: PlutusScript;
  powerUsersMint: PlutusScript;
  powerUsersSpend: PlutusScript;
  usersMint: PlutusScript;
  usersSpend: PlutusScript;
  issuanceMint: PlutusScript;
  tokenPolicyId: string;
  /** Derived: global_state_mint policy ID */
  globalStatePolicyId: string;
  /** Derived: power_users linked list policy ID = powerUsersMint.hash */
  powerUsersLinkedListPolicyId: string;
  /** Derived: users linked list policy ID = usersMint.hash */
  usersLinkedListPolicyId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndSerialize(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: any,
  changeAddress: string,
  availableUtxos?: EvoUTxO.UTxO[],
  passAdditionalUtxos = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator?: any,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ cbor: string; txHash: string; chainAvailable?: EvoUTxO.UTxO[]; _signBuilder?: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildOpts: any = {
    changeAddress: EvoAddress.fromBech32(changeAddress),
  };
  if (availableUtxos) {
    buildOpts.availableUtxos = availableUtxos;
  }
  if (passAdditionalUtxos) {
    buildOpts.passAdditionalUtxos = true;
  }
  if (evaluator) {
    buildOpts.evaluator = evaluator;
    buildOpts.passAdditionalUtxos = true;
  }
  const result = await builder.build(buildOpts);
  const tx = await result.toTransaction();
  const cbor = Transaction.toCBORHex(tx);

  let txHash = "";
  let chainAvailable: EvoUTxO.UTxO[] | undefined;
  if (typeof result.chainResult === "function") {
    const cr = result.chainResult();
    txHash = cr.txHash;
    chainAvailable = cr.available as EvoUTxO.UTxO[];
  }

  return { cbor, txHash, chainAvailable, _signBuilder: result };
}

async function findProtocolParamsUtxo(
  client: EvoClient, networkId: number, deployment: DeploymentParams,
): Promise<EvoUTxO.UTxO> {
  const ppUnit = deployment.protocolParams.policyId + stringToHex("ProtocolParams");
  const addr = EvoAddress.fromBech32(
    scriptAddress(networkId, deployment.protocolParams.alwaysFailScriptHash)
  );
  const utxos = await client.getUtxosWithUnit(addr, ppUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Protocol params UTxO not found (unit: ${ppUnit})`);
}

async function findIssuanceCborHexUtxo(
  client: EvoClient, networkId: number, deployment: DeploymentParams,
): Promise<EvoUTxO.UTxO> {
  const icUnit = deployment.issuance.policyId + stringToHex("IssuanceCborHex");
  const addr = EvoAddress.fromBech32(
    scriptAddress(networkId, deployment.issuance.alwaysFailScriptHash)
  );
  const utxos = await client.getUtxosWithUnit(addr, icUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Issuance CBOR hex UTxO not found (unit: ${icUnit})`);
}

function findCoveringNodeNftUnit(utxo: EvoUTxO.UTxO, policyId: string): string | undefined {
  const units = Assets.getUnits(utxo.assets);
  for (const unit of units) {
    if (unit === "lovelace" || unit === "") continue;
    if (unit.startsWith(policyId)) return unit;
  }
  return undefined;
}

async function findConfigUtxo(
  client: EvoClient, networkId: number, configPolicyId: HexString, configScriptHash: HexString,
): Promise<EvoUTxO.UTxO> {
  const configUnit = configPolicyId + stringToHex("Config");
  const addr = EvoAddress.fromBech32(scriptAddress(networkId, configScriptHash));
  const utxos = await client.getUtxosWithUnit(addr, configUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Config UTxO not found (unit: ${configUnit})`);
}

async function findGlobalStateUtxo(
  client: EvoClient, networkId: number, globalStatePolicyId: HexString, globalStateScriptHash: HexString,
): Promise<EvoUTxO.UTxO> {
  const gsUnit = globalStatePolicyId + stringToHex("GlobalState");
  const addr = EvoAddress.fromBech32(scriptAddress(networkId, globalStateScriptHash));
  const utxos = await client.getUtxosWithUnit(addr, gsUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`GlobalState UTxO not found (unit: ${gsUnit})`);
}

/**
 * Find a power user node by credential hash from the linked list.
 */
async function findPowerUserNode(
  client: EvoClient,
  networkId: number,
  powerUsersSpendHash: HexString,
  powerUsersLLPolicyId: HexString,
  credentialHash: HexString,
): Promise<EvoUTxO.UTxO> {
  const nodeUnit = powerUsersLLPolicyId + LL_NODE_PREFIX_HEX + credentialHash;
  const addr = EvoAddress.fromBech32(scriptAddress(networkId, powerUsersSpendHash));
  const utxos = await client.getUtxosWithUnit(addr, nodeUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Power user node not found for credential: ${credentialHash}`);
}

/**
 * Find the root node of a linked list.
 */
async function findLinkedListRoot(
  client: EvoClient, networkId: number, spendScriptHash: HexString, mintPolicyId: HexString,
): Promise<EvoUTxO.UTxO> {
  const rootUnit = mintPolicyId + LL_ROOT_KEY;
  const addr = EvoAddress.fromBech32(scriptAddress(networkId, spendScriptHash));
  const utxos = await client.getUtxosWithUnit(addr, rootUnit);
  if (utxos.length > 0) return utxos[0];
  throw new Error(`Linked list root node not found (policyId: ${mintPolicyId})`);
}

// ---------------------------------------------------------------------------
// Datum builders (Anastasia Labs linked list format)
// ---------------------------------------------------------------------------

/**
 * Linked list Element datum.
 *
 * Element<root_data, node_data> = Constr(0, [ElementData, Link])
 * ElementData::Root = Constr(0, [root_data])
 * ElementData::Node = Constr(1, [node_data])
 * Link = Option::None = Constr(1, []) | Option::Some = Constr(0, [next_key_bytes])
 */
function linkedListRootDatum(): Data.Data {
  return Data.constr(0n, [
    Data.constr(0n, [Data.constr(0n, [])]),  // Root { data: void }
    Data.constr(1n, []),                       // Link::None
  ]);
}

function linkedListNodeDatum(nodeData: Data.Data, nextKey: string | null): Data.Data {
  const link = nextKey !== null
    ? Data.constr(0n, [Data.bytearray(nextKey)])  // Some(next_key)
    : Data.constr(1n, []);                          // None
  return Data.constr(0n, [
    Data.constr(1n, [nodeData]),  // Node { data: node_data }
    link,
  ]);
}

/**
 * PowerUser datum: Constr(0, [credential_hash, is_admin, can_mint, can_burn,
 *   can_pause, can_verify, can_blacklist, can_force_transfer])
 * Each Bool: Constr(1,[]) = True, Constr(0,[]) = False
 */
function powerUserDatum(opts: {
  credentialHash: HexString;
  isAdmin: boolean;
  canMint: boolean;
  canBurn: boolean;
  canPause: boolean;
  canVerify: boolean;
  canBlacklist: boolean;
  canForceTransfer: boolean;
}): Data.Data {
  const bool = (b: boolean) => b ? Data.constr(1n, []) : Data.constr(0n, []);
  return Data.constr(0n, [
    Data.bytearray(opts.credentialHash),
    bool(opts.isAdmin),
    bool(opts.canMint),
    bool(opts.canBurn),
    bool(opts.canPause),
    bool(opts.canVerify),
    bool(opts.canBlacklist),
    bool(opts.canForceTransfer),
  ]);
}

/**
 * User datum: Constr(0, [is_verified, is_blacklisted])
 */
function userDatum(isVerified: boolean, isBlacklisted: boolean): Data.Data {
  const bool = (b: boolean) => b ? Data.constr(1n, []) : Data.constr(0n, []);
  return Data.constr(0n, [bool(isVerified), bool(isBlacklisted)]);
}

// ---------------------------------------------------------------------------
// Redeemer builders
// ---------------------------------------------------------------------------

// Linked list mint redeemers (Aiken enum constructors):
// Init = Constr(0, [root_output_index])
// Deinit = Constr(1, [root_input_index])
// AddPowerUser / AddUser = Constr(2, [...])
// RemovePowerUser / RemoveUser = Constr(3, [...])

function linkedListInitRedeemer(rootOutputIndex: number): Data.Data {
  return Data.constr(0n, [Data.int(BigInt(rootOutputIndex))]);
}

function addPowerUserRedeemer(
  newPowerUserKey: HexString,
  anchorNodeInputIndex: number,
  anchorNodeOutputIndex: number,
  appendedNodeOutputIndex: number,
): Data.Data {
  return Data.constr(2n, [
    Data.bytearray(newPowerUserKey),
    Data.int(BigInt(anchorNodeInputIndex)),
    Data.int(BigInt(anchorNodeOutputIndex)),
    Data.int(BigInt(appendedNodeOutputIndex)),
  ]);
}

function addUserRedeemer(
  newUserKey: HexString,
  anchorNodeInputIndex: number,
  anchorNodeOutputIndex: number,
  appendedNodeOutputIndex: number,
  powerUserNodeRefInputIndex: number,
): Data.Data {
  return Data.constr(2n, [
    Data.bytearray(newUserKey),
    Data.int(BigInt(anchorNodeInputIndex)),
    Data.int(BigInt(anchorNodeOutputIndex)),
    Data.int(BigInt(appendedNodeOutputIndex)),
    Data.int(BigInt(powerUserNodeRefInputIndex)),
  ]);
}

/**
 * MintingLogicScriptWithdrawRedeemer:
 *   Constr(0, [config_ref_input_index, global_state_input_index,
 *              power_user_node_ref_input_index, minted_amount])
 */
function mintingLogicRedeemer(
  configRefInputIndex: number,
  globalStateInputIndex: number,
  powerUserNodeRefInputIndex: number,
  mintedAmount: bigint,
): Data.Data {
  return Data.constr(0n, [
    Data.int(BigInt(configRefInputIndex)),
    Data.int(BigInt(globalStateInputIndex)),
    Data.int(BigInt(powerUserNodeRefInputIndex)),
    Data.int(mintedAmount),
  ]);
}

/**
 * GlobalStateSpendRedeemer:
 *   Constr(0, [config_ref_input_index, global_state_output_index, action])
 * MintSecurity = Constr(0, [issuance_policy_redeemer_index])
 */
function globalStateSpendRedeemer(
  configRefInputIndex: number,
  globalStateOutputIndex: number,
  issuancePolicyRedeemerIndex: number,
): Data.Data {
  return Data.constr(0n, [
    Data.int(BigInt(configRefInputIndex)),
    Data.int(BigInt(globalStateOutputIndex)),
    Data.constr(0n, [Data.int(BigInt(issuancePolicyRedeemerIndex))]),
  ]);
}

/**
 * GlobalStateDatum:
 *   Constr(0, [transfers_paused, mintable_amount, users_ll_policy_id,
 *              power_user_ll_policy_id, security_info])
 */
function globalStateDatumBuilder(
  transfersPaused: boolean,
  mintableAmount: bigint,
  usersLinkedListPolicyId: HexString,
  powerUserLinkedListPolicyId: HexString,
  securityInfo: Data.Data,
): Data.Data {
  const bool = (b: boolean) => b ? Data.constr(1n, []) : Data.constr(0n, []);
  return Data.constr(0n, [
    bool(transfersPaused),
    Data.int(mintableAmount),
    Data.bytearray(usersLinkedListPolicyId),
    Data.bytearray(powerUserLinkedListPolicyId),
    securityInfo,
  ]);
}

function parseGlobalStateDatum(datum: Data.Data): {
  transfersPaused: boolean;
  mintableAmount: bigint;
  usersLinkedListPolicyId: string;
  powerUserLinkedListPolicyId: string;
  securityInfo: Data.Data;
} {
  const constr = datum as unknown as { index: bigint; fields: readonly Data.Data[] };
  const pausedField = constr.fields[0] as unknown as { index: bigint };
  const transfersPaused = pausedField.index === 1n;
  const mintableAmount = constr.fields[1] as unknown as bigint;
  return {
    transfersPaused,
    mintableAmount: typeof mintableAmount === "bigint" ? mintableAmount : BigInt(String(mintableAmount)),
    usersLinkedListPolicyId: extractConstrBytesField(datum, 2) ?? "",
    powerUserLinkedListPolicyId: extractConstrBytesField(datum, 3) ?? "",
    securityInfo: constr.fields[4],
  };
}

/**
 * Compute the issuance policy redeemer index in self.redeemers.
 *
 * In Plutus V3 (Aiken), self.redeemers is sorted by ScriptPurpose:
 *   Mint(policyId) < Spend(outRef) < WithdrawFrom(cred) < ...
 * Within each purpose, sorted by the inner value.
 *
 * For our register tx, the mint redeemers are for issuanceMint and registryMint.
 * The issuance index = number of mint policies that sort before it.
 */
function computeIssuanceRedeemerIndex(
  issuancePolicyId: string,
  registryMintPolicyId: string,
): number {
  // Mint redeemers come first. The issuance policy's position among mints.
  const mintPolicies = [issuancePolicyId, registryMintPolicyId].sort();
  const mintIndex = mintPolicies.indexOf(issuancePolicyId);
  // That's its absolute index since Mint is the first purpose tag.
  return mintIndex;
}

// ---------------------------------------------------------------------------
// Extended plugin type (exposes resolved scripts for helpers)
// ---------------------------------------------------------------------------

export interface BaFinPlugin extends SubstandardPlugin {
  /** Access resolved scripts after init() has been called. */
  getScripts(): ResolvedBaFinScripts;
  getNetworkId(): number;
  /** Set a custom evaluator (e.g., Ogmios) for all tx builds. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setEvaluator(evaluator: any): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function bafinSubstandard(config: {
  blueprint: PlutusBlueprint;
  deployment: BaFinDeploymentParams;
}): BaFinPlugin {
  let ctx: SubstandardContext;
  let scripts: ResolvedBaFinScripts;
  let networkId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let customEvaluator: any = undefined;

  return {
    id: "bafin",
    version: "0.0.1",
    blueprint: config.blueprint,

    init(context) {
      ctx = context;
      networkId = ctx.client.chain.id;
      const dep = config.deployment;
      const bafin = createBaFinScripts(config.blueprint);

      // 1. Build global_state_mint (one-shot) → derive globalStatePolicyId
      const globalStateMint = bafin.buildGlobalStateMint(dep.globalStateInitTxInput);
      const globalStatePolicyId = globalStateMint.hash;

      // 2. Build linked list mint scripts (determines policy IDs)
      const powerUsersMint = bafin.buildPowerUsersMint(dep.ownerCredentialHash, dep.powerUsersInitTxInput);
      const powerUsersLinkedListPolicyId = powerUsersMint.hash;

      const usersMint = bafin.buildUsersMint(dep.usersInitTxInput, powerUsersLinkedListPolicyId);
      const usersLinkedListPolicyId = usersMint.hash;

      // 3. Build linked list spend scripts
      const powerUsersSpend = bafin.buildPowerUsersSpend(dep.ownerCredentialHash, powerUsersLinkedListPolicyId);
      const usersSpend = bafin.buildUsersSpend(powerUsersLinkedListPolicyId, usersLinkedListPolicyId);

      // 4. Build minting_logic_script (3 params — issuance_cbor_hex_cs removed)
      const mintingLogic = bafin.buildMintingLogic(
        dep.securityAssetName,
        globalStatePolicyId,
        powerUsersLinkedListPolicyId,
      );

      // 5. Build issuance_mint from minting logic hash → token policy ID
      const issuanceMint = ctx.standardScripts.buildIssuanceMint(mintingLogic.hash);

      // 6. Build transfer + third_party logic scripts
      const transferLogic = bafin.buildTransferLogic(
        dep.securityAssetName, globalStatePolicyId, usersLinkedListPolicyId, issuanceMint.hash,
      );
      const thirdPartyTransferLogic = bafin.buildThirdPartyTransferLogic(
        dep.securityAssetName, powerUsersLinkedListPolicyId, usersLinkedListPolicyId, issuanceMint.hash,
      );

      // 7. Build global_state_spend (config is empty for now — placeholder)
      const configPolicyId = "";
      const globalStateSpend = bafin.buildGlobalStateSpend(
        dep.ownerCredentialHash, dep.securityAssetName, configPolicyId, globalStatePolicyId,
      );

      scripts = {
        mintingLogic, transferLogic, thirdPartyTransferLogic,
        globalStateMint, globalStateSpend,
        powerUsersMint, powerUsersSpend, usersMint, usersSpend,
        issuanceMint,
        tokenPolicyId: issuanceMint.hash,
        globalStatePolicyId,
        powerUsersLinkedListPolicyId,
        usersLinkedListPolicyId,
      };
    },

    getScripts() {
      if (!scripts) throw new Error("BaFin plugin not initialized — call init() first");
      return scripts;
    },

    getNetworkId() {
      return networkId;
    },

    setEvaluator(evaluator) {
      customEvaluator = evaluator;
    },

    // ====================================================================
    // INIT COMPLIANCE — Initialize both linked lists + register stakes
    // ====================================================================
    async initCompliance(params: InitComplianceParams): Promise<UnsignedTx> {
      const { feePayerAddress } = params;
      const client = ctx.client;
      const dep = config.deployment;

      const puSpendAddr = scriptAddress(networkId, scripts.powerUsersSpend.hash);
      const usersSpendAddr = scriptAddress(networkId, scripts.usersSpend.hash);
      // Global state NFT goes to address with mint policy hash as payment credential
      // (the mint validator enforces: output.address.payment_credential == Script(policy_id))
      const globalStateAddr = scriptAddress(networkId, scripts.globalStatePolicyId);

      // Root datums for both linked lists
      const rootDatum = linkedListRootDatum();

      // Global state initial datum
      const gsDatum = globalStateDatumBuilder(
        false,                                      // transfers_paused = false
        1_000_000n,                                 // mintable_amount (initial supply cap)
        scripts.usersLinkedListPolicyId,
        scripts.powerUsersLinkedListPolicyId,
        Data.constr(0n, []),                        // security_info = void (placeholder)
      );

      // NFT units
      const puRootUnit = scripts.powerUsersLinkedListPolicyId + LL_ROOT_KEY;
      const usersRootUnit = scripts.usersLinkedListPolicyId + LL_ROOT_KEY;
      const gsNftUnit = scripts.globalStatePolicyId + stringToHex("GlobalState");

      // Fetch the 3 bootstrap UTxOs — one-shot mint validators require them as inputs
      const allUtxos = await client.getUtxos(EvoAddress.fromBech32(feePayerAddress));

      const findBootstrapUtxo = (txInput: { txHash: string; outputIndex: number }) => {
        const found = allUtxos.find((u: EvoUTxO.UTxO) => {
          const hash = EvoTransactionHash.toHex(u.transactionId);
          return hash === txInput.txHash && Number(u.index) === txInput.outputIndex;
        });
        if (!found) throw new Error(`Bootstrap UTxO not found: ${txInput.txHash}#${txInput.outputIndex}`);
        return found;
      };

      const gsBootstrapUtxo = findBootstrapUtxo(dep.globalStateInitTxInput);
      const puBootstrapUtxo = findBootstrapUtxo(dep.powerUsersInitTxInput);
      const usersBootstrapUtxo = findBootstrapUtxo(dep.usersInitTxInput);

      // Build transaction
      let tx = client.newTx();

      // Consume all 3 bootstrap UTxOs (one-shot nonces)
      tx = tx.collectFrom({ inputs: [gsBootstrapUtxo, puBootstrapUtxo, usersBootstrapUtxo] });

      // Mint global state NFT (output at index 0 per mint validator check)
      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[gsNftUnit, 1n]])),
        redeemer: voidData(),
      });

      // Mint root NFTs for both linked lists
      // power_users Init redeemer: root at output index 1
      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[puRootUnit, 1n]])),
        redeemer: linkedListInitRedeemer(1),
      });
      // users Init redeemer: root at output index 2
      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[usersRootUnit, 1n]])),
        redeemer: linkedListInitRedeemer(2),
      });

      // Output 0: global state UTxO (mint validator enforces first output)
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(globalStateAddr),
        assets: outputAssets(2_000_000n, new Map([[gsNftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: gsDatum }),
      });

      // Output 1: power_users root node
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(puSpendAddr),
        assets: outputAssets(2_000_000n, new Map([[puRootUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: rootDatum }),
      });

      // Output 2: users root node
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(usersSpendAddr),
        assets: outputAssets(2_000_000n, new Map([[usersRootUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: rootDatum }),
      });

      // Attach mint scripts
      tx = tx.attachScript({ script: buildEvoScript(scripts.globalStateMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.powerUsersMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.usersMint.compiledCode) });

      // TODO: Stake registration for CIP-113 logic scripts.
      // The BaFin validators have `else(_) { fail }` which rejects the publish/certifying
      // purpose. Stake registration needs a separate mechanism or a validator update
      // to handle the certificate purpose. Skipping for now.

      // Signer: owner
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(dep.ownerCredentialHash) });

      const built = await buildAndSerialize(tx, feePayerAddress, undefined, false, customEvaluator);
      return {
        cbor: built.cbor,
        txHash: built.txHash,
        chainAvailable: built.chainAvailable,
        _signBuilder: built._signBuilder,
        metadata: {
          globalStatePolicyId: scripts.globalStatePolicyId,
          globalStateAddress: globalStateAddr,
          powerUsersLinkedListPolicyId: scripts.powerUsersLinkedListPolicyId,
          usersLinkedListPolicyId: scripts.usersLinkedListPolicyId,
          powerUsersSpendScriptHash: scripts.powerUsersSpend.hash,
          usersSpendScriptHash: scripts.usersSpend.hash,
          tokenPolicyId: scripts.tokenPolicyId,
        },
      };
    },

    // ====================================================================
    // REGISTER — first mint + registry insert + global state update
    // ====================================================================
    async register(params: RegisterParams): Promise<UnsignedTx> {
      const { feePayerAddress, assetName, quantity, recipientAddress } = params;
      const recipient = recipientAddress || feePayerAddress;
      const chainedUtxos = (params.chainedUtxos ?? []) as EvoUTxO.UTxO[];
      const assetNameHex = stringToHex(assetName);
      const hasCIP68 = !!params.cip68Metadata;
      const client = ctx.client;
      const dep = config.deployment;

      const bafinConfig = params.config ?? {};
      const powerUserCredentialHash = bafinConfig.powerUserCredentialHash as string;
      if (!powerUserCredentialHash) {
        throw new Error("config.powerUserCredentialHash is required for BaFin register");
      }

      // CIP-68 asset names
      const userAssetNameHex = hasCIP68 ? labeledAssetName(333, assetNameHex) : assetNameHex;
      const unit = scripts.tokenPolicyId + userAssetNameHex;
      const refAssetNameHex = hasCIP68 ? labeledAssetName(100, assetNameHex) : null;
      const refUnit = refAssetNameHex ? scripts.tokenPolicyId + refAssetNameHex : null;

      // 1. Find covering registry node
      const registrySpendAddr = scriptAddress(networkId, ctx.standardScripts.registrySpend.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registrySpendAddr));
      const coveringNodeUtxo = findCoveringNode(registryUtxos, scripts.tokenPolicyId);
      if (!coveringNodeUtxo) throw new Error("Could not find covering registry node for insertion");

      const coveringDatum = getInlineDatum(coveringNodeUtxo);
      const coveringKey = extractConstrBytesField(coveringDatum, 0) ?? "";
      const coveringNext = extractConstrBytesField(coveringDatum, 1) ?? MAX_NEXT;

      // 2. Reference inputs
      const protocolParamsUtxo = await findProtocolParamsUtxo(client, networkId, ctx.deployment);
      const issuanceCborHexUtxo = await findIssuanceCborHexUtxo(client, networkId, ctx.deployment);

      // 3. Global state UTxO (SPENT — MintSecurity decrements mintable_amount)
      // Lives at scriptAddress(globalStatePolicyId) — the mint validator enforced this
      const globalStateAddr = scriptAddress(networkId, scripts.globalStatePolicyId);
      const globalStateUtxo = await findGlobalStateUtxo(
        client, networkId, scripts.globalStatePolicyId, scripts.globalStatePolicyId,
      );
      const gsDatum = getInlineDatum(globalStateUtxo);
      if (!gsDatum) throw new Error("GlobalState UTxO has no inline datum");
      const gsData = parseGlobalStateDatum(gsDatum);

      // 4. Power user node (reference input)
      const powerUserUtxo = await findPowerUserNode(
        client, networkId,
        scripts.powerUsersSpend.hash,
        scripts.powerUsersLinkedListPolicyId,
        powerUserCredentialHash,
      );

      // 5. Compute reference input indices (ledger sorts ref inputs)
      // NOTE: config UTxO removed (placeholder empty). configRefIdx set to 0 as unused placeholder.
      const refInputs = [protocolParamsUtxo, issuanceCborHexUtxo, powerUserUtxo];
      const sortedRefInputs = [...refInputs].sort((a, b) => {
        const aHash = a.transactionId.toString();
        const bHash = b.transactionId.toString();
        if (aHash !== bHash) return aHash < bHash ? -1 : 1;
        return Number(a.index) - Number(b.index);
      });
      const configRefIdx = 0; // placeholder — config not used yet
      const powerUserRefIdx = sortedRefInputs.indexOf(powerUserUtxo);

      // 6. Compute input indices (global state is spent as input)
      const inputs = [coveringNodeUtxo, globalStateUtxo];
      const sortedInputs = [...inputs].sort((a, b) => {
        const aHash = a.transactionId.toString();
        const bHash = b.transactionId.toString();
        if (aHash !== bHash) return aHash < bHash ? -1 : 1;
        return Number(a.index) - Number(b.index);
      });
      const globalStateInputIdx = sortedInputs.indexOf(globalStateUtxo);

      // 7. Build datums
      const coveringTransferCred = extractCredentialField(coveringDatum, 2) ?? { type: "key" as const, hash: "" };
      const coveringThirdPartyCred = extractCredentialField(coveringDatum, 3) ?? { type: "key" as const, hash: "" };

      const updatedCoveringDatum = registryNodeDatum({
        key: coveringKey,
        next: scripts.tokenPolicyId,
        transferLogicScript: coveringTransferCred,
        thirdPartyTransferLogicScript: coveringThirdPartyCred,
        globalStateCs: extractConstrBytesField(coveringDatum, 4) ?? "",
      });

      const newRegistryNodeDatum = registryNodeDatum({
        key: scripts.tokenPolicyId,
        next: coveringNext,
        transferLogicScript: { type: "script", hash: scripts.transferLogic.hash },
        thirdPartyTransferLogicScript: { type: "script", hash: scripts.thirdPartyTransferLogic.hash },
        globalStateCs: scripts.globalStatePolicyId,
      });

      // Updated global state: decrement mintable_amount
      const updatedGsDatum = globalStateDatumBuilder(
        gsData.transfersPaused,
        gsData.mintableAmount - quantity,
        gsData.usersLinkedListPolicyId,
        gsData.powerUserLinkedListPolicyId,
        gsData.securityInfo,
      );

      // 8. Compute output indices
      const globalStateOutputIndex = hasCIP68 ? 2 : 1;
      const registryOutputIndex = hasCIP68 ? 4 : 3;

      // 9. Compute issuance redeemer index in self.redeemers
      const issuanceRedeemerIdx = computeIssuanceRedeemerIndex(
        scripts.issuanceMint.hash,
        ctx.standardScripts.registryMint.hash,
      );

      // 10. Build redeemers
      const issuanceRedeemer = issuanceRedeemerFirstMint(scripts.mintingLogic.hash, registryOutputIndex);
      const registryMintRedeemer = registryInsertRedeemer(scripts.issuanceMint.hash, scripts.mintingLogic.hash);
      const gsSpendRedeemer = globalStateSpendRedeemer(configRefIdx, globalStateOutputIndex, issuanceRedeemerIdx);
      const mlRedeemer = mintingLogicRedeemer(configRefIdx, globalStateInputIdx, powerUserRefIdx, quantity);
      const tokenDatum = voidData();

      // 11. Build transaction
      const useChaining = chainedUtxos.length > 0;
      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipient);
      const registryMintPolicyId = ctx.standardScripts.registryMint.hash;

      const mintEntries = new Map<string, bigint>([[unit, quantity]]);
      if (hasCIP68 && refUnit) mintEntries.set(refUnit, 1n);
      const tokenAssets = mintAssetsFromMap(mintEntries);
      const registryNftUnit = registryMintPolicyId + scripts.tokenPolicyId;
      const registryNftAssets = mintAssetsFromMap(new Map([[registryNftUnit, 1n]]));
      const coveringNftUnit = findCoveringNodeNftUnit(coveringNodeUtxo, registryMintPolicyId);

      let tx = client.newTx();

      // Collect from covering node + global state
      tx = tx.collectFrom({ inputs: [coveringNodeUtxo], redeemer: voidData() });
      tx = tx.collectFrom({ inputs: [globalStateUtxo], redeemer: gsSpendRedeemer });

      // Withdraw from minting_logic_script
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(scripts.mintingLogic.hash, "hex"))),
        amount: 0n,
        redeemer: mlRedeemer,
      });

      // Mints
      tx = tx.mintAssets({ assets: tokenAssets, redeemer: issuanceRedeemer });
      tx = tx.mintAssets({ assets: registryNftAssets, redeemer: registryMintRedeemer });

      // Output 0: user tokens
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(1_300_000n, new Map([[unit, quantity]])),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });

      // Output 1 (CIP-68 only): reference token
      if (hasCIP68 && refUnit) {
        const issuerPlbAddr = baseAddress(networkId, plbHash, feePayerAddress);
        const cip68Datum = buildCIP68FTDatum(params.cip68Metadata!);
        tx = tx.payToAddress({
          address: EvoAddress.fromBech32(issuerPlbAddr),
          assets: outputAssets(3_000_000n, new Map([[refUnit, 1n]])),
          datum: new InlineDatum.InlineDatum({ data: cip68Datum }),
        });
      }

      // Output N: updated global state
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(globalStateAddr),
        assets: outputAssets(utxoLovelace(globalStateUtxo), new Map([
          [scripts.globalStatePolicyId + stringToHex("GlobalState"), 1n],
        ])),
        datum: new InlineDatum.InlineDatum({ data: updatedGsDatum }),
      });

      // Output N+1: updated covering node
      const coveringNodeTokenMap = new Map<string, bigint>();
      if (coveringNftUnit) coveringNodeTokenMap.set(coveringNftUnit, 1n);
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registrySpendAddr),
        assets: outputAssets(utxoLovelace(coveringNodeUtxo), coveringNodeTokenMap),
        datum: new InlineDatum.InlineDatum({ data: updatedCoveringDatum }),
      });

      // Output N+2: new registry node
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registrySpendAddr),
        assets: outputAssets(2_000_000n, new Map([[registryNftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: newRegistryNodeDatum }),
      });

      // Reference inputs
      tx = tx.readFrom({ referenceInputs: refInputs });

      // Attach scripts (6 total)
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.registrySpend.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.mintingLogic.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.issuanceMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.registryMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(scripts.globalStateSpend.compiledCode) });

      // Signer: power user
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(powerUserCredentialHash) });

      const built = await buildAndSerialize(
        tx, feePayerAddress, useChaining ? chainedUtxos : undefined, useChaining, customEvaluator,
      );
      return {
        cbor: built.cbor,
        txHash: built.txHash,
        _signBuilder: built._signBuilder,
        tokenPolicyId: scripts.tokenPolicyId,
        metadata: {
          mintingLogicScriptHash: scripts.mintingLogic.hash,
          transferLogicScriptHash: scripts.transferLogic.hash,
          thirdPartyTransferLogicScriptHash: scripts.thirdPartyTransferLogic.hash,
          powerUserCredentialHash,
          ...(hasCIP68 && { cip68Enabled: true, userAssetNameHex, refAssetNameHex }),
        },
      };
    },

    // Stubs
    async mint(_params: MintParams): Promise<UnsignedTx> {
      throw new Error("BaFin substandard: mint() not yet implemented");
    },
    async burn(_params: BurnParams): Promise<UnsignedTx> {
      throw new Error("BaFin substandard: burn() not yet implemented");
    },
    async transfer(_params: TransferParams): Promise<UnsignedTx> {
      throw new Error("BaFin substandard: transfer() not yet implemented");
    },
  };
}

// ---------------------------------------------------------------------------
// Exported helper: addPowerUser
// ---------------------------------------------------------------------------

/**
 * Add a power user to the linked list.
 * Must be called after initCompliance. Requires owner signature.
 */
export async function addPowerUser(opts: {
  client: EvoClient;
  scripts: {
    powerUsersMint: PlutusScript;
    powerUsersSpend: PlutusScript;
    powerUsersLinkedListPolicyId: string;
  };
  networkId: number;
  feePayerAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator?: any;
  ownerCredentialHash: string;
  newPowerUser: {
    credentialHash: HexString;
    isAdmin: boolean;
    canMint: boolean;
    canBurn: boolean;
    canPause: boolean;
    canVerify: boolean;
    canBlacklist: boolean;
    canForceTransfer: boolean;
  };
  chainedUtxos?: EvoUTxO.UTxO[];
}): Promise<UnsignedTx> {
  const { client, scripts: s, networkId, feePayerAddress, ownerCredentialHash, newPowerUser } = opts;
  const chainedUtxos = opts.chainedUtxos ?? [];

  const puSpendAddr = scriptAddress(networkId, s.powerUsersSpend.hash);

  // Find the root/anchor node (for first insertion, it's the root)
  const anchorUtxo = await findLinkedListRoot(
    client, networkId, s.powerUsersSpend.hash, s.powerUsersLinkedListPolicyId,
  );

  // Build node datum
  const puData = powerUserDatum(newPowerUser);
  const nodeDatum = linkedListNodeDatum(puData, null); // null = no next (first/only node)

  // Node NFT unit
  const nodeUnit = s.powerUsersLinkedListPolicyId + LL_NODE_PREFIX_HEX + newPowerUser.credentialHash;

  // Output indices (0 = chain, 1 = updated anchor, 2 = new node)
  const anchorOutputIdx = 1;
  const newNodeOutputIdx = 2;

  // We need to figure out the anchor input index after sorting.
  // For now, since we only have one script input (the anchor), its sorted index
  // among script inputs depends on whether wallet UTxOs sort before it.
  // The redeemer anchor_node_input_index refers to self.inputs (ALL sorted inputs).
  // We'll estimate 0 for now — the anchor is likely the only script input,
  // but wallet inputs may interleave. This may need adjustment at test time.

  // Build redeemers — use index 0 for anchor (will be adjusted)
  const mintRedeemer = addPowerUserRedeemer(
    newPowerUser.credentialHash, 0, anchorOutputIdx, newNodeOutputIdx,
  );

  // Updated anchor datum: root with link pointing to new key
  const updatedAnchorDatum = Data.constr(0n, [
    Data.constr(0n, [Data.constr(0n, [])]),                             // Root { data: void }
    Data.constr(0n, [Data.bytearray(newPowerUser.credentialHash)]),     // Link::Some(new_key)
  ]);

  let tx = client.newTx();

  // Spend anchor node (StateTransition redeemer delegates to mint validator)
  tx = tx.collectFrom({ inputs: [anchorUtxo], redeemer: Data.constr(0n, []) }); // StateTransition = Constr(0, [])

  // Mint node NFT
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(new Map([[nodeUnit, 1n]])),
    redeemer: mintRedeemer,
  });

  // Output 0: chain output
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(feePayerAddress),
    assets: outputAssets(40_000_000n),
  });

  // Output 1: updated anchor (root) node
  const anchorNftUnit = s.powerUsersLinkedListPolicyId + LL_ROOT_KEY;
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(puSpendAddr),
    assets: outputAssets(utxoLovelace(anchorUtxo), new Map([[anchorNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: updatedAnchorDatum }),
  });

  // Output 2: new power user node
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(puSpendAddr),
    assets: outputAssets(2_000_000n, new Map([[nodeUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: nodeDatum }),
  });

  // Attach scripts
  tx = tx.attachScript({ script: buildEvoScript(s.powerUsersMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(s.powerUsersSpend.compiledCode) });

  // Signer: owner
  tx = tx.addSigner({ keyHash: KeyHash.fromHex(ownerCredentialHash) });

  const useChaining = chainedUtxos.length > 0;
  const built = await buildAndSerialize(
    tx, feePayerAddress, useChaining ? chainedUtxos : undefined, useChaining, opts.evaluator,
  );
  return {
    cbor: built.cbor,
    txHash: built.txHash,
    chainAvailable: built.chainAvailable,
    _signBuilder: built._signBuilder,
    metadata: { powerUserNodeUnit: nodeUnit },
  };
}

// ---------------------------------------------------------------------------
// Exported helper: addUser
// ---------------------------------------------------------------------------

/**
 * Add a user to the users linked list.
 * Must be called after a power user exists (with appropriate permissions).
 * Requires power user signature.
 */
export async function addUser(opts: {
  client: EvoClient;
  scripts: {
    usersMint: PlutusScript;
    usersSpend: PlutusScript;
    usersLinkedListPolicyId: string;
    powerUsersSpend: PlutusScript;
    powerUsersLinkedListPolicyId: string;
  };
  networkId: number;
  feePayerAddress: string;
  powerUserCredentialHash: string;
  newUserCredentialHash: HexString;
  isVerified: boolean;
  isBlacklisted: boolean;
  chainedUtxos?: EvoUTxO.UTxO[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator?: any;
}): Promise<UnsignedTx> {
  const { client, scripts: s, networkId, feePayerAddress, powerUserCredentialHash, newUserCredentialHash } = opts;
  const chainedUtxos = opts.chainedUtxos ?? [];

  const usersSpendAddr = scriptAddress(networkId, s.usersSpend.hash);

  // Find the users root/anchor node
  const anchorUtxo = await findLinkedListRoot(
    client, networkId, s.usersSpend.hash, s.usersLinkedListPolicyId,
  );

  // Find power user node (reference input)
  const powerUserUtxo = await findPowerUserNode(
    client, networkId, s.powerUsersSpend.hash, s.powerUsersLinkedListPolicyId, powerUserCredentialHash,
  );

  // Compute power user ref input index
  const refInputs = [powerUserUtxo];
  // Since it's the only ref input, its index is 0
  const puRefIdx = 0;

  // Build user datum
  const uData = userDatum(opts.isVerified, opts.isBlacklisted);
  const nodeDatum = linkedListNodeDatum(uData, null);

  // Node NFT
  const nodeUnit = s.usersLinkedListPolicyId + LL_NODE_PREFIX_HEX + newUserCredentialHash;

  const anchorOutputIdx = 1;
  const newNodeOutputIdx = 2;

  const mintRedeemer = addUserRedeemer(
    newUserCredentialHash, 0, anchorOutputIdx, newNodeOutputIdx, puRefIdx,
  );

  // Updated anchor datum: root with link to new user
  const updatedAnchorDatum = Data.constr(0n, [
    Data.constr(0n, [Data.constr(0n, [])]),
    Data.constr(0n, [Data.bytearray(newUserCredentialHash)]),
  ]);

  let tx = client.newTx();

  // Spend anchor
  tx = tx.collectFrom({ inputs: [anchorUtxo], redeemer: Data.constr(0n, []) });

  // Mint user node NFT
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(new Map([[nodeUnit, 1n]])),
    redeemer: mintRedeemer,
  });

  // Output 0: chain output
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(feePayerAddress),
    assets: outputAssets(40_000_000n),
  });

  // Output 1: updated anchor (root)
  const anchorNftUnit = s.usersLinkedListPolicyId + LL_ROOT_KEY;
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(usersSpendAddr),
    assets: outputAssets(utxoLovelace(anchorUtxo), new Map([[anchorNftUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: updatedAnchorDatum }),
  });

  // Output 2: new user node
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(usersSpendAddr),
    assets: outputAssets(2_000_000n, new Map([[nodeUnit, 1n]])),
    datum: new InlineDatum.InlineDatum({ data: nodeDatum }),
  });

  // Reference input: power user node
  tx = tx.readFrom({ referenceInputs: [powerUserUtxo] });

  // Attach scripts
  tx = tx.attachScript({ script: buildEvoScript(s.usersMint.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(s.usersSpend.compiledCode) });

  // Signer: power user
  tx = tx.addSigner({ keyHash: KeyHash.fromHex(powerUserCredentialHash) });

  const useChaining = chainedUtxos.length > 0;
  const built = await buildAndSerialize(
    tx, feePayerAddress, useChaining ? chainedUtxos : undefined, useChaining, opts.evaluator,
  );
  return {
    cbor: built.cbor,
    txHash: built.txHash,
    chainAvailable: built.chainAvailable,
    _signBuilder: built._signBuilder,
    metadata: { userNodeUnit: nodeUnit },
  };
}
