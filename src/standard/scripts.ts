/**
 * Standard script parameterization — CIP-113 0.5.0-alpha.4 (upstream d37ca8d).
 *
 * Uses Evolution SDK directly for UPLC.applyParamsToScript and ScriptHash.
 *
 * Dependency graph. It is NOT a single chain: `programmable_logic_base` hangs
 * off the params-NFT policy, so everything downstream of it fans out in
 * parallel rather than in series.
 *
 *   always_fail(nonce)                          -> hash   (issuance side only)
 *   protocol_params(utxo_ref)                   -> policy  == params_policy
 *     |
 *     +-- programmable_logic_base(params_policy)                  -> hash  == plb
 *     |     |
 *     |     +-- transfer(Script(plb), registry_node_cs, max_inline)     -> hash
 *     |     +-- third_party(Script(plb), registry_node_cs, max_inline)  -> hash
 *     |     +-- unfracking(Script(plb), registry_node_cs, max_inline)   -> hash
 *     |     +-- issuance_logic(Script(plb), registry_node_cs,
 *     |                        params_policy, max_inline)              -> hash  NEW in alpha.4
 *     |
 *     +-- issuance_mint(Script(minting_logic), params_policy)     -> policy
 *
 *   programmable_logic_global(transfer_hash, third_party_hash, unfracking_hash)
 *                                                                -> hash   (built LAST)
 *
 *   issuance_cbor_hex_mint(utxo_ref, always_fail_hash)            -> policy
 *   registry(utxo_ref, issuance_cbor_hex_cs)                      -> policy
 *
 *   upgrade_multisig(utxo_ref)                  -> hash   (independent one-shot)
 *
 * ⚠ PARAMETER TYPES ARE NOT INTERCHANGEABLE and TypeScript cannot tell them
 * apart — every one of these is a hex string at the call site. `params_policy`
 * and `registry_node_cs` are PolicyIds (bare ByteArrays); `minting_logic_cred`
 * and `programmable_logic_base` are Credentials (constructor-wrapped
 * Script/VerificationKey). `scriptCredential()` wraps; `Data.bytearray()` does
 * not. Passing a policy where a credential belongs produces a valid script with
 * the wrong hash.
 *
 * ⛔ alpha.4 makes that sharper: `issuance_logic` takes TWO ADJACENT PolicyId
 * parameters — `registry_node_cs` then `params_policy`. They are the same type,
 * the same length, and both are `string` here. Swapping them yields a script
 * that builds, hashes and deploys, and nothing before the ledger will say so.
 *
 * The types below come from the blueprint's own parameter schemas, not from
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

  /**
   * `upgrade_multisig` — a ONE-SHOT in alpha.4: `(signers, threshold)` are gone
   * and a single `utxo_ref` takes their place.
   *
   * ⚑ ONE VALUE, THREE ROLES. Its hash is the config NFT's POLICY ID, the
   * config UTxO's ADDRESS payment credential, AND the withdraw-0 CREDENTIAL the
   * upgrade authority is satisfied by. Do not derive any of the three
   * separately — that is the dual-hash collapse of `protocol_params` and
   * `registry` again, with one more role attached.
   *
   * The signer set moved OFF the parameters and INTO a `MultisigScript` tree in
   * the config UTxO's datum, so rotating signers no longer changes the hash.
   * Build those trees with `multisigScriptDatum` in `src/core/evo-utils.ts`
   * (T-F02-1), which enforces upstream's `well_formed`.
   */
  upgradeMultisig(utxoRef: TxInput): PlutusScript;
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

  /**
   * `issuance_mint` — arity 4 -> 2 in alpha.4.
   *
   * ⚠ `programmable_logic_base` and `registry_node_cs` are GONE from its
   * parameters. It reads the delegate credentials out of the params datum at
   * runtime instead, which is why `params_policy` survives and the other two do
   * not. Its POLICY ID therefore CHANGES for the same minting logic — see
   * {@link ResolvedStandardScripts.buildIssuanceMint}.
   */
  issuanceMint(mintingLogicHash: ScriptHash, paramsPolicy: PolicyId): PlutusScript;

  /**
   * `issuance_logic` — NEW in alpha.4. The replaceable half of issuance: the
   * params datum's field 1 names its credential, and its withdraw-0 rides on
   * EVERY mint and burn.
   *
   * ⛔ ONE CREDENTIAL, THEN TWO BARE POLICIES, AND THE TWO POLICIES ARE NOT
   * INTERCHANGEABLE. `progLogicCred` is constructor-wrapped by
   * `scriptCredential()`; `registryPolicy` and `paramsPolicy` are bare
   * ByteArrays applied in THAT ORDER (`registry_node_cs`, then
   * `params_policy`). Both are `string` at the call site and nothing — not the
   * compiler, not the parameteriser, not the hash — can tell a swap from the
   * intended order.
   *
   * ⚠ `progLogicCred` is programmable_logic_base's hash, NOT the dispatcher's,
   * exactly as for the three delegates.
   */
  issuanceLogic(
    progLogicCred: ScriptHash,
    registryPolicy: PolicyId,
    paramsPolicy: PolicyId,
    maxInlineDatumBytes: number | bigint,
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

    upgradeMultisig(utxoRef) {
      return parameterize(STANDARD_VALIDATORS.UPGRADE_MULTISIG, [outputReference(utxoRef)]);
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

    issuanceMint(mintingLogicHash, paramsPolicy) {
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_MINT, [
        scriptCredential(mintingLogicHash),
        Data.bytearray(paramsPolicy),
      ]);
    },

    issuanceLogic(progLogicCred, registryPolicy, paramsPolicy, maxInlineDatumBytes) {
      // Credential, then TWO bare PolicyIds in blueprint order
      // (registry_node_cs, params_policy), then the Int. See the interface
      // doc: the two policies are the swap hazard alpha.4 introduced.
      return parameterize(STANDARD_VALIDATORS.ISSUANCE_LOGIC, [
        scriptCredential(progLogicCred),
        Data.bytearray(registryPolicy),
        Data.bytearray(paramsPolicy),
        Data.int(BigInt(maxInlineDatumBytes)),
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
 * Not covered: always_fail (its nonce is not carried in DeploymentParams) and
 * issuance_mint (parameterized per minting logic, so there is no single hash to
 * assert). `upgrade_multisig` NO LONGER BELONGS ON THAT LIST — alpha.4
 * parameterises it by a recordable `utxo_ref`, so it is derived and checked
 * again; see the block beside its check.
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
/**
 * Everything one derivation of a deployment produces: the scripts themselves,
 * the derived-vs-deployed comparisons over them, and the builders they came
 * from.
 *
 * ⛔ INTERNAL, AND IT EXISTS TO MAKE ONE FACT HAVE ONE DERIVATION. Before this,
 * `assertDeploymentScripts` derived ten scripts and compared them to the record,
 * and `buildDeploymentScripts` then derived the SAME TEN AGAIN from its own
 * argument expressions and returned THOSE. The assertion checked the first set;
 * the second set was what every substandard actually built transactions from,
 * and nothing compared it to anything.
 *
 * ⚠ MEASURED, not feared: swapping `issuance_logic`'s two same-typed PolicyIds
 * at the resolution site alone, or reading `protocolParams.txInput` where
 * `upgradeMultisig.txInput` belonged there, left every assertion green and the
 * whole offline suite passing — while the resolved script was the wrong one.
 * That is the S-11 defect's exact shape (two derivations of one fact, only one
 * guarded) at a call site nobody was looking at.
 *
 * ⇒ Both public functions now go through here, so the script the assertion
 * checked IS the object the resolved surface returns — the same reference, not
 * an equal-looking rebuild.
 */
interface DerivedDeployment {
  /** The builders these scripts came from, so `buildIssuanceMint` reuses them. */
  builders: StandardScripts;
  /** `protocol_params`'s hash: the NFT policy AND the params address. */
  paramsPolicy: PolicyId;
  /** Every parameterisable standard script, derived exactly once. */
  scripts: Omit<ResolvedStandardScripts, "buildIssuanceMint">;
  /** One comparison per script above, in the same order. */
  checks: ScriptHashCheck[];
}

function deriveDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): DerivedDeployment {
  const builders = createStandardScripts(blueprint);

  const plb = deployment.programmableLogicBase.scriptHash;
  const registryPolicy = deployment.registry.scriptHash;
  const paramsPolicy = deployment.protocolParams.policyId;
  const mid = deployment.maxInlineDatumBytes;

  // ⚑ ONE call per script. Every `derived` field below reads a `.hash` off one
  // of these objects, and `scripts` returns the very same objects — so a wrong
  // argument here is caught by the check beside it rather than surviving into
  // the resolved surface.
  const protocolParams = builders.protocolParams(deployment.protocolParams.txInput);
  const programmableLogicBase = builders.programmableLogicBase(paramsPolicy);
  const transfer = builders.transfer(plb, registryPolicy, mid);
  const thirdParty = builders.thirdParty(plb, registryPolicy, mid);
  const unfracking = builders.unfracking(plb, registryPolicy, mid);
  const programmableLogicGlobal = builders.programmableLogicGlobal(
    deployment.transfer.scriptHash,
    deployment.thirdParty.scriptHash,
    deployment.unfracking.scriptHash,
  );
  const issuanceCborHexMint = builders.issuanceCborHexMint(
    deployment.issuance.txInput,
    deployment.issuance.alwaysFailScriptHash,
  );
  const registry = builders.registry(
    deployment.registry.txInput,
    deployment.registry.issuanceScriptHash,
  );
  const issuanceLogic = builders.issuanceLogic(plb, registryPolicy, paramsPolicy, mid);
  const upgradeMultisig = builders.upgradeMultisig(deployment.upgradeMultisig.txInput);

  const checks: ScriptHashCheck[] = [
    {
      // ⚑ ONE derivation for what used to be two. The params NFT policy and the
      // params address's payment credential are the same value in alpha.3, so
      // deriving them separately is not "belt and braces" — it is two chances
      // to disagree about one fact.
      name: "protocol_params (policy == address)",
      derived: protocolParams.hash,
      deployed: deployment.protocolParams.policyId,
    },
    {
      name: "programmable_logic_base",
      derived: programmableLogicBase.hash,
      deployed: plb,
    },
    {
      name: "transfer",
      derived: transfer.hash,
      deployed: deployment.transfer.scriptHash,
    },
    {
      name: "third_party",
      derived: thirdParty.hash,
      deployed: deployment.thirdParty.scriptHash,
    },
    {
      name: "unfracking",
      derived: unfracking.hash,
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
      derived: programmableLogicGlobal.hash,
      deployed: deployment.programmableLogicGlobal.scriptHash,
    },
    {
      name: "issuance_cbor_hex_mint",
      derived: issuanceCborHexMint.hash,
      deployed: deployment.issuance.policyId,
    },
    {
      // ⚑ Also one derivation for what used to be two (registry_mint's policy
      // and registry_spend's address).
      name: "registry (policy == address)",
      derived: registry.hash,
      deployed: registryPolicy,
    },
    {
      // ⛔ THE FOURTH CONSUMER OF `mid`. transfer, third_party and unfracking
      // were three; alpha.4's issuance_logic is the fourth, and the count is
      // the mechanism: the negative test asserting FOUR mismatches for a wrong
      // `maxInlineDatumBytes` is what proves this call site exists. A comment
      // cannot prove a call site; a count can.
      //
      // ⚠ Argument order is `(plb, registry_node_cs, params_policy, mid)` and
      // the middle two are both bare PolicyIds. Swapping them builds, hashes
      // and deploys — see the adjacent-parameter negative in
      // test/deployment-assertion.test.mjs.
      name: "issuance_logic",
      derived: issuanceLogic.hash,
      deployed: deployment.issuanceLogic.scriptHash,
    },
    {
      // ⛔ CHECKED AGAIN, AND THE REASON IT CAN BE IS THE WHOLE CHANGE. This
      // check was REMOVED in S-11 after it shipped a defect: it derived
      // `upgrade_multisig` from `upgradeAuthority.hash`, a relationship that
      // never existed (a PAYMENT key hash matched against `extra_signatories`
      // versus the STAKE credential named in the params datum). alpha.3 could
      // not derive it at all — its signer set and threshold were a deployment
      // CHOICE that DeploymentParams did not record. alpha.4 replaces both
      // parameters with a single `utxo_ref`, which IS recorded, so the hash is
      // derivable and the check comes back.
      //
      // ⚠ AND THE VACUITY TRAP COMES BACK WITH IT, IN A NEW SHAPE. What hid the
      // S-11 bug was a fixture using ONE value for two fields, so the wrong
      // derivation reproduced perfectly and the check passed vacuously — only a
      // live devnet exposed it. DeploymentParams now holds TWO one-shot
      // `TxInput`s of identical type: `protocolParams.txInput` and
      // `upgradeMultisig.txInput`. A fixture that reuses one for both makes
      // this check pass no matter which one the code reads.
      //
      // ⛔ Do NOT add any check relating `upgradeAuthority` to
      // `upgradeMultisig`. A deployment may legitimately name a key credential,
      // a different script, or the multisig as its authority, and the validator
      // never inspects it. Such a check would reject valid deployments — it is
      // the S-11 defect returning under a new name.
      name: "upgrade_multisig",
      derived: upgradeMultisig.hash,
      deployed: deployment.upgradeMultisig.scriptHash,
    },
  ];

  return {
    builders,
    paramsPolicy,
    scripts: {
      protocolParams,
      programmableLogicBase,
      transfer,
      thirdParty,
      unfracking,
      programmableLogicGlobal,
      issuanceCborHexMint,
      registry,
      issuanceLogic,
      upgradeMultisig,
    },
    checks,
  };
}

/** Throw if any derived hash disagrees with the deployment record. */
function refuseOnMismatch(checks: ScriptHashCheck[], blueprintTitle: string): void {
  const mismatches = checks.filter((c) => c.derived !== c.deployed);
  if (mismatches.length > 0) {
    throw new DeploymentMismatchError(mismatches, blueprintTitle);
  }
}

export function assertDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): ScriptHashCheck[] {
  const { checks } = deriveDeploymentScripts(blueprint, deployment);
  refuseOnMismatch(checks, blueprint.preamble.title);
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
  // ⚑ ONE FACT, ONE DERIVATION — and this line is what makes that phrase true
  // rather than aspirational. The scripts returned below are the SAME OBJECTS
  // whose hashes were just checked, not a second build from the same arguments.
  // A second build is a second chance to disagree, and it WAS unguarded here:
  // see the block on `DerivedDeployment`.
  const { builders, paramsPolicy, scripts, checks } = deriveDeploymentScripts(
    blueprint,
    deployment,
  );
  refuseOnMismatch(checks, blueprint.preamble.title);

  return {
    ...scripts,
    buildIssuanceMint(mintingLogicHash: ScriptHash) {
      // ⚑ ITS SIGNATURE IS UNCHANGED AND ITS RESULT IS NOT. alpha.4 dropped
      // `programmable_logic_base` and `registry_node_cs` from issuance_mint's
      // parameters, so THE POLICY ID CHANGES FOR THE SAME MINTING LOGIC. That
      // is correct, not a bug to fix: an alpha.3 token and an alpha.4 token
      // built from identical issuance logic are different assets.
      //
      // ⚠ NOT part of the single-derivation collapse above, and cannot be: it
      // is parameterised per minting logic, so there is no one hash for
      // `assertDeploymentScripts` to check. It stays uncovered, as the
      // assertion's own "Not covered" note says.
      return builders.issuanceMint(mintingLogicHash, paramsPolicy);
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
  /**
   * The replaceable half of issuance (alpha.4). Its withdraw-0 rides on every
   * mint and burn, and its credential must be REGISTERED to do so.
   */
  issuanceLogic: PlutusScript;
  /**
   * The reference upgrade authority. ⚑ Its hash is the config NFT policy, the
   * config UTxO's address payment credential, AND the withdraw-0 credential —
   * one value, three roles.
   */
  upgradeMultisig: PlutusScript;
  /** Build issuance_mint for a specific minting logic — NOT cached */
  buildIssuanceMint(mintingLogicHash: ScriptHash): PlutusScript;
}
