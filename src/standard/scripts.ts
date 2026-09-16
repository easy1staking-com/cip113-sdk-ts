/**
 * Standard script parameterization — CIP-113 0.5.0-alpha.4
 * (upstream 7e8a63198c5b240135f1aa2f043ce5d7c046b2c4).
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

/**
 * Thrown when a deployment record and the blueprint do not describe the same
 * protocol instance.
 *
 * ⛔ IT IS THE CLASS CONSUMERS CATCH, so every refusal from this module must
 * be one. The documented consumer shape is
 * `catch (e) { if (e instanceof DeploymentMismatchError) … }`; a bare `Error`
 * thrown beside it drops silently into whatever generic handler comes next,
 * which is how a refusal that names a field ends up reported as "something went
 * wrong".
 *
 * ⚠ `mismatches` IS EMPTY FOR REFUSALS THAT ARE NOT HASH COMPARISONS, and the
 * emptiness is the signal rather than an oversight: nothing derived disagreed
 * with anything recorded — the record was malformed, or held a value that was
 * never a legal choice. Those pass their own `detail` message, because the
 * composed "N script hash(es) differ" text would describe a comparison that
 * never happened.
 */
export class DeploymentMismatchError extends Error {
  readonly mismatches: ScriptHashCheck[];

  constructor(mismatches: ScriptHashCheck[], blueprintTitle: string, detail?: string) {
    super(
      detail ??
        `Blueprint "${blueprintTitle}" does not reproduce this deployment. ` +
          `${mismatches.length} script hash(es) differ:\n` +
          mismatches
            .map((m) => `  ${m.name}: derived ${m.derived}, deployment says ${m.deployed}`)
            .join("\n") +
          `\nThe blueprint and the DeploymentParams describe different protocol instances. ` +
          `Transactions built from this pairing would be rejected at submission.` +
          dispatcherCauseHint(mismatches)
    );
    this.name = "DeploymentMismatchError";
    this.mismatches = mismatches;
  }
}

/** The name `deriveDeploymentScripts` gives the dispatcher-coherence check. */
const PLG_CHECK_NAME = "programmable_logic_global (dispatcher coherence)";

/**
 * ⚠ THE DISPATCHER CHECK IS REACHABLE FROM THREE CAUSES AND ITS NAME ONLY
 * SUGGESTS ONE. "dispatcher coherence" trains the reader to look for a stale
 * delegate, so a mismatch caused by the RECORDED `unfrackingParameter` sends
 * them to the wrong two fields — and the parameter is the one cause the reader
 * cannot see by comparing the record against itself. The check's name is pinned
 * by `test/deployment-assertion.test.mjs`; the causes are named here instead.
 */
function dispatcherCauseHint(mismatches: ScriptHashCheck[]): string {
  if (!mismatches.some((m) => m.name === PLG_CHECK_NAME)) return "";
  return (
    `\n\n${PLG_CHECK_NAME} is derived from THREE recorded values, and any one of ` +
    `them can cause it:\n` +
    `  transfer.scriptHash\n` +
    `  thirdParty.scriptHash\n` +
    `  programmableLogicGlobal.unfrackingParameter — what the dispatcher was ` +
    `COMPILED AGAINST, which is NOT necessarily unfracking.scriptHash: a deployment ` +
    `may record UNFRACKING_DISABLED here while deploying the real unfracking script ` +
    `beside it. Check this one before the delegates; it is the only one of the three ` +
    `that cannot be checked against anything else in the record.`
  );
}

// ---------------------------------------------------------------------------
// The unfracking parameter — a deployment CHOICE baked into the dispatcher
// ---------------------------------------------------------------------------

/**
 * The `unfracking_hash` a dispatcher is compiled against when the deployment
 * wants unfracking DEPLOYED BUT UNREACHABLE: 28 zero bytes.
 *
 * ⚠ IT IS BAKED INTO THE DISPATCHER'S HASH, so two deployments that chose
 * differently are DIFFERENT PROTOCOLS. Same category as `maxInlineDatumBytes`
 * (see `types.ts`): a deployment CHOICE, recoverable from no hash, which is why
 * `DeploymentParams.programmableLogicGlobal.unfrackingParameter` records the
 * value itself rather than a flag.
 *
 * ⚠ WHY 28 BYTES AND NOT `#""`. The Aiken parameter is a bare `ScriptHash`
 * — a `ByteArray` with no length constraint, not an `Option`, so there is no
 * "none" to reach for. `#""` is type-legal, but NOBODY HERE CAN READ THE
 * COMPILED VALIDATOR'S BODY: whether it asserts a length, or builds an address
 * out of this parameter, is unknown. A 28-byte value is structurally identical
 * to a real script hash, so every path behaves normally.
 * ⇒ Choose a value that cannot reach code we cannot read, rather than reason
 * about what that code probably does.
 *
 * ⚠ NOTHING HASHES TO IT. At 2^224 that is an impossibility, not a low risk,
 * so the sentinel can never collide with a real `unfracking` deployment. Zeros
 * rather than `FF…FF`, which reads as a mask or a placeholder.
 *
 * ⛔ IT LIVES HERE AND NOWHERE ELSE. The platform must IMPORT it. A
 * platform-side copy is a second place to disagree about a value that
 * determines a script hash.
 */
export const UNFRACKING_DISABLED = "00".repeat(28);

/**
 * Refuse a recorded `unfrackingParameter` that is neither of the two values a
 * deployment may legitimately hold.
 *
 * ⛔ THIS IS A TWO-ELEMENT SET MEMBERSHIP, NOT A "DOESN'T MATCH ⇒ SENTINEL"
 * FALLBACK. `if (recorded !== derived) { assume sentinel }` is the shape that
 * passes everything: it accepts a typo, a truncation, and a stale hash from a
 * different deployment — each of which then silently becomes the value the
 * dispatcher is built from. Both candidates are named explicitly, and so is the
 * value that was actually found; the standing discipline is
 * `test/provenance-artefact.test.mjs` — refused by a NAMED assertion, never by
 * a `??`/`||` guess.
 *
 * ⚠ THE CASE ONLY THIS CATCHES, and the reason it has to exist at all: a
 * bootstrap that compiled the dispatcher against a wrong value and then recorded
 * BOTH. Every one of the ten hash checks then reproduces — the record is
 * SELF-CONSISTENT, so there is nothing for a comparison to disagree with — and
 * only this membership test says the parameter was never a legal choice.
 */
const CANONICAL_SCRIPT_HASH = /^[0-9a-f]{56}$/;

/**
 * Read `programmableLogicGlobal.unfrackingParameter` and refuse anything that
 * is not a WELL-FORMED script hash — BEFORE a single script is derived.
 *
 * ⛔ REFUSAL 1, THE OWN-PROPERTY CHECK, AND IT IS NOT DEFENSIVE PROGRAMMING.
 * With `Object.prototype.unfrackingParameter` set, a record with the field
 * GENUINELY ABSENT reads back a value, passes every one of the ten hash checks,
 * and builds the dispatcher from something nobody recorded. MEASURED, not
 * feared. This repo already treats that exact shape as a defect class —
 * `test/ledger-order.test.mjs`, *"refuses an inherited `Object.prototype` key"*
 * — so the standard exists and this call site has to meet it. `in` and a
 * truthiness test both walk the prototype chain; only `hasOwnProperty` does not.
 *
 * ⛔ REFUSAL 2, THE SHAPE CHECK. A stray space, a newline from a copy-paste, a
 * `0x` prefix off a block explorer, a `Uint8Array`, a `Buffer`, `null` — every
 * one of these used to fall through to Evolution's
 * `ParseError: Data.ByteArray … Expected string`, which names NO field, NO
 * record and NO file, in front of an artefact that cannot be regenerated.
 * Fails closed either way; the whole difference is whether the deployer can act
 * on it.
 *
 * ⚠ BYTE-EXACT, AND DELIBERATELY NOT NORMALISING. An uppercase spelling of a
 * legal hash is REFUSED and told it is a CASE problem — never lowercased and
 * accepted. This value is what the dispatcher was COMPILED AGAINST; accepting a
 * record whose spelling differs from what was hashed would re-open the exact
 * hole this ticket exists to close.
 *
 * ⚠ TWO REFUSALS, TWO MESSAGES, AND THEY ANSWER DIFFERENT QUESTIONS — *is this
 * a well-formed script hash?* and *is it one of the two this deployment may
 * record?* (`refuseOnUnfrackingParameter`, below). A reader who cannot tell
 * which one fired cannot act, so they are never merged into one condition.
 */
function readUnfrackingParameter(
  deployment: DeploymentParams,
  blueprintTitle: string,
): ScriptHash {
  const plg = deployment.programmableLogicGlobal;

  if (!Object.prototype.hasOwnProperty.call(plg, "unfrackingParameter")) {
    throw new DeploymentMismatchError(
      [],
      blueprintTitle,
      `programmableLogicGlobal.unfrackingParameter is ABSENT from this deployment ` +
      `record — it has no OWN property of that name. It is REQUIRED and it has no ` +
      `default: it records what programmable_logic_global was COMPILED AGAINST, ` +
      `either the real unfracking script hash or UNFRACKING_DISABLED ` +
      `(${UNFRACKING_DISABLED}), and NOTHING IN THE RECORD DETERMINES WHICH. ` +
      `unfracking.scriptHash is not it: a deployment may deploy, publish and ` +
      `record the real unfracking script while compiling the dispatcher against ` +
      `the sentinel, so defaulting to it would be right often enough that nobody ` +
      `would ever check. Add the field to the record. ` +
      `⚠ An inherited Object.prototype.unfrackingParameter does NOT satisfy this: ` +
      `it would hand the dispatcher a value no deployment recorded.`
    );
  }

  const recorded: unknown = plg.unfrackingParameter;

  if (typeof recorded !== "string" || !CANONICAL_SCRIPT_HASH.test(recorded)) {
    const shown = typeof recorded === "string" ? JSON.stringify(recorded) : describe(recorded);
    const caseOnly =
      typeof recorded === "string" &&
      CANONICAL_SCRIPT_HASH.test(recorded.toLowerCase()) &&
      recorded !== recorded.toLowerCase();
    throw new DeploymentMismatchError(
      [],
      blueprintTitle,
      `programmableLogicGlobal.unfrackingParameter records ${shown}, which is not a ` +
      `well-formed script hash. It must be EXACTLY 56 LOWERCASE HEX CHARACTERS ` +
      `(28 bytes), with no 0x prefix, no whitespace and no surrounding quotes.` +
      (caseOnly
        ? ` ⚠ THIS IS A CASE PROBLEM, AND ONLY A CASE PROBLEM: lowercased, this IS ` +
          `56 hex characters. It is refused rather than normalised because this value ` +
          `is what the dispatcher was COMPILED AGAINST — accepting a spelling that ` +
          `differs from the bytes that were hashed is the ambiguity this field exists ` +
          `to remove. Write it in lowercase in the record.`
        : ``) +
      `\nThis check runs BEFORE any script is derived, so nothing downstream saw ` +
      `this value; without it the failure surfaces inside Evolution's CBOR encoder ` +
      `naming neither the field, the record, nor the file.`
    );
  }

  return recorded;
}

/** A non-string value, described by type rather than by a misleading cast. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const ctor = (value as { constructor?: { name?: string } })?.constructor?.name;
  return `a ${typeof value}${ctor && ctor !== typeof value ? ` (${ctor})` : ``}: ` +
    `${String(value).slice(0, 80)}`;
}

function refuseOnUnfrackingParameter(
  recorded: ScriptHash,
  derivedUnfrackingHash: ScriptHash,
  blueprintTitle: string,
): void {
  if (recorded === derivedUnfrackingHash || recorded === UNFRACKING_DISABLED) return;

  const shown = JSON.stringify(recorded);
  throw new DeploymentMismatchError(
    [],
    blueprintTitle,
    `programmableLogicGlobal.unfrackingParameter records ${shown}, which is neither ` +
    `value a deployment may record. It must be EXACTLY ONE OF:\n` +
    `  ${derivedUnfrackingHash}  — the derived unfracking script hash ` +
    `(unfracking ENABLED: the dispatcher's unfracking arm dispatches to it)\n` +
    `  ${UNFRACKING_DISABLED}  — UNFRACKING_DISABLED ` +
    `(unfracking deployed and published, but the dispatcher's unfracking arm made ` +
    `permanently unsatisfiable)\n` +
    `A third value is a typo, a truncation, or a hash from a different deployment. ` +
    `It is not inferable and it is not defaultable: it is what this dispatcher was ` +
    `COMPILED AGAINST, so a wrong value here means every transaction that withdraws ` +
    `through programmable_logic_global was built for a script that is not on chain.`
  );
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
  /**
   * The recorded `unfrackingParameter` and the derived `unfracking` hash it is
   * checked against. Carried out rather than checked in place so the refusal
   * can be SEQUENCED AFTER the hash mismatches — see the call sites.
   */
  unfrackingParameter: { recorded: ScriptHash; derivedUnfrackingHash: ScriptHash };
}

function deriveDeploymentScripts(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
): DerivedDeployment {
  // ⛔ BEFORE ANY DERIVATION, AND READ EXACTLY ONCE. Two reads of one recorded
  // field are two chances to disagree — this module's own founding lesson — and
  // a guard placed after the first read would be guarding a value the builder
  // had already consumed. `readUnfrackingParameter` refuses an absent or
  // inherited property and a malformed one; `refuseOnUnfrackingParameter` (run
  // after the hash checks, see the call sites) refuses a well-formed value that
  // is not one of the two this deployment may record.
  //
  // ⚠ IT VALIDATES, IT DOES NOT TRANSFORM. The string handed to the builder
  // below is the same string the record holds — no trim, no lowercase, no
  // 0x-strip — so this guard cannot move a single derived hash.
  const recordedUnfrackingParameter = readUnfrackingParameter(
    deployment,
    blueprint.preamble.title,
  );

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
  // ⛔ THE THIRD ARGUMENT IS READ FROM THE RECORD, NOT FROM `unfracking`. A
  // deployment may compile this dispatcher against `UNFRACKING_DISABLED` while
  // deploying, publishing and recording the REAL unfracking script beside it,
  // so `deployment.unfracking.scriptHash` is NOT the value that was hashed —
  // only `programmableLogicGlobal.unfrackingParameter` says what was. Reading
  // the wrong one derives a dispatcher hash for a script nobody deployed, and
  // the failure surfaces at withdrawal time naming neither field.
  //
  // ⚠ It is used unvalidated HERE and refused by `refuseOnUnfrackingParameter`
  // before either public entry point returns — see the call sites for why the
  // refusal is sequenced after the hash mismatches rather than before them.
  const programmableLogicGlobal = builders.programmableLogicGlobal(
    deployment.transfer.scriptHash,
    deployment.thirdParty.scriptHash,
    recordedUnfrackingParameter,
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
      //
      // ⚠ AND IT IS NOW REACHABLE FROM THREE CAUSES, NOT ONE. Its name says
      // "stale delegates", but the third derivation input is the RECORDED
      // `programmableLogicGlobal.unfrackingParameter` — so a record that
      // compiled against `UNFRACKING_DISABLED` and then wrote the enabled
      // dispatcher's hash (or the reverse) fails HERE, with a name pointing at
      // the two fields that are fine. The parameter is also the only one of the
      // three that cannot be cross-checked against anything else in the record.
      // `dispatcherCauseHint` names all three in the thrown message; do not let
      // this comment and that message drift apart.
      name: PLG_CHECK_NAME,
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
    unfrackingParameter: {
      recorded: recordedUnfrackingParameter,
      derivedUnfrackingHash: unfracking.hash,
    },
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
  const { checks, unfrackingParameter } = deriveDeploymentScripts(blueprint, deployment);
  refuseOnMismatch(checks, blueprint.preamble.title);
  // ⚠ ORDER IS DELIBERATE, AND IT IS NOT A CONDITIONAL. A wrong
  // `maxInlineDatumBytes` moves the derived `unfracking` hash, which would let a
  // parameter complaint pre-empt — and hide — the four named delegate
  // mismatches that say what actually went wrong. Hash disagreements are
  // reported first, by name; this refusal is what is left when all ten
  // reproduce and the record is nevertheless not a legal deployment.
  refuseOnUnfrackingParameter(
    unfrackingParameter.recorded,
    unfrackingParameter.derivedUnfrackingHash,
    blueprint.preamble.title,
  );
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
  const { builders, paramsPolicy, scripts, checks, unfrackingParameter } =
    deriveDeploymentScripts(blueprint, deployment);
  refuseOnMismatch(checks, blueprint.preamble.title);
  // Same refusal, same order, as `assertDeploymentScripts` — the resolved
  // surface must never be built from a parameter the assertion would reject.
  refuseOnUnfrackingParameter(
    unfrackingParameter.recorded,
    unfrackingParameter.derivedUnfrackingHash,
    blueprint.preamble.title,
  );

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
