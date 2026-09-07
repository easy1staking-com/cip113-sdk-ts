/**
 * CIP-113 Programmable Tokens SDK
 *
 * @example
 * ```ts
 * import { CIP113, evoClient, preprodChain } from '@easy1staking/cip113-sdk-ts';
 * import { dummySubstandard } from '@easy1staking/cip113-sdk-ts/dummy';
 * import { freezeAndSeizeSubstandard } from '@easy1staking/cip113-sdk-ts/freeze-and-seize';
 *
 * // Create Evolution SDK client
 * const client = evoClient(preprodChain)
 *   .withBlockfrost({ projectId: '...', baseUrl: 'https://cardano-preprod.blockfrost.io/api/v0' })
 *   .withSeed({ mnemonic: 'your 24 word seed phrase' });
 *
 * const protocol = CIP113.init({
 *   client,
 *   standard: { blueprint: standardBlueprint, deployment: deploymentParams },
 *   substandards: [dummySubstandard({ blueprint: dummyBlueprint })],
 * });
 *
 * const tx = await protocol.register('freeze-and-seize', { ... });
 * ```
 */

import type { DeploymentParams, PlutusBlueprint, PolicyId } from "./types.js";
import type {
  EvoClient,
  SubstandardPlugin,
  RegisterParams,
  MintParams,
  BurnParams,
  TransferParams,
  ThirdPartyTransferParams,
  FreezeParams,
  UnfreezeParams,
  SeizeParams,
  InitComplianceParams,
  UnsignedTx,
} from "./substandards/interface.js";
import { validateStandardBlueprint } from "./standard/blueprint.js";
import { buildDeploymentScripts, type ResolvedStandardScripts } from "./standard/scripts.js";

// ---------------------------------------------------------------------------
// Init configuration
// ---------------------------------------------------------------------------

export interface CIP113Config {
  /** Evolution SDK client (ReadOnlyClient or SigningClient) */
  client: EvoClient;

  /** Standard protocol configuration */
  standard: {
    blueprint: PlutusBlueprint;
    deployment: DeploymentParams;
  };

  /** Substandard plugins to register */
  substandards?: SubstandardPlugin[];

  /** Check if a stake address is registered on-chain. Used by compliance init to avoid re-registering. */
  checkStakeRegistration?: (stakeAddress: string) => Promise<boolean>;

  /**
   * Optional transaction evaluator, passed through to substandards.
   *
   * Without one the client's default provider evaluates, and Kupmios reports a
   * bare "evaluateTx failed" naming neither the script nor the reason. An Ogmios
   * evaluator returns the validator's trace list instead.
   */
  evaluator?: unknown;
}

// ---------------------------------------------------------------------------
// Protocol instance
// ---------------------------------------------------------------------------

export interface CIP113Protocol {
  /** The resolved standard scripts (cached, reusable) */
  readonly scripts: ResolvedStandardScripts;

  /** The deployment parameters */
  readonly deployment: DeploymentParams;

  /** The Evolution SDK client */
  readonly client: EvoClient;

  // -- Operations (delegated to substandards) --

  /** Register a new programmable token */
  register(substandardId: string, params: RegisterParams): Promise<UnsignedTx>;

  /** Mint additional tokens */
  mint(params: MintParams): Promise<UnsignedTx>;

  /** Burn tokens */
  burn(params: BurnParams): Promise<UnsignedTx>;

  /** Transfer tokens */
  transfer(params: TransferParams): Promise<UnsignedTx>;

  /**
   * Administrative transfer: move a holder's tokens without their signature.
   *
   * Requires an explicit `substandardId` — unlike mint/burn/transfer there is no
   * try-all fallback here. Guessing which substandard should be allowed to seize
   * someone's tokens is not a convenience worth having.
   */
  thirdPartyTransfer(params: ThirdPartyTransferParams): Promise<UnsignedTx>;

  // -- Compliance operations --

  compliance: {
    /** Initialize compliance infrastructure (e.g., blacklist) */
    init(substandardId: string, params: InitComplianceParams): Promise<UnsignedTx>;

    /** Freeze an address */
    freeze(params: FreezeParams): Promise<UnsignedTx>;

    /** Unfreeze an address */
    unfreeze(params: UnfreezeParams): Promise<UnsignedTx>;

    /** Seize tokens */
    seize(params: SeizeParams): Promise<UnsignedTx>;
  };

  // -- Runtime extensibility --

  /** Register a new substandard plugin at runtime */
  registerSubstandard(plugin: SubstandardPlugin): void;

  /** Get a registered substandard by ID */
  getSubstandard(id: string): SubstandardPlugin | undefined;

  /** List all registered substandard IDs */
  listSubstandards(): string[];
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export const CIP113 = {
  /**
   * Initialize a CIP-113 protocol instance.
   *
   * This validates the standard blueprint, parameterizes all standard scripts,
   * and initializes registered substandards.
   */
  init(config: CIP113Config): CIP113Protocol {
    // Validate standard blueprint has all required validators
    validateStandardBlueprint(config.standard.blueprint);

    // Build parameterized standard scripts (uses Evolution SDK directly)
    const scripts = buildDeploymentScripts(
      config.standard.blueprint,
      config.standard.deployment,
    );

    // Registry of substandard plugins
    const substandards = new Map<string, SubstandardPlugin>();

    // Build the substandard context
    const substandardContext: import("./substandards/interface.js").SubstandardContext = {
      client: config.client,
      standardScripts: scripts,
      deployment: config.standard.deployment,
      evaluator: config.evaluator,
      network: config.client.chain.id === 1 ? "mainnet" : "preprod",
      checkStakeRegistration: config.checkStakeRegistration,
    };

    // Initialize and register provided substandards
    if (config.substandards) {
      for (const plugin of config.substandards) {
        plugin.init(substandardContext);
        substandards.set(plugin.id, plugin);
      }
    }

    // Helper: try all substandards
    async function tryAllSubstandards(
      operation: string,
      policyId: string,
      fn: (plugin: SubstandardPlugin) => Promise<UnsignedTx>
    ): Promise<UnsignedTx> {
      let lastError: unknown;
      for (const plugin of substandards.values()) {
        try {
          return await fn(plugin);
        } catch (e) {
          lastError = e;
          continue;
        }
      }
      throw new Error(
        `No substandard can handle ${operation} for policy ${policyId}. ` +
        `Available: [${[...substandards.keys()].join(", ")}]. ` +
        `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
        `Hint: pass substandardId to route directly.`
      );
    }

    function requireSubstandard(id: string): SubstandardPlugin {
      const plugin = substandards.get(id);
      if (!plugin) {
        throw new Error(
          `Substandard "${id}" not registered. Available: ${[...substandards.keys()].join(", ")}`
        );
      }
      return plugin;
    }

    return {
      scripts,
      deployment: config.standard.deployment,
      client: config.client,

      async register(substandardId, params) {
        return requireSubstandard(substandardId).register(params);
      },

      async thirdPartyTransfer(params) {
        if (!params.substandardId) {
          throw new Error(
            "thirdPartyTransfer requires an explicit substandardId. There is deliberately no " +
              "try-all fallback: this operation moves someone else's tokens without their " +
              "signature, and selecting the authority by trial is not acceptable for that."
          );
        }
        const plugin = requireSubstandard(params.substandardId);
        if (!plugin.thirdPartyTransfer) {
          throw new Error(
            `Substandard "${params.substandardId}" does not support third-party transfers. ` +
              `Implementing it is a claim that the substandard has an administrative authority ` +
              `and has wired its registry node's third_party_transfer_logic_script accordingly.`
          );
        }
        return plugin.thirdPartyTransfer(params);
      },

      async mint(params) {
        if (params.substandardId) {
          return requireSubstandard(params.substandardId).mint(params);
        }
        return tryAllSubstandards("mint", params.tokenPolicyId, (p) => p.mint(params));
      },

      async burn(params) {
        if (params.substandardId) {
          return requireSubstandard(params.substandardId).burn(params);
        }
        return tryAllSubstandards("burn", params.tokenPolicyId, (p) => p.burn(params));
      },

      async transfer(params) {
        if (params.substandardId) {
          return requireSubstandard(params.substandardId).transfer(params);
        }
        return tryAllSubstandards("transfer", params.tokenPolicyId, (p) => p.transfer(params));
      },

      compliance: {
        async init(substandardId, params) {
          const plugin = requireSubstandard(substandardId);
          if (!plugin.initCompliance) {
            throw new Error(`Substandard "${substandardId}" does not support compliance initialization`);
          }
          return plugin.initCompliance(params);
        },

        async freeze(params) {
          // Explicit routing, NO try-all. Two reasons, and the second is the one
          // that cost time: an administrative operation must not pick its own
          // authority by trial; and a fallback CONVERTS A REAL VALIDATOR FAILURE
          // INTO "no substandard can handle this", which is a different category
          // of fault and sends the reader somewhere else entirely.
          const plugin = requireSubstandard(params.substandardId);
          if (!plugin.freeze) {
            throw new Error(
              `Substandard "${params.substandardId}" does not support freeze.`
            );
          }
          return plugin.freeze(params);
        },

        async unfreeze(params) {
          // Explicit routing, NO try-all. Two reasons, and the second is the one
          // that cost time: an administrative operation must not pick its own
          // authority by trial; and a fallback CONVERTS A REAL VALIDATOR FAILURE
          // INTO "no substandard can handle this", which is a different category
          // of fault and sends the reader somewhere else entirely.
          const plugin = requireSubstandard(params.substandardId);
          if (!plugin.unfreeze) {
            throw new Error(
              `Substandard "${params.substandardId}" does not support unfreeze.`
            );
          }
          return plugin.unfreeze(params);
        },

        async seize(params) {
          // Explicit routing, NO try-all. Two reasons, and the second is the one
          // that cost time: an administrative operation must not pick its own
          // authority by trial; and a fallback CONVERTS A REAL VALIDATOR FAILURE
          // INTO "no substandard can handle this", which is a different category
          // of fault and sends the reader somewhere else entirely.
          const plugin = requireSubstandard(params.substandardId);
          if (!plugin.seize) {
            throw new Error(
              `Substandard "${params.substandardId}" does not support seize.`
            );
          }
          return plugin.seize(params);
        },
      },

      registerSubstandard(plugin) {
        plugin.init(substandardContext);
        substandards.set(plugin.id, plugin);
      },

      getSubstandard(id) {
        return substandards.get(id);
      },

      listSubstandards() {
        return [...substandards.keys()];
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  EvoClient,
  SubstandardPlugin,
  SubstandardFactory,
  SubstandardContext,
  RegisterParams,
  MintParams,
  BurnParams,
  TransferParams,
  FreezeParams,
  UnfreezeParams,
  SeizeParams,
  InitComplianceParams,
  UnsignedTx,
  CIP68MetadataInput,
} from "./substandards/interface.js";
export type {
  DeploymentParams,
  PlutusBlueprint,
  PlutusScript,
  TxInput,
  UTxO,
  Network,
  PolicyId,
  ScriptHash,
  HexString,
  Assets,
} from "./types.js";
export {
  buildEvoScript,
  computeScriptHash,
  parameterizeScript,
  scriptAddress,
  rewardAddress,
  rewardAddressFromKeyHash,
  baseAddress,
  stakingCredentialHash,
  paymentCredentialHash,
  getInlineDatum,
  REGISTRY_NODE_MIN_ADA,
  // min-UTxO computed from live protocol parameters. Public because a consumer
  // building its own outputs against this protocol needs the same arithmetic,
  // and because a flat constant is wrong for any output whose size the caller
  // controls — see the block comment on minUtxoForOutput.
  minUtxoForOutput,
  minUtxoAtLeast,
  ceilToWholeAda,
  stringToHex,
  MAX_NEXT,
  voidData,
  outputReference,
  scriptCredential,
  keyCredential,
  labeledAssetName,
  stripCIP67Label,
  hasCIP67Label,
  buildCIP68FTDatum,
} from "./core/evo-utils.js";
export { sortTxInputs, findRefInputIndex } from "./core/registry.js";
export { mintAssetsFromMap, outputAssets } from "./core/evo-utils.js";
export {
  registryNodeDatum,
  decodeRegistryNode,
  registryInitRedeemer,
  registryInsertRedeemer,
  mintingProofRefInput,
  mintingProofOutputIndex,
  protocolParamsDatum,
  decodeProtocolParams,
} from "./core/evo-utils.js";
export type {
  RegistryNodeData,
  ProtocolParamsData,
  Cip113Credential,
} from "./core/evo-utils.js";
export {
  assertDeploymentScripts,
  DeploymentMismatchError,
  createStandardScripts,
  type ScriptHashCheck,
  type StandardScripts,
} from "./standard/scripts.js";
export {
  CIP171_METADATA_LABEL,
  CIP171_MAX_CHUNK_BYTES,
  CompilerType,
  buildCip171PlutusData,
  buildCip171Metadatum,
  chunkBytes,
  decodeCip171Metadatum,
  decodeCip171PlutusData,
  // Serialises one PlutusData parameter to the bytestring-wrapped hex the
  // format requires. Cip171ScriptEntry's own docs direct callers here, so it
  // was public API in intent already.
  cip171Param,
} from "./core/cip171.js";

// Provenance: assemble a CIP-171 record from a bundled blueprint's pin.
// Import the pin itself as JSON via the "./blueprints/*" export path — a
// consumer that COPIES the repo/commit/compiler triple instead gets a second
// copy that drifts silently and still verifies.
export {
  provenanceFromPin,
  buildCip171RecordFromPin,
} from "./core/provenance.js";
export type { UpstreamPin, ParameterizedScript } from "./core/provenance.js";
export type {
  Cip171Record,
  Cip171ScriptEntry,
} from "./core/cip171.js";
export { addressHexToBech32 } from "./provider/address-utils.js";
export { assembleSignedTx } from "./provider/tx-utils.js";
export type { FESDeploymentParams } from "./substandards/freeze-and-seize/types.js";

// Re-export Evolution SDK essentials so consumers don't need a direct dependency
export {
  preview as previewChain,
  preprod as preprodChain,
  mainnet as mainnetChain,
  Address as EvoAddress,
  Assets as EvoAssets,
  TransactionHash as EvoTransactionHash,
  Transaction as EvoTransaction,
  TransactionWitnessSet as EvoTransactionWitnessSet,
  Data as EvoData,
} from "@evolution-sdk/evolution";

// Re-export Client.make as evoClient for convenience
import { Client } from "@evolution-sdk/evolution";
export const evoClient = Client.make;

// ---------------------------------------------------------------------------
// Ledger ordering and 0.5.x redeemers (T-D04)
// ---------------------------------------------------------------------------

export {
  compareTxInputs,
  referenceInputIndexOf,
  compareWithdrawalKeys,
  sortWithdrawalKeys,
  withdrawalIndexOf,
  PlgAct,
  programmableLogicGlobalRedeemer,
  baseSpendRedeemer,
  transferRedeemer,
  thirdPartyRedeemer,
  unfrackingRedeemer,
} from "./core/ledger-order.js";
export type { WithdrawalKey, PlgActVariant, RegistryProofRef } from "./core/ledger-order.js";
