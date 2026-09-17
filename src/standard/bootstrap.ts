/**
 * Protocol bootstrap — the transactions that stand up a CIP-113 instance.
 *
 * TARGETS CIP-113 0.5.0-alpha.4 (upstream 7e8a63198c5b240135f1aa2f043ce5d7c046b2c4).
 *
 * ⚑ WHY THIS IS EXPORTED AT ALL. Until 2026-09-17 this sequence lived only in
 * `test/harness/bootstrap.ts`, which `files: ["dist","blueprints"]` does not
 * ship — so the platform maintained ITS OWN PORT of a protocol-critical
 * sequence. That port had already diverged (it reserves the seed UTxOs from
 * coin selection where the harness did not) and the divergence was CORRECT.
 * Two implementations, one right and the other not yet wrong, is worse than one
 * supported export. See CLAUDE.md, "Protocol bootstrap — AMENDED 2026-09-17",
 * and `design/bootstrap-export.md` for the step boundaries and their reasons.
 *
 * ⛔ WHAT THIS MODULE DOES NOT DO, AND WILL NOT. It does not sign, submit, await,
 * poll, fund, retry, or hold a key. It builds unsigned transactions and returns
 * them. Orchestration is the caller's, and that is not a gap — it is what lets
 * the platform keep its own UTxO reservation and its own confirmation strategy.
 *
 * ⛔ AND IT SHIPS NO FIXTURE VALUES. No mnemonic, no endpoint, no nonce, no
 * security parameter, no placeholder policy id, no `any`. A value the caller
 * must decide is a REQUIRED INPUT, never a default. That rule is the whole
 * reason this export is safe to make: everything the devnet fixture chose for
 * itself is now something its CALL passes in.
 *
 * ---------------------------------------------------------------------------
 * THE SEQUENCE IS DEPENDENT, SO THE EXPORT IS STEPWISE
 * ---------------------------------------------------------------------------
 *
 * The one-shot minting policies are parameterised by SPECIFIC OUTPUT REFERENCES
 * of an earlier transaction, so step N+1 cannot be built until step N has been
 * submitted and its outputs observed. There is no "give me five transactions"
 * shape available; asking for one would mean signing, and signing is out.
 *
 *   1  buildSeedTx                  -> three distinct seed UTxOs
 *   2  buildMultisigGenesisTx       -> the upgrade authority's config UTxO
 *   3  buildProtocolGenesisTx       -> params, registry origin, issuance CBOR
 *   4  buildReferenceScriptsTx      -> the seven reference scripts
 *   5  buildStakeRegistrationTx     -> the six withdraw-0 registrations
 *      assembleDeploymentParams     -> DeploymentParams (pure)
 *
 * ⚑ RESUMPTION. `planBootstrap(config)` is pure and deterministic: persist the
 * CONFIG and every hash, address, datum and asset unit can be re-derived on any
 * machine with no chain access. No step needs an earlier step's CONSUMED
 * inputs, which is the property that makes resuming at step N work at all — by
 * the time you resume at step 4 the seeds are spent and unfetchable.
 */

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Bytes,
  Credential,
  Data,
  InlineDatum,
  Transaction as EvoTransaction,
  TransactionHash as EvoTransactionHash,
  UPLC,
} from "@evolution-sdk/evolution";
import type {
  BuildOptions,
  Evaluator,
  ReadOnlyTransactionBuilder,
  SigningTransactionBuilder,
} from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import type { SignBuilder } from "@evolution-sdk/evolution/sdk/builders/SignBuilder";
import type { TransactionResultBase } from "@evolution-sdk/evolution/sdk/builders/TransactionResult";

import type {
  Address,
  DeploymentParams,
  HexString,
  PlutusBlueprint,
  PlutusData,
  PlutusScript,
  PolicyId,
  ScriptHash,
  TxHash,
  TxInput,
  UTxO,
} from "../types.js";
import type { EvoClient, UnsignedTx } from "../substandards/interface.js";
import type { UpstreamPin } from "../core/provenance.js";
import type { MultisigScriptTree } from "../core/evo-utils.js";
import { buildCip171RecordFromPin } from "../core/provenance.js";
import { buildCip171Metadatum, CIP171_METADATA_LABEL } from "../core/cip171.js";
import {
  buildEvoScript,
  ceilToWholeAda,
  decodeMultisigScript,
  getInlineDatum,
  mintAssetsFromMap,
  minUtxoAtLeast,
  minUtxoForOutput,
  multisigScriptDatum,
  outputAssets,
  protocolParamsDatum,
  registryInitRedeemer,
  registryNodeDatum,
  REGISTRY_NODE_MIN_ADA,
  scriptAddress,
  stringToHex,
  voidData,
} from "../core/evo-utils.js";
import { STANDARD_VALIDATORS, validateStandardBlueprint } from "./blueprint.js";
import {
  createStandardScripts,
  UNFRACKING_DISABLED,
  type ParameterizationEvent,
} from "./scripts.js";

// ---------------------------------------------------------------------------
// Constants that are PROTOCOL FACTS, not caller choices
// ---------------------------------------------------------------------------

/**
 * Three seed UTxOs, and the count is not negotiable.
 *
 * utxo1 -> protocol_params AND registry, utxo2 -> issuance_cbor_hex_mint,
 * utxo3 -> upgrade_multisig.
 *
 * ⛔ THREE DISTINCT ONES, NOT ONE REUSED. Reusing utxo1 for upgrade_multisig
 * deploys perfectly well — a one-shot outref is consumed once, and the two
 * policies consume it in different transactions, so nothing on chain objects.
 * The reason it must be distinct is OFF chain: `DeploymentParams` carries TWO
 * same-typed one-shot outrefs, `protocolParams.txInput` and
 * `upgradeMultisig.txInput`, and `assertDeploymentScripts` derives a hash from
 * each. A record that gives them ONE value makes the upgrade_multisig check
 * pass whichever field the code reads, so the check cannot fail and a real
 * defect in which field is read is invisible. That is not hypothetical: it hid
 * a wrong derivation for an entire migration once already.
 */
export const BOOTSTRAP_SEED_COUNT = 3;

/**
 * The reference-script publication order, which is ONE FACT WRITTEN ONCE.
 *
 * ⛔ APPENDED, NEVER INSERTED. `buildReferenceScriptsTx` pays them in this
 * order and `assembleDeploymentParams` derives every `…RefInput` index from the
 * same array. alpha.3 inserted the dispatcher at index 1 and shifted all three
 * delegates down — and a mismatch here does not fail loudly. It hands out a
 * reference input carrying the WRONG script, and the transaction dies at
 * evaluation naming neither.
 *
 * ⛔ AND APPENDING IS NOT FREE — THERE IS A CAP AND THIS LIST IS NEAR IT (F-9).
 * MEASURED on devnet, 2026-09-17: the transaction publishing these seven comes
 * to **12,496 bytes against a 16,384-byte protocol maximum — 76%**. Two more
 * scripts of the size already here would burst it, and the failure arrives at
 * SUBMISSION rather than at build. This is the same cap that forced the
 * mint/publish/register split in the first place: the 0.3.x single-transaction
 * fixture measured 21,816 bytes. `buildReferenceScriptsTx` now refuses over the
 * chain's own `maxTxSize` rather than letting the ledger say it; when that
 * refusal fires, the answer is a SECOND publish transaction and a second
 * recorded tx hash, not a shorter list.
 */
export const REFERENCE_SCRIPT_ORDER = [
  "programmableLogicBase",
  "programmableLogicGlobal",
  "transfer",
  "thirdParty",
  "unfracking",
  "issuanceLogic",
  "upgradeMultisig",
] as const;

export type ReferenceScriptName = (typeof REFERENCE_SCRIPT_ORDER)[number];

/**
 * The six withdraw-0 credentials a bootstrap must register.
 *
 * ⛔ SIX, AND EVERY OMISSION IS UNDIAGNOSABLE. An unregistered stake credential
 * does not fail with "not registered": the ledger answers code 3141, "rewards
 * withdrawals must consume rewards in full", which reads as a balance problem
 * and sends the reader to the wrong subsystem entirely. MEASURED on devnet —
 * every programmable operation failed that way until the dispatcher joined this
 * list, and `issuance_logic` rides EVERY mint and EVERY burn.
 */
export const STAKE_REGISTRATION_ORDER = [
  "programmableLogicGlobal",
  "transfer",
  "thirdParty",
  "unfracking",
  "issuanceLogic",
  "upgradeMultisig",
] as const;

export type StakeCredentialName = (typeof STAKE_REGISTRATION_ORDER)[number];

/** The five steps, in order. Exported so a caller can name where it resumed. */
export const BOOTSTRAP_STEPS = [
  "seed",
  "multisig-genesis",
  "protocol-genesis",
  "reference-scripts",
  "stake-registrations",
] as const;

export type BootstrapStepId = (typeof BOOTSTRAP_STEPS)[number];

/**
 * A FLOOR for solved min-UTxO amounts, not a chosen output size.
 *
 * ⚠ Every datum-bearing output below is SOLVED with `minUtxoAtLeast`, never set
 * flat: min-UTxO scales with serialised output size, and Evolution does NOT
 * rescue an under-funded `payToAddress`. The shortfall survives to submission
 * and is reported as "insufficient Ada", which sends the reader to the wallet
 * balance rather than to the datum that grew. The floor only keeps the figure
 * monotone against what this package already emitted; the solved value governs.
 */
const MIN_UTXO_FLOOR = 2_000_000n;

/**
 * Solve min-UTxO for a genesis output, then ROUND UP TO A WHOLE ADA.
 *
 * ⛔ THE ROUNDING IS DELIBERATE AND IT IS NOT TIDINESS (F-7). `minUtxoAtLeast`
 * returns the EXACT minimum, and its own docstring promises only that the
 * figure "only ever rises" relative to what this package used to emit — it
 * makes no promise about the ENCODER. The figure is
 * `coinsPerUtxoByte × (160 + serialised output size)`, and the serialised size
 * comes from Evolution's `TxOut` encoder, which this package does not own.
 *
 * ⚠ THE FAILURE THAT BUYS: a one-byte widening in that encoder — a version
 * bump, a CBOR canonicalisation change — under-funds an output by
 * `coinsPerUtxoByte` lovelace. Evolution does NOT rescue an under-funded
 * `payToAddress`: the shortfall survives to submission and the ledger rejects
 * it as "insufficient Ada", which sends the reader to the wallet balance. On
 * the protocol genesis that rejection lands on an IRREVERSIBLE step, after the
 * multisig config UTxO already exists on chain.
 *
 * ⇒ A whole-ADA ceiling is a RULE, not a guessed constant, and at
 * `coinsPerUtxoByte` 4310 it absorbs on the order of a hundred bytes of encoder
 * drift on the largest output here. It is still an order of magnitude below the
 * flat 15 ADA this sequence used to write.
 */
function genesisOutputLovelace(params: Parameters<typeof minUtxoForOutput>[0]): bigint {
  return ceilToWholeAda(minUtxoAtLeast(MIN_UTXO_FLOOR, params));
}

/**
 * The lowest lovelace an output of this shape can legally carry — a FLOOR to
 * refuse below, never a sufficiency check.
 *
 * ⚠ Clearing min-UTxO is necessary and not sufficient: a seed output also has
 * to fund the fee of the transaction that consumes it, and this says nothing
 * about that.
 */
function minLovelaceForPlainOutput(address: Address, coinsPerUtxoByte: bigint): bigint {
  return minUtxoForOutput({ address, assets: outputAssets(0n), coinsPerUtxoByte });
}

/**
 * The 28-byte marker `issuance_mint` is parameterised against so the stored
 * CBOR can be cut either side of its minting-logic argument.
 *
 * ⛔ NOT A PARAMETER, NOT A DEFAULT, AND NEVER DEPLOYED. It is applied and
 * immediately cut back out; what reaches the chain is `pre` and `post` with the
 * marker gone from between them, so that a later registration can splice a REAL
 * minting-logic hash in without re-deriving the script. Passing this value
 * anywhere a minting-logic hash is expected would produce a policy nobody can
 * mint under — it is a cutting guide, not an identifier.
 *
 * ⚑ EXPORTED SO THE OCCURRENCE GUARD CAN BE EXERCISED, and for no other reason.
 * `splitParts.length !== 2` below is the entire reason shipping a fixed hex
 * marker is tolerable — and an unmutated guard is a claim rather than a check.
 * A test cannot construct a body that collides with a marker it cannot see, so
 * the marker is visible. (MEASURED: the `pre`/`post` halves do not depend on
 * this VALUE — two different markers yield byte-identical halves, because the
 * argument occupies the same bit positions either way.)
 */
export const ISSUANCE_SPLICE_MARKER =
  "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef";

/**
 * The three withdraw-0 delegates whose registration runs a `publish` handler.
 *
 * Registering emits a Conway RegCert, which executes the script under the
 * PUBLISH purpose — so each needs a publish handler or the transaction dies at
 * evaluation with a bare "machine terminated" and an EMPTY trace list. The
 * check is kept because the failure it diagnoses is undiagnosable without it.
 */
const REQUIRED_PUBLISH_HANDLERS = [
  "transfer.transfer.publish",
  "third_party.third_party.publish",
  "unfracking.unfracking.publish",
] as const;

// ---------------------------------------------------------------------------
// Configuration — every value the caller must decide
// ---------------------------------------------------------------------------

/** The three one-shot seed output references, by the role each plays. */
export interface BootstrapSeeds {
  /** Parameterises `protocol_params` AND `registry`. Consumed by the protocol genesis. */
  readonly protocolParams: TxInput;
  /** Parameterises `issuance_cbor_hex_mint`. Consumed by the protocol genesis. */
  readonly issuance: TxInput;
  /** Parameterises `upgrade_multisig`. Consumed by the multisig genesis. */
  readonly upgradeMultisig: TxInput;
}

/** The same three, resolved to the UTxOs a transaction can actually spend. */
export interface BootstrapSeedUtxos {
  readonly protocolParams: UTxO;
  readonly issuance: UTxO;
  readonly upgradeMultisig: UTxO;
}

/**
 * Whether this deployment's dispatcher can reach `unfracking`.
 *
 * ⚠ A CHOICE HERE, A VALUE IN THE RECORD, AND THE ASYMMETRY IS DELIBERATE.
 * `DeploymentParams.programmableLogicGlobal.unfrackingParameter` must be a
 * VALUE — a deployment file opened in three years has to say what the
 * dispatcher was compiled from without needing a version of this SDK to
 * interpret a boolean. But at bootstrap time the "enabled" value IS the
 * `unfracking` script's own hash, which does not exist until the plan derives
 * it, so a choice is the only thing a caller can express. `planBootstrap`
 * resolves the choice into the value and `assembleDeploymentParams` records it.
 *
 * ⛔ Two deployments differing ONLY here are DIFFERENT PROTOCOLS: the parameter
 * is baked into the dispatcher's hash. There is no default.
 */
export type UnfrackingChoice = "enabled" | "disabled";

/**
 * Everything needed to derive a protocol instance — and nothing that needs a
 * network, a key or a clock.
 *
 * ⚑ THIS IS THE RESUME TOKEN. Persist it and `planBootstrap` re-derives every
 * script, address, datum and asset unit byte-identically, offline.
 *
 * ⛔ IT IS NOT `JSON.stringify`-ABLE AS IT STANDS, AND THE FAILURE IS LOUD
 * RATHER THAN SILENT (F-8): `maxInlineDatumBytes` is a `bigint`, and
 * `JSON.stringify` THROWS `TypeError: Do not know how to serialize a BigInt`
 * on it. Persist it with that one field converted — `String(...)` on the way
 * out, `BigInt(...)` on the way back — and never with `Number(...)`, which
 * would make a security parameter depend on a lossy round trip. The blueprint
 * is ordinary JSON and needs no special handling.
 */
export interface BootstrapConfig {
  /** The standard blueprint this instance is built from. */
  readonly blueprint: PlutusBlueprint;
  /** 0 for any testnet, 1 for mainnet. Determines every derived address. */
  readonly networkId: number;
  /** The three one-shot output references. */
  readonly seeds: BootstrapSeeds;
  /**
   * `always_fail`'s nonce — REQUIRED, with no default and no generator.
   *
   * ⛔ THE CHOICE IS THE CALLER'S AND MUST STAY SO. A fixed nonce makes a
   * rebuild against the same chain reproduce the same hashes, which is what a
   * devnet fixture wants and what a production deployment usually does not. A
   * value shipped here would be a value every deployment in the world shared.
   */
  readonly alwaysFailNonce: HexString;
  /**
   * `max_inline_datum_bytes` — REQUIRED. A SECURITY PARAMETER with no upstream
   * guidance, and a compile-time parameter of all four delegates, so it is
   * baked into their hashes.
   *
   * ⛔ THIS PACKAGE DELIBERATELY SHIPS NO VALUE FOR IT. The devnet fixture uses
   * 1024n because that is what upstream's own test fixtures use; its own
   * comment records that this is NOT a recommendation and that the production
   * value is deferred. Defaulting it here would turn one fixture's convenience
   * into everyone's security posture.
   */
  readonly maxInlineDatumBytes: bigint;
  /** Whether the dispatcher is compiled against `unfracking` or the sentinel. */
  readonly unfracking: UnfrackingChoice;
}

// ---------------------------------------------------------------------------
// The plan — pure, deterministic, offline
// ---------------------------------------------------------------------------

/** Every script this deployment derives, by the name the rest of the SDK uses. */
export interface BootstrapScripts {
  readonly alwaysFail: PlutusScript;
  readonly protocolParams: PlutusScript;
  readonly programmableLogicBase: PlutusScript;
  readonly issuanceCborHexMint: PlutusScript;
  readonly registry: PlutusScript;
  readonly transfer: PlutusScript;
  readonly thirdParty: PlutusScript;
  readonly unfracking: PlutusScript;
  readonly programmableLogicGlobal: PlutusScript;
  readonly issuanceLogic: PlutusScript;
  readonly upgradeMultisig: PlutusScript;
}

/**
 * A fully derived protocol instance, before a single byte reaches a chain.
 *
 * Every field is a function of {@link BootstrapConfig} alone. Nothing here was
 * read from a network and nothing here can disagree with what gets deployed —
 * the build steps and `assembleDeploymentParams` both read THIS.
 */
export interface BootstrapPlan {
  readonly config: BootstrapConfig;
  readonly scripts: BootstrapScripts;
  /** The resolved dispatcher parameter: the real hash, or `UNFRACKING_DISABLED`. */
  readonly unfrackingParameter: ScriptHash;
  readonly addresses: {
    /** policy id == address payment credential. One value, one derivation. */
    readonly protocolParams: Address;
    /** Same collapse: node NFT policy AND node address. */
    readonly registry: Address;
    /** `always_fail`'s address — where the issuance CBOR UTxO is locked. */
    readonly issuanceCborHex: Address;
    /** The multisig config UTxO's address. */
    readonly upgradeMultisig: Address;
  };
  readonly assetUnits: {
    readonly protocolParamsNft: HexString;
    /** The registry origin node's NFT — empty asset name, so the unit IS the policy. */
    readonly registryNode: HexString;
    readonly issuanceCborHexNft: HexString;
    readonly upgradeMultisigNft: HexString;
  };
  readonly datums: {
    readonly protocolParams: PlutusData;
    readonly registryOrigin: PlutusData;
    readonly issuanceCborHex: PlutusData;
  };
  /** The issuance_mint body either side of the minting-logic hash. */
  readonly issuanceCbor: { readonly pre: HexString; readonly post: HexString };
  /** The seven scripts of {@link REFERENCE_SCRIPT_ORDER}, in that order. */
  readonly referenceScripts: readonly PlutusScript[];
  /** The six scripts of {@link STAKE_REGISTRATION_ORDER}, in that order. */
  readonly stakeCredentialScripts: readonly PlutusScript[];
  /**
   * Every parameterisation this plan performed, EXCLUDING `issuance_mint`.
   *
   * DERIVED, NEVER TRANSCRIBED — the unapplied hash and the application-order
   * arguments are properties of the calls that made them and of nothing else.
   * Feed to `buildCip171RecordFromPin`.
   *
   * ⚠ `issuance_mint` is excluded for a SEMANTIC reason, not a convenient one:
   * it is parameterised PER MINTING-LOGIC HASH, once per substandard, so the
   * instance derived here belongs to whichever substandard registers a token —
   * not to the core deployment. Recording it here would name a script this
   * deployment does not run.
   */
  readonly parameterizations: readonly { rawScriptHash: HexString; params: PlutusData[] }[];
}

// ---------------------------------------------------------------------------
// Required-input refusals — by name, and before anything is derived
// ---------------------------------------------------------------------------

function requireHex(value: unknown, field: string, bytes?: number): HexString {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `bootstrap: ${field} is required and must be a non-empty hex string, got ` +
        `${value === undefined ? "undefined" : JSON.stringify(value)}. This SDK ships no ` +
        `default for it — it is a value the caller must decide.`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(
      `bootstrap: ${field} must be an even-length hex string with no 0x prefix, got ` +
        `${JSON.stringify(value)}.`
    );
  }
  if (bytes !== undefined && value.length !== bytes * 2) {
    throw new Error(
      `bootstrap: ${field} must be exactly ${bytes} bytes (${bytes * 2} hex chars), got ` +
        `${value.length / 2}.`
    );
  }
  return value;
}

function requireTxInput(value: unknown, field: string): TxInput {
  const ref = value as TxInput | undefined;
  if (!ref || typeof ref !== "object") {
    throw new Error(
      `bootstrap: ${field} is required — a { txHash, outputIndex } naming the one-shot UTxO ` +
        `this policy is parameterised by. Got ${JSON.stringify(value)}.`
    );
  }
  requireHex(ref.txHash, `${field}.txHash`, 32);
  if (!Number.isInteger(ref.outputIndex) || ref.outputIndex < 0) {
    throw new Error(
      `bootstrap: ${field}.outputIndex must be a non-negative integer, got ` +
        `${JSON.stringify(ref.outputIndex)}.`
    );
  }
  return { txHash: ref.txHash.toLowerCase(), outputIndex: ref.outputIndex };
}

const refKey = (ref: TxInput) => `${ref.txHash.toLowerCase()}#${ref.outputIndex}`;

function requireSeeds(seeds: unknown): BootstrapSeeds {
  const s = seeds as BootstrapSeeds | undefined;
  if (!s || typeof s !== "object") {
    throw new Error(
      `bootstrap: seeds is required — three DISTINCT one-shot output references, as ` +
        `{ protocolParams, issuance, upgradeMultisig }. Got ${JSON.stringify(seeds)}.`
    );
  }
  const resolved: BootstrapSeeds = {
    protocolParams: requireTxInput(s.protocolParams, "seeds.protocolParams"),
    issuance: requireTxInput(s.issuance, "seeds.issuance"),
    upgradeMultisig: requireTxInput(s.upgradeMultisig, "seeds.upgradeMultisig"),
  };

  // ⛔ DISTINCTNESS IS A REFUSAL, NOT A WARNING. See BOOTSTRAP_SEED_COUNT: two
  // roles sharing one outref deploy fine and make the off-chain derivation
  // check for the shared pair VACUOUS. A check that cannot fail is worse than
  // an absent one, because it reads as coverage.
  const seen = new Map<string, string>();
  for (const [role, ref] of Object.entries(resolved)) {
    const key = refKey(ref);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(
        `bootstrap: seeds.${previous} and seeds.${role} are the SAME output reference ` +
          `(${key}). The three one-shot policies must be parameterised by three DISTINCT ` +
          `UTxOs: DeploymentParams carries protocolParams.txInput and upgradeMultisig.txInput ` +
          `as two same-typed fields, and a record that gives them one value makes ` +
          `assertDeploymentScripts pass whichever field the code reads — so the check cannot ` +
          `fail and a real defect in which field is read becomes invisible.`
      );
    }
    seen.set(key, role);
  }
  return resolved;
}

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

/** Extract the PlutusV3 script body hex (inner UPLC, no outer CBOR wrap). */
function scriptBodyHex(compiledCode: HexString): HexString {
  const level = UPLC.getCborEncodingLevel(compiledCode);
  if (level !== "double") return compiledCode;
  const raw = Bytes.fromHex(compiledCode);
  const additionalInfo = raw[0]! & 0x1f;
  const headerLen =
    additionalInfo < 24 ? 1 : additionalInfo === 24 ? 2 : additionalInfo === 25 ? 3 : 5;
  return Bytes.toHex(raw.slice(headerLen));
}

// ---------------------------------------------------------------------------
// planBootstrap
// ---------------------------------------------------------------------------

/**
 * Derive a whole protocol instance from a config. Pure: no client, no network,
 * no clock, no filesystem.
 *
 * ⚠ THE PARAMETERISATION ORDER IS LOAD-BEARING and each script's hash feeds the
 * next. It is NOT a single chain — `programmable_logic_base` hangs off the
 * params-NFT policy and everything downstream fans out — but the edges that do
 * exist cannot be reordered. See `scripts.ts` for the full graph.
 *
 * ⛔ PARAMETER TYPES ARE NOT INTERCHANGEABLE AND TYPESCRIPT CANNOT TELL THEM
 * APART: every one is a hex string at the call site. `issuance_logic` in
 * particular takes TWO ADJACENT PolicyIds — `registry_node_cs` then
 * `params_policy` — and swapping them yields a script that builds, hashes,
 * deploys and is registered without a murmur. It simply looks for the registry
 * under the params policy for the rest of its life.
 */
export function planBootstrap(config: BootstrapConfig): BootstrapPlan {
  if (!config || typeof config !== "object") {
    throw new Error("planBootstrap: a BootstrapConfig is required.");
  }
  const { blueprint } = config;
  if (!blueprint || typeof blueprint !== "object" || !Array.isArray(blueprint.validators)) {
    throw new Error(
      "planBootstrap: blueprint is required — the CIP-57 standard blueprint this instance is " +
        "built from. Import it via the package's \"./blueprints/*\" export path."
    );
  }
  validateStandardBlueprint(blueprint);
  requirePublishHandlers(blueprint);

  if (typeof config.networkId !== "number" || !Number.isInteger(config.networkId)) {
    throw new Error(
      `planBootstrap: networkId is required and must be an integer (0 for any testnet, 1 for ` +
        `mainnet), got ${JSON.stringify(config.networkId)}. Every address this plan derives ` +
        `depends on it, and a wrong one yields addresses that are valid and unreachable.`
    );
  }

  const seeds = requireSeeds(config.seeds);
  const alwaysFailNonce = requireHex(config.alwaysFailNonce, "alwaysFailNonce");

  if (typeof config.maxInlineDatumBytes !== "bigint" || config.maxInlineDatumBytes <= 0n) {
    throw new Error(
      `planBootstrap: maxInlineDatumBytes is required and must be a positive bigint, got ` +
        `${JSON.stringify(String(config.maxInlineDatumBytes))}. It is a SECURITY PARAMETER ` +
        `baked into the hashes of transfer, third_party, unfracking and issuance_logic, and ` +
        `this package deliberately ships no default for it — upstream gives no guidance and ` +
        `the devnet fixture's 1024 is explicitly not a recommendation.`
    );
  }

  if (config.unfracking !== "enabled" && config.unfracking !== "disabled") {
    throw new Error(
      `planBootstrap: unfracking is required and must be "enabled" or "disabled", got ` +
        `${JSON.stringify(config.unfracking)}. The choice is baked into the dispatcher's hash, ` +
        `so two deployments differing only here are DIFFERENT PROTOCOLS — it cannot be defaulted.`
    );
  }

  const events: ParameterizationEvent[] = [];
  const builders = createStandardScripts(blueprint, (e) => events.push(e));
  const max = config.maxInlineDatumBytes;

  const alwaysFail = builders.alwaysFail(alwaysFailNonce);

  // Depends on nothing but its own seed, so it can be built first — and its
  // config UTxO must be minted BEFORE the protocol genesis names it. See
  // buildMultisigGenesisTx for why that ordering is not a style choice.
  const upgradeMultisig = builders.upgradeMultisig(seeds.upgradeMultisig);

  // NO NONCE AND NO ORDERING EDGE. protocol_params takes only its one-shot
  // utxo_ref: the mint side no longer depends on a spend-side address, so the
  // cycle that once forced a coordination script to be built first is
  // dissolved. Its hash is BOTH the NFT policy id and the address payment
  // credential — the minting policy naming itself.
  const protocolParams = builders.protocolParams(seeds.protocolParams);
  const paramsPolicy: PolicyId = protocolParams.hash;

  const programmableLogicBase = builders.programmableLogicBase(paramsPolicy);

  // The registry does not touch the params chain at all — it reads its own
  // policy off its own input's payment credential — so it can be built as soon
  // as issuance_cbor_hex_mint exists. Its hash is also BOTH policy and address.
  const issuanceCborHexMint = builders.issuanceCborHexMint(seeds.issuance, alwaysFail.hash);
  const registry = builders.registry(seeds.protocolParams, issuanceCborHexMint.hash);

  // ⚠ progLogicCred is programmable_logic_base's hash, NOT the dispatcher's.
  // The dispatcher is parameterised BY these three, so the reverse would be a
  // parameter cycle: a value derived from your own script hash can never be
  // your own parameter.
  const transfer = builders.transfer(programmableLogicBase.hash, registry.hash, max);
  const thirdParty = builders.thirdParty(programmableLogicBase.hash, registry.hash, max);
  const unfracking = builders.unfracking(programmableLogicBase.hash, registry.hash, max);

  const unfrackingParameter =
    config.unfracking === "enabled" ? unfracking.hash : UNFRACKING_DISABLED;

  // Built LAST of the delegate family: it names all three at compile time, so
  // replacing ONE delegate requires deploying a new dispatcher too.
  const programmableLogicGlobal = builders.programmableLogicGlobal(
    transfer.hash,
    thirdParty.hash,
    unfrackingParameter
  );

  // ⛔ PARAMETERS 2 AND 3 ARE TWO ADJACENT PolicyIds AND BOTH ARE `string`:
  //   1 progLogicCred = programmable_logic_base  (NOT the dispatcher)
  //   2 registryPolicy                           <- registry_node_cs
  //   3 paramsPolicy                             <- params_policy
  //   4 maxInlineDatumBytes
  // Nothing — not the compiler, not the parameteriser, not the hash — can tell
  // a swap from the intended order.
  const issuanceLogic = builders.issuanceLogic(
    programmableLogicBase.hash,
    registry.hash,
    paramsPolicy,
    max
  );

  // issuance_mint is parameterised per minting logic, which is not known until
  // a token is registered. Build it once against a marker and store the CBOR
  // either side of it, so registration can splice in the real hash without
  // re-deriving the whole script.
  //
  // ⚑ TWO ARGUMENTS, CREDENTIAL FIRST: `(mintingLogicHash, paramsPolicy)`. The
  // delegate credentials it used to be compiled against now reach it through
  // the params datum instead — which is the whole point of the alpha.4 split.
  const issuanceMarker = builders.issuanceMint(ISSUANCE_SPLICE_MARKER, paramsPolicy);
  const markerBody = scriptBodyHex(issuanceMarker.compiledCode);
  const splitParts = markerBody.split(ISSUANCE_SPLICE_MARKER);
  /**
   * ⛔ A HARD FAILURE, AND IT MUST NOT BECOME A WARNING. The splice reassembles
   * the script from `pre + <real minting logic hash> + post`, so it is correct
   * only while the marker occurs EXACTLY ONCE. Zero means the parameter is no
   * longer inlined where we think; two means the splice would silently rewrite
   * an unrelated byte run.
   *
   * ⚠ And flat UPLC is BIT-packed: a parameter is findable as a whole number of
   * hex bytes only when it happens to land on a byte boundary. That alignment
   * is a property to be MEASURED per artefact, never assumed — this check is
   * what measures it.
   */
  if (splitParts.length !== 2) {
    throw new Error(
      `planBootstrap: the issuance_mint splice marker appeared ${splitParts.length - 1} times ` +
        `in the compiled body — expected exactly once. The stored IssuanceCborHex datum is ` +
        `reassembled around this cut, so zero occurrences means the parameter is no longer ` +
        `inlined where this code expects, and more than one means the splice would rewrite an ` +
        `unrelated byte run. Blueprint: "${blueprint.preamble.title}" v${blueprint.preamble.version}.`
    );
  }
  const [cborPre, cborPost] = splitParts as [string, string];

  const scripts: BootstrapScripts = {
    alwaysFail,
    protocolParams,
    programmableLogicBase,
    issuanceCborHexMint,
    registry,
    transfer,
    thirdParty,
    unfracking,
    programmableLogicGlobal,
    issuanceLogic,
    upgradeMultisig,
  };

  /**
   * SIX fields, written BY NAME and never as a positional spread.
   *
   * ⛔ INDEX 1 CHANGED MEANING BETWEEN alpha.3 AND alpha.4. `issuance_logic_cred`
   * was INSERTED at index 1, displacing `transfer_cred` to index 2. Both are
   * `Credential` — same constructor, same 28 bytes — so a datum written in
   * alpha.3's order with two fields appended is SIX fields long, passes the
   * arity check, passes `params_wellformed` (which only asserts each credential
   * is 28 bytes), decodes into a well-formed record, and hands `issuance_mint`
   * the TRANSFER credential as its issuance authority. Nothing at deploy time
   * catches it. Keying the record is what makes the compiler an ally.
   *
   * ⛔ `pendingUpgradeCred` MUST BE null AT GENESIS. `protocol_params` runs
   * `params_wellformed(genesis_params, is_init: True)`, and `is_init: True` is
   * exactly what forbids a nomination baked into the genesis datum.
   */
  const paramsDatum = protocolParamsDatum({
    plgCred: { type: "script", hash: programmableLogicGlobal.hash },
    issuanceLogicCred: { type: "script", hash: issuanceLogic.hash },
    transferCred: { type: "script", hash: transfer.hash },
    thirdPartyCred: { type: "script", hash: thirdParty.hash },
    upgradeCred: { type: "script", hash: upgradeMultisig.hash },
    pendingUpgradeCred: null,
  });

  // Sentinel head of the registry linked list: key "", next 0xff*30, every
  // delegate slot empty.
  const EMPTY_CRED = { type: "key" as const, hash: "" };
  const originDatum = registryNodeDatum({
    key: "",
    next: "ff".repeat(30),
    mintingLogicScript: EMPTY_CRED,
    transferLogicScript: EMPTY_CRED,
    thirdPartyTransferLogicScript: EMPTY_CRED,
    unfrackingLogicScript: EMPTY_CRED,
    globalStateCs: "",
  });

  const issuanceDatum = Data.constr(0n, [Data.bytearray(cborPre), Data.bytearray(cborPost)]);

  const byName: Record<ReferenceScriptName, PlutusScript> = {
    programmableLogicBase,
    programmableLogicGlobal,
    transfer,
    thirdParty,
    unfracking,
    issuanceLogic,
    upgradeMultisig,
  };

  return {
    config: { ...config, seeds, alwaysFailNonce },
    scripts,
    unfrackingParameter,
    addresses: {
      protocolParams: scriptAddress(config.networkId, paramsPolicy),
      registry: scriptAddress(config.networkId, registry.hash),
      issuanceCborHex: scriptAddress(config.networkId, alwaysFail.hash),
      upgradeMultisig: scriptAddress(config.networkId, upgradeMultisig.hash),
    },
    assetUnits: {
      protocolParamsNft: paramsPolicy + stringToHex("ProtocolParams"),
      // Empty asset name, so the unit IS the policy.
      registryNode: registry.hash,
      issuanceCborHexNft: issuanceCborHexMint.hash + stringToHex("IssuanceCborHex"),
      upgradeMultisigNft: upgradeMultisig.hash + stringToHex("UpgradeMultisig"),
    },
    datums: {
      protocolParams: paramsDatum,
      registryOrigin: originDatum,
      issuanceCborHex: issuanceDatum,
    },
    issuanceCbor: { pre: cborPre, post: cborPost },
    referenceScripts: REFERENCE_SCRIPT_ORDER.map((n) => byName[n]),
    stakeCredentialScripts: STAKE_REGISTRATION_ORDER.map((n) => byName[n]),
    parameterizations: events
      .filter((e) => e.title !== STANDARD_VALIDATORS.ISSUANCE_MINT)
      .map((e) => ({ rawScriptHash: e.rawScriptHash, params: e.params })),
  };
}

// ---------------------------------------------------------------------------
// Build plumbing — typed, and with no default for what the caller must decide
// ---------------------------------------------------------------------------

type TxBuilder = ReadOnlyTransactionBuilder | SigningTransactionBuilder;

/**
 * A built transaction, from either client flavour.
 *
 * ⚠ `EvoClient = ReadOnlyClient | SigningClient` and the two differ ONLY in
 * what `build()` returns: the read-only path (CIP-30 / browser) yields a result
 * that cannot sign, the seed-phrase path yields a `SignBuilder`. Narrow, never
 * cast — a cast here would be the `client: any` the amendment forbids, wearing
 * a different hat.
 */
type BuiltTx = TransactionResultBase | SignBuilder;

const isSignBuilder = (built: BuiltTx): built is SignBuilder => "chainResult" in built;

/**
 * What every build step needs, and what none of them will invent for you.
 *
 * ⛔ `availableUtxos` IS REQUIRED, AND THAT IS THE MOST IMPORTANT WORD IN THIS
 * MODULE. Without it Evolution queries the wallet itself and coin selection may
 * spend ANYTHING in it — including outputs carrying REFERENCE SCRIPTS. Spending
 * one destroys protocol infrastructure silently: the script_ref is not carried
 * into the change output, nothing errors, and the damage surfaces only when a
 * later operation needs the script. MEASURED on preview: two of a live
 * deployment's four reference scripts were consumed that way.
 *
 * ⚑ AND IT IS HOW A CALLER RESERVES THE SEEDS. The bootstrap's own seed UTxOs
 * are ordinary wallet UTxOs until the step that consumes them runs; a caller
 * that leaves them in `availableUtxos` for an EARLIER step invites coin
 * selection to spend one for fees, and the later step then names a spent input.
 * The ledger answers code 3117, "unknown UTxO references as inputs", which
 * names a UTxO and reads as a builder bug — it is not. Exclude the seeds you
 * have not consumed yet.
 */
export interface BootstrapBuildContext {
  /** A read-only or signing Evolution client. The SDK never constructs one. */
  readonly client: EvoClient;
  /** Bech32 change address. */
  readonly changeAddress: Address;
  /** Exactly the UTxOs this transaction may spend. See the note above. */
  readonly availableUtxos: readonly UTxO[];
  /**
   * Optional script evaluator.
   *
   * Without one the client's provider evaluates, and Kupmios reports a bare
   * "evaluateTx failed" naming neither the script nor the reason. The SDK never
   * constructs an evaluator and never names an endpoint — inject one.
   */
  readonly evaluator?: Evaluator;
}

function requireBuildContext(ctx: BootstrapBuildContext, step: BootstrapStepId): void {
  if (!ctx || typeof ctx !== "object") {
    throw new Error(`bootstrap ${step}: a build context is required.`);
  }
  if (!ctx.client || typeof ctx.client.newTx !== "function") {
    throw new Error(
      `bootstrap ${step}: client is required — an Evolution SDK ReadOnlyClient or SigningClient. ` +
        `This SDK does not construct clients, hold keys, or name endpoints.`
    );
  }
  if (typeof ctx.changeAddress !== "string" || ctx.changeAddress.length === 0) {
    throw new Error(`bootstrap ${step}: changeAddress is required (bech32).`);
  }
  if (!Array.isArray(ctx.availableUtxos)) {
    throw new Error(
      `bootstrap ${step}: availableUtxos is required — exactly the UTxOs this transaction may ` +
        `spend. There is deliberately no default: without it coin selection is free to spend ` +
        `reference-script UTxOs and seed UTxOs a later step still needs.`
    );
  }
  if (ctx.availableUtxos.length === 0) {
    throw new Error(
      `bootstrap ${step}: availableUtxos is empty. Nothing can fund this transaction. If you ` +
        `filtered a wallet view, check the filter before checking the wallet.`
    );
  }
}

function buildOptions(ctx: BootstrapBuildContext): BuildOptions {
  return {
    changeAddress: EvoAddress.fromBech32(ctx.changeAddress),
    availableUtxos: ctx.availableUtxos,
    ...(ctx.evaluator ? { evaluator: ctx.evaluator } : {}),
  };
}

/**
 * Build and shape into the SDK's one result type.
 *
 * ⚠ `_signBuilder` is the SAME field every other operation in this package
 * returns, not a new escape hatch: `UnsignedTx` already carries it and the
 * README's quick start already signs through it. Omitting it here would make
 * the bootstrap the only operation whose result cannot be submitted — the
 * defect `dummy.transfer` already recorded once. `cbor` is the supported path
 * and the one a key-holding caller should prefer; this SDK signs nothing.
 */
async function finish(
  tx: TxBuilder,
  ctx: BootstrapBuildContext,
  step: BootstrapStepId,
  metadata: Record<string, unknown>
): Promise<UnsignedTx> {
  const built: BuiltTx = await tx.build(buildOptions(ctx));
  const cbor = EvoTransaction.toCBORHex(await built.toTransaction());
  const txHash = isSignBuilder(built) ? built.chainResult().txHash : "";
  return { cbor, txHash, metadata: { step, ...metadata }, _signBuilder: built };
}

function requireSeedMatches(utxo: UTxO, expected: TxInput, role: string): void {
  if (!utxo || typeof utxo !== "object" || utxo.transactionId === undefined) {
    throw new Error(
      `bootstrap: the ${role} seed UTxO is required — the unspent output this plan's one-shot ` +
        `policy is parameterised by (${refKey(expected)}).`
    );
  }
  const actual: TxInput = {
    txHash: EvoTransactionHash.toHex(utxo.transactionId),
    outputIndex: Number(utxo.index),
  };
  if (refKey(actual) !== refKey(expected)) {
    throw new Error(
      `bootstrap: the ${role} seed UTxO is ${refKey(actual)}, but this plan was parameterised ` +
        `by ${refKey(expected)}. A one-shot policy's hash is a function of its outref, so ` +
        `spending a different UTxO builds a transaction against a script this deployment does ` +
        `not own — and it fails on chain naming neither. Rebuild the plan from the seeds you ` +
        `actually hold, or pass the seeds this plan names.`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 1 — seed
// ---------------------------------------------------------------------------

export interface SeedTxParams extends BootstrapBuildContext {
  /**
   * Where the seed outputs are paid. Usually the bootstrapping wallet's own
   * address: the steps that consume them must be able to spend them.
   */
  readonly ownerAddress: Address;
  /**
   * Lovelace per seed output — REQUIRED.
   *
   * Each seed funds part of the transaction that consumes it, so it must clear
   * min-UTxO with room for a fee. There is no default because the right figure
   * depends on the chain and on what the caller wants left over.
   */
  readonly seedLovelace: bigint;
}

/**
 * Step 1 — fragment the wallet into {@link BOOTSTRAP_SEED_COUNT} distinct UTxOs.
 *
 * ⚑ THIS STEP IS OPTIONAL. A caller that already holds three distinct unspent
 * UTxOs may skip it and call {@link planBootstrap} with their outrefs directly.
 * It exists because most callers do not.
 *
 * ⚠ Its outputs cannot be predicted: the plan needs the OBSERVED outrefs. Submit
 * this, wait for it, read the outputs back, then {@link selectBootstrapSeeds}.
 */
export async function buildSeedTx(params: SeedTxParams): Promise<UnsignedTx> {
  requireBuildContext(params, "seed");
  if (typeof params.ownerAddress !== "string" || params.ownerAddress.length === 0) {
    throw new Error("bootstrap seed: ownerAddress is required (bech32).");
  }
  if (typeof params.seedLovelace !== "bigint" || params.seedLovelace <= 0n) {
    throw new Error(
      `bootstrap seed: seedLovelace is required and must be a positive bigint, got ` +
        `${JSON.stringify(String(params.seedLovelace))}. Each seed funds the transaction that ` +
        `consumes it, so it must clear min-UTxO with room for a fee — a figure this package ` +
        `cannot choose for a chain it does not know.`
    );
  }

  // ⛔ REQUIRED IS NOT THE SAME AS VALID (F-11). A caller passing `1n` built
  // happily and failed only at submission, as "insufficient Ada" — the exact
  // failure min-UTxO solving exists to prevent, arriving from the one figure
  // this builder does NOT solve because the caller chose it.
  const { coinsPerUtxoByte } = await params.client.getProtocolParameters();
  const seedFloor = minLovelaceForPlainOutput(params.ownerAddress, coinsPerUtxoByte);
  if (params.seedLovelace < seedFloor) {
    throw new Error(
      `bootstrap seed: seedLovelace is ${params.seedLovelace} lovelace, below the min-UTxO ` +
        `floor of ${seedFloor} for a plain output at ${params.ownerAddress} ` +
        `(coinsPerUtxoByte ${coinsPerUtxoByte}). The ledger would reject the seed transaction ` +
        `as "insufficient Ada" at submission. ⚠ This floor is NECESSARY, NOT SUFFICIENT: each ` +
        `seed also has to fund the fee of the transaction that consumes it, and nothing here ` +
        `checks that.`
    );
  }

  const owner = EvoAddress.fromBech32(params.ownerAddress);
  let tx: TxBuilder = params.client.newTx();
  for (let i = 0; i < BOOTSTRAP_SEED_COUNT; i++) {
    tx = tx.payToAddress({ address: owner, assets: EvoAssets.fromLovelace(params.seedLovelace) });
  }
  return finish(tx, params, "seed", { seedCount: BOOTSTRAP_SEED_COUNT });
}

/**
 * Pick the three seeds out of a seed transaction's observed outputs.
 *
 * ⚠ REFUSES FEWER THAN THREE, LOUDLY. An earlier version of this logic asked
 * for three and tolerated two, which handed `undefined` to the third consumer.
 *
 * The change output of the seed transaction lands at the same address and is a
 * legitimate candidate; ordering by output index keeps the assignment stable
 * across reads of an indexer that does not preserve order.
 */
export function selectBootstrapSeeds(
  utxos: readonly UTxO[],
  seedTxHash: TxHash
): { seeds: BootstrapSeeds; utxos: BootstrapSeedUtxos } {
  const wanted = requireHex(seedTxHash, "seedTxHash", 32).toLowerCase();
  const mine = utxos
    .filter((u) => EvoTransactionHash.toHex(u.transactionId).toLowerCase() === wanted)
    .sort((a, b) => Number(a.index) - Number(b.index));

  if (mine.length < BOOTSTRAP_SEED_COUNT) {
    throw new Error(
      `bootstrap: the seed transaction ${wanted} shows ${mine.length} output(s) in the UTxO set ` +
        `supplied, need ≥${BOOTSTRAP_SEED_COUNT}. If the transaction was submitted, the ` +
        `provider's view has probably not settled yet — wait for it rather than proceeding ` +
        `with fewer, which hands a later step an undefined seed.`
    );
  }

  const [one, two, three] = mine as [UTxO, UTxO, UTxO];
  const ref = (u: UTxO): TxInput => ({
    txHash: EvoTransactionHash.toHex(u.transactionId).toLowerCase(),
    outputIndex: Number(u.index),
  });
  return {
    seeds: {
      protocolParams: ref(one),
      issuance: ref(two),
      upgradeMultisig: ref(three),
    },
    utxos: { protocolParams: one, issuance: two, upgradeMultisig: three },
  };
}

// ---------------------------------------------------------------------------
// Step 2 — the upgrade authority's config UTxO
// ---------------------------------------------------------------------------

export interface MultisigGenesisTxParams extends BootstrapBuildContext {
  readonly plan: BootstrapPlan;
  /** The unspent `seeds.upgradeMultisig` UTxO. Checked against the plan. */
  readonly seedUtxo: UTxO;
  /**
   * WHO CONTROLS THE PROTOCOL — required, with no default of any kind.
   *
   * The signer tree lives in this UTxO's datum rather than in the script's
   * parameters, which is what makes signer rotation possible without moving the
   * hash. `multisigScriptDatum` enforces upstream's `well_formed` rules.
   *
   * ⛔ AN UNSATISFIABLE TREE IS A ONE-WAY BRICK, in upstream's own words: the
   * authority check becomes "permanently unsatisfiable, with no repair path".
   */
  readonly upgradeMultisigTree: MultisigScriptTree;
}

/**
 * Step 2 — mint the `upgrade_multisig` one-shot NFT and lock it with the signer
 * tree, BEFORE the protocol genesis names this authority.
 *
 * ⛔ THE ORDER IS THE POINT, AND IT IS NOT A STYLE CHOICE. Step 3 writes a
 * genesis datum naming `upgrade_cred = Script(upgrade_multisig)`. That authority
 * is usable only while its config UTxO exists — the tree lives there, not in the
 * script's parameters. Running this AFTER the protocol genesis and failing
 * leaves a protocol on chain naming an authority whose config UTxO does not
 * exist: upstream's documented ONE-WAY BRICK, manufactured by transaction
 * ordering rather than by any defect in the validators. Failing BEFORE the
 * irreversible step costs one transaction and nothing else.
 *
 * The four rails `upgrade_multisig.mint` enforces, all satisfied here:
 *   1. the named UTxO is consumed                        -> collectFrom
 *   2. exactly one "UpgradeMultisig" token of this policy -> mintAssets
 *   3. an output found by `has_nft_strict`                -> the output below
 *   4. well_formed(tree), NO reference script, address == from_script(policy)
 *
 * ⛔ THE NFT AND NOTHING ELSE in that output. `has_nft_strict` is strict about
 * the WHOLE value: bundling any other asset with the config NFT means the output
 * is simply NOT FOUND by `list.expect_find`, and the genesis fails naming
 * nothing about bundling. Change is a separate output.
 *
 * ⚠ NO `script:` ON THE OUTPUT — rail 4 requires `reference_script == None`.
 * The reference script is published in step 4 like every other one.
 *
 * ⚑ Additional outputs are the CALLER's to add in their own transaction if they
 * want them. Rail 3 uses `list.expect_find`, which SKIPS a non-matching output
 * rather than rejecting it, so a junk UTxO parked at this address is harmless —
 * but it is not protocol state and this step will not mint one.
 */
export async function buildMultisigGenesisTx(
  params: MultisigGenesisTxParams
): Promise<UnsignedTx> {
  requireBuildContext(params, "multisig-genesis");
  const { plan } = params;
  if (!plan || typeof plan !== "object" || !plan.scripts) {
    throw new Error("bootstrap multisig-genesis: plan is required — see planBootstrap().");
  }
  if (!params.upgradeMultisigTree || typeof params.upgradeMultisigTree !== "object") {
    throw new Error(
      `bootstrap multisig-genesis: upgradeMultisigTree is required — the MultisigScript tree ` +
        `that IS this protocol's upgrade authority. There is no default: shipping one would ` +
        `mean shipping a decision about who controls every deployment made with this package.`
    );
  }
  requireSeedMatches(params.seedUtxo, plan.config.seeds.upgradeMultisig, "upgradeMultisig");

  // Enforces upstream's `well_formed`; throws by name on an unsatisfiable leaf.
  const datum = multisigScriptDatum(params.upgradeMultisigTree);

  const nftUnit = plan.assetUnits.upgradeMultisigNft;
  const assets = new Map([[nftUnit, 1n]]);
  const coinsPerUtxoByte = (await params.client.getProtocolParameters()).coinsPerUtxoByte;
  const lovelace = genesisOutputLovelace({
    address: plan.addresses.upgradeMultisig,
    assets: outputAssets(0n, assets),
    datum,
    coinsPerUtxoByte,
  });

  let tx: TxBuilder = params.client.newTx();
  tx = tx.collectFrom({ inputs: [params.seedUtxo] });
  tx = tx.mintAssets({ assets: mintAssetsFromMap(assets), redeemer: voidData() });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.upgradeMultisig),
    assets: outputAssets(lovelace, assets),
    datum: new InlineDatum.InlineDatum({ data: datum }),
  });
  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.upgradeMultisig.compiledCode) });

  return finish(tx, params, "multisig-genesis", {
    configUtxoOutputIndex: 0,
    nftUnit,
    address: plan.addresses.upgradeMultisig,
  });
}

/**
 * Assert the multisig config UTxO on chain is the one the genesis datum is
 * about to name. PURE — the caller fetches the UTxOs, this decides.
 *
 * ⛔ AN OPERABILITY GATE, NOT DECORATION. The measured instance of "correct and
 * useless" in this repo is a deployment naming an authority credential that
 * could not be registered at all: every hash reproduced, every read-back
 * matched, every test passed, and the protocol's upgrade path was permanently
 * unsatisfiable. "It exists and is well-formed" left "and can be used" untested.
 * Run this between step 2 and step 3, so it is structurally impossible for the
 * genesis datum to name an authority that is not there.
 *
 * ⚑ FILTERS STRUCTURALLY, BY POLICY, EXACTLY AS THE VALIDATOR DOES — not by
 * equality against a unit string we ourselves built. A lookup keyed on our own
 * constructed unit shares a blind spot with the code that constructed it: get
 * the asset name wrong in both places and the check agrees with itself.
 */
export function assertMultisigConfigUtxo(params: {
  readonly plan: BootstrapPlan;
  /** Every UTxO currently at `plan.addresses.upgradeMultisig`. */
  readonly utxosAtAddress: readonly UTxO[];
  /** The tree passed to {@link buildMultisigGenesisTx}. */
  readonly expectedTree: MultisigScriptTree;
}): { utxo: UTxO; ref: TxInput } {
  const { plan } = params;
  const policy = plan.scripts.upgradeMultisig.hash;
  const address = plan.addresses.upgradeMultisig;

  const candidates = (params.utxosAtAddress ?? []).filter((u) =>
    EvoAssets.getUnits(u.assets).some(
      (unit) => unit !== "lovelace" && unit.slice(0, 56) === policy
    )
  );
  if (candidates.length !== 1) {
    throw new Error(
      `upgrade_multisig config UTxO: expected exactly 1 UTxO at ${address} carrying an asset ` +
        `of policy ${policy}, found ${candidates.length}. The NFT is one-shot, so zero means ` +
        `the genesis output is not where the validator locks it, and more than one means this ` +
        `address is not what we think it is. Refusing to let a genesis datum name an authority ` +
        `whose config UTxO is not exactly one well-formed UTxO.`
    );
  }
  const utxo = candidates[0]!;

  const onChain = getInlineDatum(utxo);
  if (!onChain) {
    throw new Error(
      `upgrade_multisig config UTxO at ${address} carries no inline datum. The tree IS the ` +
        `authority; without it the credential is unsatisfiable and there is no repair path.`
    );
  }
  // ⚠ `decodeMultisigScript` deliberately enforces none of upstream's
  // `well_formed` rules — that asymmetry with the encoder is intentional — so
  // the SHAPE is asserted here, against what the caller said it minted.
  const tree = decodeMultisigScript(onChain);
  if (!sameTree(tree, params.expectedTree)) {
    throw new Error(
      `upgrade_multisig config UTxO holds a different authority tree than the one this ` +
        `bootstrap minted.\n  expected: ${JSON.stringify(params.expectedTree, replacer)}\n  ` +
        `on chain: ${JSON.stringify(tree, replacer)}\nAn authority nobody can satisfy is a ` +
        `permanent brick with no repair path, so this refuses before the genesis rather than ` +
        `after it.`
    );
  }

  return {
    utxo,
    ref: {
      txHash: EvoTransactionHash.toHex(utxo.transactionId).toLowerCase(),
      outputIndex: Number(utxo.index),
    },
  };
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}` : v);

/** Structural equality for a MultisigScript tree. Order-sensitive, as the encoding is. */
function sameTree(a: MultisigScriptTree, b: MultisigScriptTree): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "signature":
      return a.keyHash.toLowerCase() === (b as typeof a).keyHash.toLowerCase();
    case "script":
      return a.scriptHash.toLowerCase() === (b as typeof a).scriptHash.toLowerCase();
    case "before":
    case "after":
      return a.time === (b as typeof a).time;
    case "at-least":
      if (a.required !== (b as typeof a).required) return false;
    // falls through — the child list is compared the same way
    case "all-of":
    case "any-of": {
      const bs = (b as { scripts: readonly MultisigScriptTree[] }).scripts;
      const as = (a as { scripts: readonly MultisigScriptTree[] }).scripts;
      return as.length === bs.length && as.every((c, i) => sameTree(c, bs[i]!));
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 — protocol genesis
// ---------------------------------------------------------------------------

export interface ProtocolGenesisTxParams extends BootstrapBuildContext {
  readonly plan: BootstrapPlan;
  /** The unspent `seeds.protocolParams` UTxO. Checked against the plan. */
  readonly protocolParamsSeedUtxo: UTxO;
  /** The unspent `seeds.issuance` UTxO. Checked against the plan. */
  readonly issuanceSeedUtxo: UTxO;
  /**
   * Optional CIP-171 provenance. Supply the `UPSTREAM_PIN.json` shipped beside
   * the blueprint (import it via the "./blueprints/*" export path) and this
   * transaction carries a record of what was parameterised into what.
   *
   * ⚠ A wrong-arity record is DISCARDED SILENTLY by the registry — no error, no
   * REJECTED row. From outside, dropped and never-published are
   * indistinguishable, so verify with a POSITIVE lookup by tx hash.
   *
   * ⛔ Pass the pin that ships WITH this package's blueprint. A copied
   * repo/commit/compiler triple is a second copy that drifts silently and still
   * verifies — against the wrong source.
   */
  readonly provenancePin?: UpstreamPin;
}

/**
 * Step 3 — the protocol genesis: three one-shot mints and the three UTxOs that
 * hold this instance's state.
 *
 * Outputs, and the indices are POSITIONAL — `assembleDeploymentParams` reads
 * output 0 and nothing checks the rest but the chain:
 *   0  the params UTxO          (NFT + the six-field params datum)
 *   1  the registry origin node (NFT + the sentinel head of the linked list)
 *   2  the issuance CBOR UTxO   (NFT + the spliced issuance_mint body)
 */
export async function buildProtocolGenesisTx(
  params: ProtocolGenesisTxParams
): Promise<UnsignedTx> {
  requireBuildContext(params, "protocol-genesis");
  const { plan } = params;
  if (!plan || typeof plan !== "object" || !plan.scripts) {
    throw new Error("bootstrap protocol-genesis: plan is required — see planBootstrap().");
  }
  requireSeedMatches(params.protocolParamsSeedUtxo, plan.config.seeds.protocolParams, "protocolParams");
  requireSeedMatches(params.issuanceSeedUtxo, plan.config.seeds.issuance, "issuance");

  const coinsPerUtxoByte = (await params.client.getProtocolParameters()).coinsPerUtxoByte;
  const paramsNft = new Map([[plan.assetUnits.protocolParamsNft, 1n]]);
  const registryNft = new Map([[plan.assetUnits.registryNode, 1n]]);
  const issuanceNft = new Map([[plan.assetUnits.issuanceCborHexNft, 1n]]);

  let tx: TxBuilder = params.client.newTx();

  if (params.provenancePin) {
    const record = buildCip171RecordFromPin(
      plan.config.blueprint,
      params.provenancePin,
      plan.parameterizations
    );
    tx = tx.attachMetadata({
      label: CIP171_METADATA_LABEL,
      metadata: buildCip171Metadatum(record),
    });
  }

  tx = tx.collectFrom({ inputs: [params.protocolParamsSeedUtxo, params.issuanceSeedUtxo] });

  // ⚠ THREE POLICIES, THREE REDEEMERS, EACH THE GENESIS ARM OF ITS OWN
  // VALIDATOR. The indices are not a shared enum and do not correspond to each
  // other; they are copied verbatim from the sequence proven on chain.
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(registryNft),
    redeemer: registryInitRedeemer(),
  });
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(paramsNft),
    redeemer: Data.constr(1n, []),
  });
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(issuanceNft),
    redeemer: Data.constr(2n, []),
  });

  // ⚠ SOLVED, NOT FLAT, for every datum-bearing output here. The params datum
  // grew from four fields to six and the origin node from five to seven;
  // min-UTxO scales with serialised output size, and an under-funded output is
  // reported as "insufficient Ada" — which sends the reader to the wallet
  // balance rather than to the datum.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.protocolParams),
    assets: outputAssets(
      genesisOutputLovelace({
        address: plan.addresses.protocolParams,
        assets: outputAssets(0n, paramsNft),
        datum: plan.datums.protocolParams,
        coinsPerUtxoByte,
      }),
      paramsNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.protocolParams }),
  });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.registry),
    assets: outputAssets(
      ceilToWholeAda(
        minUtxoAtLeast(REGISTRY_NODE_MIN_ADA, {
          address: plan.addresses.registry,
          assets: outputAssets(0n, registryNft),
          datum: plan.datums.registryOrigin,
          coinsPerUtxoByte,
        })
      ),
      registryNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.registryOrigin }),
  });
  // The issuance datum carries the whole spliced script body, so its min-UTxO
  // is an order of magnitude above the others. Solved for the same reason.
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.issuanceCborHex),
    assets: outputAssets(
      genesisOutputLovelace({
        address: plan.addresses.issuanceCborHex,
        assets: outputAssets(0n, issuanceNft),
        datum: plan.datums.issuanceCborHex,
        coinsPerUtxoByte,
      }),
      issuanceNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.issuanceCborHex }),
  });

  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.registry.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.protocolParams.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.issuanceCborHexMint.compiledCode) });

  return finish(tx, params, "protocol-genesis", {
    outputIndices: { protocolParams: 0, registryOrigin: 1, issuanceCborHex: 2 },
    cip171: Boolean(params.provenancePin),
  });
}

// ---------------------------------------------------------------------------
// Step 4 — publish the reference scripts
// ---------------------------------------------------------------------------

export interface ReferenceScriptsTxParams extends BootstrapBuildContext {
  readonly plan: BootstrapPlan;
  /**
   * Where the reference scripts live — REQUIRED.
   *
   * ⚠ A LASTING DECISION, not a formality. These outputs are protocol
   * infrastructure for the life of the deployment; every programmable
   * transaction reads them. Pay them somewhere your own coin selection will
   * never touch. MEASURED on preview: a wallet holding them alongside funds had
   * two of four consumed by an ordinary retry, and nothing errored.
   */
  readonly referenceScriptAddress: Address;
  /** Lovelace per reference-script output — REQUIRED. min-UTxO scales with the script's size. */
  readonly referenceScriptLovelace: bigint;
}

/**
 * Step 4 — publish the seven reference scripts, in {@link REFERENCE_SCRIPT_ORDER}.
 *
 * Cannot be folded into step 3: a transaction cannot reference a script it is
 * itself creating.
 */
export async function buildReferenceScriptsTx(
  params: ReferenceScriptsTxParams
): Promise<UnsignedTx> {
  requireBuildContext(params, "reference-scripts");
  const { plan } = params;
  if (!plan || typeof plan !== "object" || !plan.referenceScripts) {
    throw new Error("bootstrap reference-scripts: plan is required — see planBootstrap().");
  }
  if (
    typeof params.referenceScriptAddress !== "string" ||
    params.referenceScriptAddress.length === 0
  ) {
    throw new Error(
      `bootstrap reference-scripts: referenceScriptAddress is required (bech32). These outputs ` +
        `are protocol infrastructure for the life of the deployment; where they live is a ` +
        `decision, not a default.`
    );
  }
  if (typeof params.referenceScriptLovelace !== "bigint" || params.referenceScriptLovelace <= 0n) {
    throw new Error(
      `bootstrap reference-scripts: referenceScriptLovelace is required and must be a positive ` +
        `bigint, got ${JSON.stringify(String(params.referenceScriptLovelace))}. min-UTxO for a ` +
        `script-bearing output scales with the script's size.`
    );
  }

  // ⛔ REQUIRED IS NOT THE SAME AS VALID (F-11), and a script-bearing output is
  // where the gap bites hardest: the script's own bytes are part of the
  // serialised output, so its min-UTxO is an order of magnitude above a plain
  // one. A caller passing a plain-output figure builds happily and is refused
  // at submission as "insufficient Ada".
  //
  // ⚠ A SOUND LOWER BOUND, NOT THE EXACT FIGURE. `minUtxoForOutput` takes no
  // script, so this adds the largest script's own bytes at `coinsPerUtxoByte`
  // each. The true requirement is higher by the script ref's CBOR wrapping —
  // which is why this REFUSES BELOW the bound and never reports it as
  // sufficient.
  const { coinsPerUtxoByte, maxTxSize } = await params.client.getProtocolParameters();
  let largest: { name: string; bytes: number } = { name: "(none)", bytes: 0 };
  plan.referenceScripts.forEach((script, i) => {
    const bytes = scriptBodyHex(script.compiledCode).length / 2;
    if (bytes > largest.bytes) largest = { name: REFERENCE_SCRIPT_ORDER[i]!, bytes };
  });
  const refFloor =
    minLovelaceForPlainOutput(params.referenceScriptAddress, coinsPerUtxoByte) +
    coinsPerUtxoByte * BigInt(largest.bytes);
  if (params.referenceScriptLovelace < refFloor) {
    throw new Error(
      `bootstrap reference-scripts: referenceScriptLovelace is ` +
        `${params.referenceScriptLovelace} lovelace, below the ${refFloor} a script-bearing ` +
        `output needs at coinsPerUtxoByte ${coinsPerUtxoByte} — the largest script here is ` +
        `${largest.name} at ${largest.bytes} bytes, and a script's own bytes count toward ` +
        `min-UTxO. The ledger would reject this as "insufficient Ada" at submission. ⚠ The ` +
        `figure quoted is a LOWER BOUND: the true requirement is higher by the script ref's ` +
        `CBOR wrapping.`
    );
  }

  const to = EvoAddress.fromBech32(params.referenceScriptAddress);
  let tx: TxBuilder = params.client.newTx();
  for (const script of plan.referenceScripts) {
    tx = tx.payToAddress({
      address: to,
      assets: outputAssets(params.referenceScriptLovelace),
      script: buildEvoScript(script.compiledCode),
    });
  }

  const unsigned = await finish(tx, params, "reference-scripts", {
    order: [...REFERENCE_SCRIPT_ORDER],
    outputIndices: Object.fromEntries(REFERENCE_SCRIPT_ORDER.map((n, i) => [n, i])),
  });

  // ⛔ THE SIZE CAP, CHECKED HERE RATHER THAN DISCOVERED AT SUBMISSION (F-9).
  // This transaction carries every published script body at once and is the
  // one that grows when REFERENCE_SCRIPT_ORDER grows — MEASURED at 12,496 of
  // 16,384 bytes for the current seven. Unsigned, so this is a LOWER BOUND on
  // the signed size; it refuses the certain failures and cannot promise the
  // marginal ones.
  const bytes = unsigned.cbor.length / 2;
  if (bytes >= maxTxSize) {
    throw new Error(
      `bootstrap reference-scripts: the unsigned transaction publishing ` +
        `${plan.referenceScripts.length} reference scripts is ${bytes} bytes, at or over this ` +
        `chain's ${maxTxSize}-byte maximum — and witnesses have not been added yet. Split the ` +
        `publication across two transactions and record both hashes; do not shorten ` +
        `REFERENCE_SCRIPT_ORDER, whose indices a deployment record already depends on.`
    );
  }
  return { ...unsigned, metadata: { ...unsigned.metadata, unsignedBytes: bytes, maxTxSize } };
}

// ---------------------------------------------------------------------------
// Step 5 — register the withdraw-0 stake credentials
// ---------------------------------------------------------------------------

export interface StakeRegistrationTxParams extends BootstrapBuildContext {
  readonly plan: BootstrapPlan;
}

/**
 * Step 5 — the six Conway `RegCert`s, in one transaction.
 *
 * ⛔ `registerStake` + `attachScript` + a void redeemer, NEVER
 * `registerAndDelegateTo`, FOR A SCRIPT CREDENTIAL. MEASURED: a combined
 * certificate is a Conway `vote_reg_deleg_cert`, which arrives at the `publish`
 * handler as a DIFFERENT `Certificate` constructor, and both
 * `upgrade_multisig.publish` and `issuance_logic.publish` admit
 * `RegisterCredential` and nothing else.
 *
 * ⚠ The DRep delegation a KEY credential needs is not missing here by oversight.
 * A script withdraw-0 needs three things — a script witness, a registration, and
 * the withdrawal itself. The DRep delegation is the FOURTH thing a key
 * credential needs, and a script cannot have one.
 *
 * ⚠ Kept separate from step 3 because each certificate executes its script under
 * the PUBLISH purpose: carrying all six script bodies alongside the mint
 * witnesses is what breaks the 16,384-byte size cap. MEASURED at 21,816 bytes
 * when this was one transaction.
 */
export async function buildStakeRegistrationTx(
  params: StakeRegistrationTxParams
): Promise<UnsignedTx> {
  requireBuildContext(params, "stake-registrations");
  const { plan } = params;
  if (!plan || typeof plan !== "object" || !plan.stakeCredentialScripts) {
    throw new Error("bootstrap stake-registrations: plan is required — see planBootstrap().");
  }

  let tx: TxBuilder = params.client.newTx();
  for (const script of plan.stakeCredentialScripts) {
    tx = tx.registerStake({
      stakeCredential: Credential.makeScriptHash(Bytes.fromHex(script.hash)),
      redeemer: voidData(),
    });
    tx = tx.attachScript({ script: buildEvoScript(script.compiledCode) });
  }

  return finish(tx, params, "stake-registrations", {
    order: [...STAKE_REGISTRATION_ORDER],
    credentials: plan.stakeCredentialScripts.map((s) => s.hash),
  });
}

// ---------------------------------------------------------------------------
// Assembling the record
// ---------------------------------------------------------------------------

/** The four things only a submitted chain can tell you. */
export interface BootstrapObservations {
  /** Step 3's transaction hash. Becomes `txHash` and the params UTxO reference. */
  readonly protocolGenesisTxHash: TxHash;
  /** Step 4's transaction hash. Becomes all seven reference inputs. */
  readonly referenceScriptsTxHash: TxHash;
  /**
   * The multisig config UTxO, READ BACK OFF THE CHAIN — see
   * {@link assertMultisigConfigUtxo}, which returns exactly this.
   *
   * ⚠ MUTABLE STATE. A signer rotation spends and recreates it, so a recorded
   * value goes stale; re-read it rather than trusting an old record.
   */
  readonly multisigConfigUtxo: TxInput;
}

/**
 * Assemble `DeploymentParams` from the plan and what was observed. Pure.
 *
 * ⛔ THE RECORD MUST SAY WHAT THE DATUM SAYS. `upgradeAuthority` is the
 * deployment's account of the ACTIVE authority and the genesis datum writes
 * `upgradeCred: Script(upgradeMultisig)`. Nothing derives one from the other and
 * nothing may check them against each other on chain — which is exactly why
 * both come from the same plan here, rather than being written twice.
 */
export function assembleDeploymentParams(
  plan: BootstrapPlan,
  observed: BootstrapObservations
): DeploymentParams {
  if (!plan || typeof plan !== "object" || !plan.scripts) {
    throw new Error("assembleDeploymentParams: plan is required — see planBootstrap().");
  }
  const genesisTxHash = requireHex(
    observed?.protocolGenesisTxHash,
    "observed.protocolGenesisTxHash",
    32
  ).toLowerCase();
  const refTxHash = requireHex(
    observed?.referenceScriptsTxHash,
    "observed.referenceScriptsTxHash",
    32
  ).toLowerCase();
  const multisigUtxo = requireTxInput(
    observed?.multisigConfigUtxo,
    "observed.multisigConfigUtxo"
  );

  const refIdx = (name: ReferenceScriptName): TxInput => ({
    txHash: refTxHash,
    outputIndex: REFERENCE_SCRIPT_ORDER.indexOf(name),
  });
  const s = plan.scripts;

  return {
    txHash: genesisTxHash,
    protocolParams: {
      txInput: plan.config.seeds.protocolParams,
      // ONE value: policy id AND address payment credential.
      policyId: s.protocolParams.hash,
      utxo: { txHash: genesisTxHash, outputIndex: 0 },
    },
    programmableLogicBase: { scriptHash: s.programmableLogicBase.hash },
    transfer: { scriptHash: s.transfer.hash },
    thirdParty: { scriptHash: s.thirdParty.hash },
    unfracking: { scriptHash: s.unfracking.hash },
    programmableLogicGlobal: {
      scriptHash: s.programmableLogicGlobal.hash,
      // ⛔ WHAT THE DISPATCHER WAS COMPILED AGAINST, and it is NOT derivable
      // from `unfracking.scriptHash` above: a deployment may have unfracking
      // fully deployed, published and recorded while compiling this dispatcher
      // against the sentinel, so the arm can never be satisfied. Two fields,
      // two different facts, and neither may be defaulted from the other.
      unfrackingParameter: plan.unfrackingParameter,
    },
    maxInlineDatumBytes: Number(plan.config.maxInlineDatumBytes),
    issuanceLogic: { scriptHash: s.issuanceLogic.hash },
    upgradeMultisig: {
      scriptHash: s.upgradeMultisig.hash,
      // ⚠ The upgradeMultisig seed, and NOT the protocolParams one. Same type,
      // not interchangeable — see BOOTSTRAP_SEED_COUNT.
      txInput: plan.config.seeds.upgradeMultisig,
      utxo: multisigUtxo,
    },
    upgradeAuthority: { type: "script", hash: s.upgradeMultisig.hash },
    issuance: {
      txInput: plan.config.seeds.issuance,
      policyId: s.issuanceCborHexMint.hash,
      alwaysFailScriptHash: s.alwaysFail.hash,
    },
    registry: {
      txInput: plan.config.seeds.protocolParams,
      issuanceScriptHash: s.issuanceCborHexMint.hash,
      // ONE value again: node NFT policy AND node address payment credential.
      scriptHash: s.registry.hash,
    },
    programmableBaseRefInput: refIdx("programmableLogicBase"),
    programmableLogicGlobalRefInput: refIdx("programmableLogicGlobal"),
    transferRefInput: refIdx("transfer"),
    thirdPartyRefInput: refIdx("thirdParty"),
    unfrackingRefInput: refIdx("unfracking"),
    issuanceLogicRefInput: refIdx("issuanceLogic"),
    upgradeMultisigRefInput: refIdx("upgradeMultisig"),
  };
}
