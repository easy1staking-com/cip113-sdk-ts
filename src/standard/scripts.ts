/**
 * Standard script parameterization — CIP-113 0.5.0-alpha.2 (upstream 9db7e06).
 *
 * Uses Evolution SDK directly for UPLC.applyParamsToScript and ScriptHash.
 *
 * Dependency graph. Note it is NO LONGER a single chain: upstream #110 removed
 * programmable_logic_global, and PLB is now parameterised by the params-NFT
 * policy rather than by PLG's credential, so everything downstream hangs off
 * `params_policy` in parallel instead of in series.
 *
 *   always_fail(nonce)                          -> hash   (issuance side only now)
 *   coordination_spend(nonce)                   -> hash   NEW: the lock target
 *   protocol_params_mint(utxo_ref, coord_hash)  -> policy  == params_policy
 *     |
 *     +-- programmable_logic_base(params_policy) -> hash
 *     +-- transfer(params_policy)                -> hash   (PLG's transfer arm, renamed)
 *     +-- third_party(params_policy)             -> hash   NEW: seize / clawback
 *     +-- unfracking(params_policy)              -> hash
 *     +-- registry_spend(params_policy)          -> hash
 *
 *   issuance_cbor_hex_mint(utxo_ref, always_fail_hash)              -> policy
 *   registry_mint(utxo_ref, issuance_cbor_hex_cs, registry_spend_cred) -> policy
 *   issuance_mint(PLB_cred, registry_node_cs, minting_logic_cred, params_policy)
 *   upgrade_multisig(signers, threshold)        -> hash   (independent)
 *
 * ⚠ PARAMETER TYPES ARE NOT INTERCHANGEABLE and TypeScript cannot tell them
 * apart — every one of these is a hex string at the call site. `params_policy`
 * is a PolicyId (a bare ByteArray); `minting_logic_cred` and friends are
 * Credentials (a constructor-wrapped Script/VerificationKey). Passing a policy
 * where a credential belongs produces a valid script with the wrong hash. The
 * types below come from the blueprint's own parameter schemas, not from
 * upstream's prose docs — see the hazard note in blueprint.ts.
 */
import { Data } from "@evolution-sdk/evolution";
import type {
  DeploymentParams,
  HexString,
  PlutusBlueprint,
  PlutusScript,
  PolicyId,
  ScriptHash,
  TxInput,
} from "../types.js";
import { getValidatorCode, STANDARD_VALIDATORS } from "./blueprint.js";
import {
  parameterizeScript,
  outputReference,
  scriptCredential,
  computeScriptHash,
} from "../core/evo-utils.js";

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

export interface StandardScripts {
  alwaysFail(nonce: HexString): PlutusScript;

  /**
   * `protocol_params` — mint AND spend in one validator (#118).
   *
   * ⚑ ITS HASH IS BOTH THE PARAMS-NFT POLICY ID AND THE PARAMS ADDRESS'S
   * PAYMENT CREDENTIAL. The mint handler locks the NFT at `Script(own_policy)`
   * — the minting policy naming itself. Callers that used to derive the policy
   * from `protocol_params_mint` and the address from `protocol_params_spend`
   * must collapse to this one derivation.
   *
   * ⚠ NO NONCE, and no lock-target parameter. `protocol_params_mint` took
   * `(utxo_ref, coordination_hash)` and `coordination_spend` took `(nonce)`;
   * both are gone. The ordering cycle they created is dissolved with them.
   */
  protocolParams(utxoRef: TxInput): PlutusScript;

  /** Takes the params-NFT POLICY — which is now also the params address. */
  programmableLogicBase(paramsPolicy: PolicyId): PlutusScript;

  /**
   * The three withdraw-0 delegates. Arity 1 -> 3 in alpha.3, SAME TITLES.
   *
   * ⚠ `progLogicCred` is programmable_logic_base's hash, NOT the dispatcher's.
   * The dispatcher is parameterised BY these three, so pointing them at it
   * would be a parameter cycle: a value derived from your own script hash can
   * never be your own parameter.
   */
  transfer(
    progLogicCred: ScriptHash,
    registryPolicy: PolicyId,
    maxInlineDatumBytes: number | bigint,
  ): PlutusScript;
  thirdParty(
    progLogicCred: ScriptHash,
    registryPolicy: PolicyId,
    maxInlineDatumBytes: number | bigint,
  ): PlutusScript;
  unfracking(
    progLogicCred: ScriptHash,
    registryPolicy: PolicyId,
    maxInlineDatumBytes: number | bigint,
  ): PlutusScript;

  /**
   * `programmable_logic_global` — the dispatcher, reintroduced by #117.
   *
   * Carries the three delegate hashes as compile-time parameters, so replacing
   * ONE delegate requires deploying a new dispatcher too. Must be built AFTER
   * all three delegates.
   *
   * ⚠ Its parameters are bare ScriptHashes, not Credentials — unlike
   * `issuance_mint`'s, which wrap the same 28 bytes in a Credential
   * constructor. Same bytes, different encoding, no type to tell them apart.
   */
  programmableLogicGlobal(
    transferHash: ScriptHash,
    thirdPartyHash: ScriptHash,
    unfrackingHash: ScriptHash,
  ): PlutusScript;

  upgradeMultisig(signers: HexString[], threshold: number | bigint): PlutusScript;
  issuanceCborHexMint(utxoRef: TxInput, alwaysFailHash: ScriptHash): PlutusScript;

  /**
   * `registry` — mint AND spend in one validator (#117).
   *
   * ⚑ ONE HASH FOR POLICY AND ADDRESS, exactly as `protocolParams`. Arity
   * dropped 3 -> 2: `registry_spend_cred` is gone, and so is the params-policy
   * parameter the old spend side took — the registry no longer depends on the
   * protocol-params chain at all and can be built immediately after
   * `issuanceCborHexMint`.
   */
  registry(utxoRef: TxInput, issuanceCborHexPolicy: PolicyId): PlutusScript;

  issuanceMint(
    plbHash: ScriptHash,
    registryNodePolicy: PolicyId,
    mintingLogicHash: ScriptHash,
    paramsPolicy: PolicyId,
  ): PlutusScript;
}

/**
 * Create standard script builders from a blueprint.
 * Uses Evolution SDK directly for parameterization and hashing.
 */
/**
 * One parameterisation, as it happened. Emitted by {@link createStandardScripts}
 * when a recorder is supplied.
 *
 * Exists so a CIP-171 record can be DERIVED from the same call path that
 * actually parameterises the scripts, rather than hand-maintained alongside it.
 * The record is keyed by the UNAPPLIED hash and its values are in APPLICATION
 * order; both are properties of this call and of nothing else. A second list
 * transcribed by hand would agree with the deployment right up until it did
 * not, and the disagreement would surface as a hash that verifies to nothing.
 */
export interface ParameterizationEvent {
  /** Validator title as it appears in the blueprint. */
  title: string;
  /**
   * Blake2b-224 of the UNAPPLIED compiled code — the CIP-171 map KEY.
   *
   * NOT the hash of anything that gets deployed. Two deployments with
   * different parameters share this value; that is the point of it.
   */
  rawScriptHash: ScriptHash;
  /**
   * Blake2b-224 of the compiled code AFTER {@link params} were applied — the
   * hash that is actually deployed, referenced on-chain, and appears in
   * `DeploymentParams`.
   *
   * Emitted so that the offline recomputation `docs/provenance.md` recommends
   * has a SECOND OPERAND. Without it a consumer can re-apply the recorded
   * params and hash the result, but has nothing independent to compare against
   * — a check that compares a computation to itself, which always passes and
   * proves nothing. Compare this against a hash obtained from somewhere this
   * package did not produce: the deployment, the chain, an explorer.
   *
   * Do NOT key a CIP-171 record on this. The key is {@link rawScriptHash};
   * this is the value side's subject. The two are one field apart and a tired
   * reader gets them backwards.
   */
  appliedScriptHash: ScriptHash;
  /** Arguments applied, in application order. */
  params: Data.Data[];
}

export function createStandardScripts(
  blueprint: PlutusBlueprint,
  onParameterize?: (event: ParameterizationEvent) => void,
): StandardScripts {
  function parameterize(validatorTitle: string, params: Data.Data[]): PlutusScript {
    const code = getValidatorCode(blueprint, validatorTitle);
    // Parameterise FIRST: the applied hash is a by-product of the work, not a
    // second hashing pass. A recorder that fired before the application would
    // also report parameterisations that went on to throw.
    const script = parameterizeScript(code, params);
    if (onParameterize) {
      onParameterize({
        title: validatorTitle,
        rawScriptHash: computeScriptHash(code),
        appliedScriptHash: script.hash,
        params,
      });
    }
    return script;
  }

  return {
    alwaysFail(nonce) {
      return parameterize(STANDARD_VALIDATORS.ALWAYS_FAIL, [Data.bytearray(nonce)]);
    },

    protocolParams(utxoRef) {
      return parameterize(STANDARD_VALIDATORS.PROTOCOL_PARAMS, [outputReference(utxoRef)]);
    },

    programmableLogicBase(paramsPolicy) {
      // PolicyId — a bare ByteArray. It was scriptCredential(plgHash) before #110.
      return parameterize(STANDARD_VALIDATORS.PROGRAMMABLE_LOGIC_BASE, [
        Data.bytearray(paramsPolicy),
      ]);
    },

    transfer(progLogicCred, registryPolicy, maxInlineDatumBytes) {
      return parameterize(STANDARD_VALIDATORS.TRANSFER, [
        scriptCredential(progLogicCred),
        Data.bytearray(registryPolicy),
        Data.int(BigInt(maxInlineDatumBytes)),
      ]);
    },

    thirdParty(progLogicCred, registryPolicy, maxInlineDatumBytes) {
      return parameterize(STANDARD_VALIDATORS.THIRD_PARTY, [
        scriptCredential(progLogicCred),
        Data.bytearray(registryPolicy),
        Data.int(BigInt(maxInlineDatumBytes)),
      ]);
    },

    unfracking(progLogicCred, registryPolicy, maxInlineDatumBytes) {
      return parameterize(STANDARD_VALIDATORS.UNFRACKING, [
        scriptCredential(progLogicCred),
        Data.bytearray(registryPolicy),
        Data.int(BigInt(maxInlineDatumBytes)),
      ]);
    },

    upgradeMultisig(signers, threshold) {
      return parameterize(STANDARD_VALIDATORS.UPGRADE_MULTISIG, [
        Data.list(signers.map((s) => Data.bytearray(s))),
        Data.int(BigInt(threshold)),
      ]);
    },

    issuanceCborHexMint(utxoRef, alwaysFailHash) {
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_CBOR_HEX_MINT, [
        outputReference(utxoRef),
        Data.bytearray(alwaysFailHash),
      ]);
    },

    registry(utxoRef, issuanceCborHexPolicy) {
      return parameterize(STANDARD_VALIDATORS.REGISTRY, [
        outputReference(utxoRef),
        Data.bytearray(issuanceCborHexPolicy),
      ]);
    },

    programmableLogicGlobal(transferHash, thirdPartyHash, unfrackingHash) {
      // Bare ScriptHashes — NOT scriptCredential(). The blueprint declares
      // `aiken/crypto/ScriptHash` here, while issuance_mint declares
      // `cardano/address/Credential` for the same 28 bytes. Wrapping these
      // would produce a different script that still hashes and still deploys.
      return parameterize(STANDARD_VALIDATORS.PROGRAMMABLE_LOGIC_GLOBAL, [
        Data.bytearray(transferHash),
        Data.bytearray(thirdPartyHash),
        Data.bytearray(unfrackingHash),
      ]);
    },

    issuanceMint(plbHash, registryNodePolicy, mintingLogicHash, paramsPolicy) {
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_MINT, [
        scriptCredential(plbHash),
        Data.bytearray(registryNodePolicy),
        scriptCredential(mintingLogicHash),
        Data.bytearray(paramsPolicy),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Deployment verification
// ---------------------------------------------------------------------------

/** One derived-vs-deployed script hash comparison. */
export interface ScriptHashCheck {
  /** Validator name, as it appears in the parameterization chain */
  name: string;
  /** Hash derived from the blueprint + deployment parameters */
  derived: ScriptHash;
  /** Hash recorded in DeploymentParams */
  deployed: ScriptHash;
}

/** Thrown when a blueprint does not reproduce its deployment's script hashes. */
export class DeploymentMismatchError extends Error {
  readonly mismatches: ScriptHashCheck[];

  constructor(mismatches: ScriptHashCheck[], blueprintTitle: string) {
    super(
      `Blueprint "${blueprintTitle}" does not reproduce this deployment. ` +
      `${mismatches.length} script hash(es) differ:\n` +
      mismatches
        .map((m) => `  ${m.name}: derived ${m.derived}, deployment says ${m.deployed}`)
        .join("\n") +
      `\nThe blueprint and the DeploymentParams describe different protocol instances. ` +
      `Transactions built from this pairing would be rejected at submission.`
    );
    this.name = "DeploymentMismatchError";
    this.mismatches = mismatches;
  }
}

/**
 * Derive every parameterizable standard script hash from the blueprint and
 * check it against DeploymentParams. Throws DeploymentMismatchError on any
 * difference; returns the full check list on success.
 *
 * Why this exists: parameterization changes are not always visible to the
 * compiler. Upstream has changed a parameter's *meaning* while keeping its
 * arity and type (protocol_params_mint's `always_fail_hash` became
 * `coordination_addr_hash` in 0.5.0-alpha.1), so a wrong value typechecks,
 * builds, and only fails when the ledger rejects the transaction. This is the
 * check that catches it, and it is why buildDeploymentScripts no longer
 * overwrites derived hashes with deployment values.
 *
 * Not covered: always_fail (its nonce is not carried in DeploymentParams),
 * issuance_mint (parameterized per minting logic), and upgrade_multisig (its
 * signers/threshold are an authority choice, not a derived protocol value).
 * coordination_spend IS covered — DeploymentParams carries its nonce precisely
 * so the lock target can be re-derived rather than trusted.
 *
 * WHERE THIS CHECK HAS VALUE — and where it has none.
 *
 * It is only meaningful when the blueprint and the deployment come from
 * INDEPENDENT sources, so that they can actually disagree: a deployment loaded
 * from disk, a database, or the chain, checked against the blueprint currently
 * bundled. That is the case it catches, and the failure it catches is real —
 * this repo shipped a blueprint swapped in place under an unchanged directory
 * name, with 4 of 8 validator hashes moved.
 *
 * It proves NOTHING at bootstrap time. A deployment script derives the hashes,
 * populates DeploymentParams from those same values, and then asserts against
 * them — a tautology that cannot fail. Do not read a passing assertion inside a
 * bootstrap as evidence that the deployment is correct; assert on LOAD instead.
 */
export function assertDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): ScriptHashCheck[] {
  const builders = createStandardScripts(blueprint);

  const plb = deployment.programmableLogicBase.scriptHash;
  const registryPolicy = deployment.registry.scriptHash;
  const mid = deployment.maxInlineDatumBytes;

  const checks: ScriptHashCheck[] = [
    {
      // ⚑ ONE derivation for what used to be two. The params NFT policy and the
      // params address's payment credential are the same value in alpha.3, so
      // deriving them separately is not "belt and braces" — it is two chances
      // to disagree about one fact.
      name: "protocol_params (policy == address)",
      derived: builders.protocolParams(deployment.protocolParams.txInput).hash,
      deployed: deployment.protocolParams.policyId,
    },
    {
      name: "programmable_logic_base",
      derived: builders.programmableLogicBase(deployment.protocolParams.policyId).hash,
      deployed: plb,
    },
    {
      name: "transfer",
      derived: builders.transfer(plb, registryPolicy, mid).hash,
      deployed: deployment.transfer.scriptHash,
    },
    {
      name: "third_party",
      derived: builders.thirdParty(plb, registryPolicy, mid).hash,
      deployed: deployment.thirdParty.scriptHash,
    },
    {
      name: "unfracking",
      derived: builders.unfracking(plb, registryPolicy, mid).hash,
      deployed: deployment.unfracking.scriptHash,
    },
    {
      // ⛔ THE COHERENCE CHECK THE LEDGER CANNOT DO. A script cannot read
      // another script's parameters, so nothing on chain verifies that the
      // dispatcher was compiled against THESE three delegates. Deriving it from
      // the deployment's own delegate hashes is the only place that mismatch
      // can be caught — and a dispatcher naming stale delegates fails at
      // withdrawal time with an index error, never with "wrong dispatcher".
      name: "programmable_logic_global (dispatcher coherence)",
      derived: builders.programmableLogicGlobal(
        deployment.transfer.scriptHash,
        deployment.thirdParty.scriptHash,
        deployment.unfracking.scriptHash,
      ).hash,
      deployed: deployment.programmableLogicGlobal.scriptHash,
    },
    {
      name: "issuance_cbor_hex_mint",
      derived: builders.issuanceCborHexMint(
        deployment.issuance.txInput,
        deployment.issuance.alwaysFailScriptHash
      ).hash,
      deployed: deployment.issuance.policyId,
    },
    {
      // ⚑ Also one derivation for what used to be two (registry_mint's policy
      // and registry_spend's address).
      name: "registry (policy == address)",
      derived: builders.registry(
        deployment.registry.txInput,
        deployment.registry.issuanceScriptHash,
      ).hash,
      deployed: registryPolicy,
    },
    // ⛔ `upgrade_multisig` IS DELIBERATELY NOT CHECKED, and the reason is a bug
    // this assertion itself shipped.
    //
    // It was checked here, derived as `upgradeMultisig([upgradeAuthority.hash], 1)`.
    // That is WRONG: `upgrade_multisig` is parameterised by the deployer's
    // PAYMENT key hash (its signers are matched against `extra_signatories`),
    // while `upgradeAuthority` is the STAKE credential named in the params
    // datum (it must appear in the withdrawals map). Two different keys of the
    // same shape and length; neither derives from the other.
    //
    // ⚠ The offline fixture used ONE value for both fields, so the wrong
    // relationship reproduced perfectly and the check passed vacuously. Only a
    // real deployment — where the two genuinely differ — exposed it, and it
    // took a devnet bootstrap to get one.
    //
    // It is not checked now because it CANNOT BE: `upgrade_multisig`'s signer
    // set and threshold are a deployment CHOICE, and DeploymentParams does not
    // record them — the same category as `maxInlineDatumBytes`, which IS
    // recorded precisely so it can be asserted. Inventing a derivation from the
    // nearest same-shaped field is what produced the bug. A guard that cannot
    // decide should stop, not guess.
  ];

  const mismatches = checks.filter((c) => c.derived !== c.deployed);
  if (mismatches.length > 0) {
    throw new DeploymentMismatchError(mismatches, blueprint.preamble.title);
  }
  return checks;
}

/**
 * Build resolved standard scripts from deployment params.
 *
 * Every derivable script hash is ASSERTED equal to its DeploymentParams value
 * (see assertDeploymentScripts). Earlier versions silently overwrote the
 * derived hash with the deployment's, which made a wrong parameterization
 * undetectable until submission.
 */
export function buildDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): ResolvedStandardScripts {
  assertDeploymentScripts(blueprint, deployment);

  const builders = createStandardScripts(blueprint);
  const paramsPolicy = deployment.protocolParams.policyId;

  const plb = deployment.programmableLogicBase.scriptHash;
  const registryPolicy = deployment.registry.scriptHash;
  const mid = deployment.maxInlineDatumBytes;

  return {
    protocolParams: builders.protocolParams(deployment.protocolParams.txInput),
    programmableLogicBase: builders.programmableLogicBase(paramsPolicy),
    transfer: builders.transfer(plb, registryPolicy, mid),
    thirdParty: builders.thirdParty(plb, registryPolicy, mid),
    unfracking: builders.unfracking(plb, registryPolicy, mid),
    programmableLogicGlobal: builders.programmableLogicGlobal(
      deployment.transfer.scriptHash,
      deployment.thirdParty.scriptHash,
      deployment.unfracking.scriptHash,
    ),
    issuanceCborHexMint: builders.issuanceCborHexMint(
      deployment.issuance.txInput,
      deployment.issuance.alwaysFailScriptHash
    ),
    registry: builders.registry(
      deployment.registry.txInput,
      deployment.registry.issuanceScriptHash,
    ),
    buildIssuanceMint(mintingLogicHash: ScriptHash) {
      return builders.issuanceMint(plb, registryPolicy, mintingLogicHash, paramsPolicy);
    },
  };
}

export interface ResolvedStandardScripts {
  /** Mint AND spend in one script; its hash is both policy and address. */
  protocolParams: PlutusScript;
  programmableLogicBase: PlutusScript;
  /** Withdraw-0 delegates. Parameterised (plb, registryPolicy, maxInlineDatumBytes). */
  transfer: PlutusScript;
  /** Seize / clawback. */
  thirdParty: PlutusScript;
  unfracking: PlutusScript;
  /** The dispatcher every programmable transaction withdraws through. */
  programmableLogicGlobal: PlutusScript;
  issuanceCborHexMint: PlutusScript;
  /** Mint AND spend in one script; its hash is both policy and address. */
  registry: PlutusScript;
  /** Build issuance_mint for a specific minting logic — NOT cached */
  buildIssuanceMint(mintingLogicHash: ScriptHash): PlutusScript;
}
