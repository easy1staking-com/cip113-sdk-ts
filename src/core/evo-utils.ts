/**
 * Shared Evolution SDK utility functions.
 *
 * These are used across the SDK to build scripts, addresses, datums, and
 * perform common conversions. All use Evolution SDK types directly.
 */

import {
  Data,
  Bytes,
  ScriptHash as EvoScriptHash,
  Script,
  UPLC,
  Address as EvoAddress,
  AddressEras,
  BaseAddress,
  EnterpriseAddress,
  RewardAccount,
  Assets,
  Credential,
  InlineDatum,
  KeyHash,
  TransactionHash,
  UTxO as EvoUTxO,
  Transaction,
  TxOut,
} from "@evolution-sdk/evolution";
import * as Label from "@evolution-sdk/evolution/Label";

import type { HexString, PlutusScript, PolicyId, ScriptHash, TxInput } from "../types.js";

const PlutusV3 = Script.Script.members[3] as { new (opts: { bytes: Uint8Array }): Script.Script };

// ---------------------------------------------------------------------------
// Script building
// ---------------------------------------------------------------------------

/**
 * Build a PlutusV3 script object from compiled code hex.
 *
 * Handles CBOR encoding levels: if "double" (from applyParamsToScript),
 * strips outer CBOR header to get single-CBOR for PlutusV3.
 */
export function buildEvoScript(compiledCode: HexString): Script.Script {
  const level = UPLC.getCborEncodingLevel(compiledCode);

  if (level === "double") {
    const raw = Bytes.fromHex(compiledCode);
    const additionalInfo = raw[0] & 0x1f;
    const headerLen = additionalInfo < 24 ? 1 : additionalInfo === 24 ? 2 : additionalInfo === 25 ? 3 : 5;
    const innerBytes = raw.slice(headerLen);
    return new PlutusV3({ bytes: innerBytes });
  }

  return new PlutusV3({ bytes: Bytes.fromHex(compiledCode) });
}

/**
 * Parameterize a script and compute its hash.
 * Returns a PlutusScript with compiledCode and hash.
 */
export function parameterizeScript(
  compiledCode: HexString,
  params: Data.Data[]
): PlutusScript {
  const parameterized = UPLC.applyParamsToScript(compiledCode, params);
  const script = buildEvoScript(parameterized);
  const hash = EvoScriptHash.toHex(EvoScriptHash.fromScript(script));
  return { type: "PlutusV3", compiledCode: parameterized, hash };
}

/**
 * Compute script hash from compiled code.
 */
export function computeScriptHash(compiledCode: HexString): ScriptHash {
  const script = buildEvoScript(compiledCode);
  return EvoScriptHash.toHex(EvoScriptHash.fromScript(script));
}

// ---------------------------------------------------------------------------
// Address building
// ---------------------------------------------------------------------------

/**
 * Build an enterprise (script-only) address from a script hash.
 */
export function scriptAddress(networkId: number, scriptHash: ScriptHash): string {
  const cred = new EvoScriptHash.ScriptHash({ hash: Bytes.fromHex(scriptHash) });
  const addr = new EnterpriseAddress.EnterpriseAddress({ networkId, paymentCredential: cred });
  return AddressEras.toBech32(addr);
}

/**
 * Build a reward (staking) address from a script hash.
 */
/**
 * Build a reward (staking) address from a KEY hash.
 *
 * The script-hash variant below covers protocol credentials; this one covers a
 * wallet's own stake key — the upgrade authority, for instance, whose
 * registration survives across deployments and therefore has to be CHECKED
 * rather than assumed.
 */
export function rewardAddressFromKeyHash(networkId: number, keyHash: HexString): string {
  const cred = new KeyHash.KeyHash({ hash: Bytes.fromHex(keyHash) });
  const addr = new RewardAccount.RewardAccount({ networkId, stakeCredential: cred });
  return AddressEras.toBech32(addr);
}

export function rewardAddress(networkId: number, scriptHash: ScriptHash): string {
  const cred = new EvoScriptHash.ScriptHash({ hash: Bytes.fromHex(scriptHash) });
  const addr = new RewardAccount.RewardAccount({ networkId, stakeCredential: cred });
  return AddressEras.toBech32(addr);
}

/**
 * Build a base address with script payment credential and user's staking credential.
 */
export function baseAddress(networkId: number, scriptHash: ScriptHash, userAddress: string): string {
  const stakingHash = stakingCredentialHash(userAddress);
  const addr = new BaseAddress.BaseAddress({
    networkId,
    paymentCredential: new EvoScriptHash.ScriptHash({ hash: Bytes.fromHex(scriptHash) }),
    stakeCredential: new KeyHash.KeyHash({ hash: Bytes.fromHex(stakingHash) }),
  });
  return AddressEras.toBech32(addr);
}

/**
 * Extract the staking credential hash from a bech32 address.
 */
export function stakingCredentialHash(address: string): HexString {
  const evoAddr = EvoAddress.fromBech32(address);
  const ba = BaseAddress.fromHex(EvoAddress.toHex(evoAddr));
  return Bytes.toHex(ba.stakeCredential.hash);
}

/**
 * Extract the payment credential hash from a bech32 address.
 */
export function paymentCredentialHash(address: string): HexString {
  const evoAddr = EvoAddress.fromBech32(address);
  const ba = BaseAddress.fromHex(EvoAddress.toHex(evoAddr));
  return Bytes.toHex(ba.paymentCredential.hash);
}

// ---------------------------------------------------------------------------
// Data construction helpers (Cardano-specific)
// ---------------------------------------------------------------------------

/** OutputReference: Constr(0, [txHash, outputIndex]) */
export function outputReference(ref: TxInput): Data.Data {
  return Data.constr(0n, [
    Data.bytearray(ref.txHash),
    Data.int(BigInt(ref.outputIndex)),
  ]);
}

/** Script credential: Constr(1, [scriptHash]) */
export function scriptCredential(hash: ScriptHash): Data.Data {
  return Data.constr(1n, [Data.bytearray(hash)]);
}

/** Verification key credential: Constr(0, [keyHash]) */
export function keyCredential(hash: HexString): Data.Data {
  return Data.constr(0n, [Data.bytearray(hash)]);
}

/** Void / unit: Constr(0, []) */
export function voidData(): Data.Data {
  return Data.constr(0n, []);
}

// ---------------------------------------------------------------------------
// Datum parsing (from on-chain Evolution SDK UTxO datums)
// ---------------------------------------------------------------------------

/**
 * Extract a bytes field from a Constr datum at a given index.
 * Works with Evolution SDK's Data.Constr format.
 */
export function extractConstrBytesField(datum: unknown, fieldIndex: number): string | undefined {
  if (!datum || typeof datum !== "object") return undefined;

  // Evolution SDK Constr: check with Data.isConstr
  if (Data.isConstr(datum as Data.Data)) {
    const constr = datum as unknown as { index: bigint; fields: readonly Data.Data[] };
    const field = constr.fields[fieldIndex];
    if (field == null) return undefined;

    if (Data.isBytes(field)) {
      return Bytes.toHex(field as unknown as Uint8Array);
    }
    return undefined;
  }

  return undefined;
}

/**
 * Extract a credential (type + hash) from a constr datum field.
 * Credential is Constr(0|1, [bytes]) — 0 = key, 1 = script.
 */
export function extractCredentialField(
  datum: unknown,
  fieldIndex: number
): { type: "key" | "script"; hash: string } | undefined {
  if (!datum || typeof datum !== "object") return undefined;

  if (Data.isConstr(datum as Data.Data)) {
    const constr = datum as unknown as { index: bigint; fields: readonly Data.Data[] };
    const field = constr.fields[fieldIndex];
    if (!field || !Data.isConstr(field)) return undefined;

    const credConstr = field as unknown as { index: bigint; fields: readonly Data.Data[] };
    const type = credConstr.index === 0n ? "key" as const : "script" as const;
    const inner = credConstr.fields[0];
    if (!inner) return { type, hash: "" };

    if (Data.isBytes(inner)) {
      return { type, hash: Bytes.toHex(inner as unknown as Uint8Array) };
    }
    return { type, hash: "" };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Datum builders (CIP-113 domain types)
// ---------------------------------------------------------------------------

export interface Cip113Credential {
  type: "key" | "script";
  hash: ScriptHash;
}

function credToData(cred: Cip113Credential): Data.Data {
  return cred.type === "script" ? scriptCredential(cred.hash) : keyCredential(cred.hash);
}

function dataToCred(d: Data.Data, where: string): Cip113Credential {
  if (!(d instanceof Data.Constr) || d.fields.length !== 1) {
    throw new Error(`${where}: expected a Credential (Constr with 1 field)`);
  }
  const h = expectBytes(d.fields[0]!, `${where}.hash`);
  if (d.index === 0n) return { type: "key", hash: h };
  if (d.index === 1n) return { type: "script", hash: h };
  throw new Error(`${where}: credential constructor index must be 0 or 1, got ${d.index}`);
}

/**
 * Data.bytearray() yields a Uint8Array, NOT a hex string — so every decode has
 * to convert. Done by hand rather than via Buffer: this SDK runs in browsers on
 * the CIP-30 path, where Buffer does not exist.
 */
function bytesToHex(u8: Uint8Array): HexString {
  let out = "";
  for (const b of u8) out += b.toString(16).padStart(2, "0");
  return out;
}

function expectBytes(d: Data.Data, where: string): HexString {
  if (d instanceof Uint8Array) return bytesToHex(d);
  if (typeof d === "string") return d;
  throw new Error(`${where}: expected a bytearray, got ${typeof d}`);
}

/**
 * A registry node — the per-token record the directory holds.
 *
 * SEVEN fields in 0.5.0-alpha.2, and the order is load-bearing: this is a
 * positional Constr, so an insertion at the wrong index produces a datum that
 * encodes cleanly and means something else entirely.
 *
 * Two fields were inserted, at different times, in the middle:
 *   index 2  minting_logic_script      (upstream #52)
 *   index 5  unfracking_logic_script   (unfracking v2)
 *
 * ⚠ Upstream's CONTRACT_SURFACE_CHANGES.md asserts this SDK was "already on the
 * 6-field post-#52 shape (verified: minting_logic_script at index 2)". It was
 * NOT — this builder emitted five fields with no minting_logic_script at all.
 * That document is wrong about this repository's own contents; do not take its
 * word for what is or is not already done here.
 */
export interface RegistryNodeData {
  key: HexString;
  next: HexString;
  /** index 2 — added by #52. */
  mintingLogicScript: Cip113Credential;
  transferLogicScript: Cip113Credential;
  thirdPartyTransferLogicScript: Cip113Credential;
  /** index 5 — added by unfracking v2. */
  unfrackingLogicScript: Cip113Credential;
  globalStateCs: HexString;
}

/** Build a RegistryNode datum. Field order is the on-chain contract. */
export function registryNodeDatum(node: RegistryNodeData): Data.Data {
  return Data.constr(0n, [
    Data.bytearray(node.key),
    Data.bytearray(node.next),
    credToData(node.mintingLogicScript),
    credToData(node.transferLogicScript),
    credToData(node.thirdPartyTransferLogicScript),
    credToData(node.unfrackingLogicScript),
    Data.bytearray(node.globalStateCs),
  ]);
}

/** Parse a RegistryNode datum. Strict on arity — a short record is not a partial one. */
export function decodeRegistryNode(d: Data.Data): RegistryNodeData {
  if (!(d instanceof Data.Constr) || d.index !== 0n) {
    throw new Error("RegistryNode: expected Constr(0, ...)");
  }
  if (d.fields.length !== 7) {
    throw new Error(
      `RegistryNode: expected exactly 7 fields, got ${d.fields.length}. ` +
        `The 5-field (pre-#52) and 6-field (pre-unfracking-v2) layouts are NOT ` +
        `forward-compatible: minting_logic_script was inserted at index 2 and ` +
        `unfracking_logic_script at index 5, so every later field shifted.`
    );
  }
  const f = d.fields;
  return {
    key: expectBytes(f[0]!, "RegistryNode.key"),
    next: expectBytes(f[1]!, "RegistryNode.next"),
    mintingLogicScript: dataToCred(f[2]!, "RegistryNode.mintingLogicScript"),
    transferLogicScript: dataToCred(f[3]!, "RegistryNode.transferLogicScript"),
    thirdPartyTransferLogicScript: dataToCred(f[4]!, "RegistryNode.thirdPartyTransferLogicScript"),
    unfrackingLogicScript: dataToCred(f[5]!, "RegistryNode.unfrackingLogicScript"),
    globalStateCs: expectBytes(f[6]!, "RegistryNode.globalStateCs"),
  };
}

/**
 * Minimum lovelace for an output carrying a RegistryNode datum plus its NFT.
 *
 * ⚑ ONE constant, deliberately, because this defect has now been introduced
 * THREE TIMES INDEPENDENTLY — in the bootstrap, in `dummy`, and in
 * `freeze-and-seize` — each time by someone (me) who had already fixed it
 * elsewhere and did not think to check the next site.
 *
 * The cause is always the same: min-UTxO scales with SERIALISED OUTPUT SIZE, so
 * widening a datum raises the floor of every output that carries it. The
 * RegistryNode datum went from FIVE fields to SEVEN in 0.5.x, and the inherited
 * 2,000,000 was sized for the five-field shape. MEASURED requirement for the
 * seven-field shape: 2,038,630.
 *
 * The ledger reports the shortfall as "insufficient Ada" with a number and
 * NEVER as "your datum grew", so it surfaces as an unrelated funding error,
 * often in a different ticket from the change that caused it.
 *
 * A rule written in a document has to be REMEMBERED. A constant has to be
 * CHANGED. Deliberately generous: min-UTxO also moves with protocol parameters.
 */
export const REGISTRY_NODE_MIN_ADA = 3_000_000n;

/**
 * The ledger's per-UTxO byte overhead, from the Babbage min-UTxO rule
 * (`utxoEntrySize` = serialised output size + a fixed constant). Evolution uses
 * the same value internally; it is restated here rather than imported because
 * its home is `sdk/builders/internal/`, and this package does not reach into a
 * dependency's internals.
 */
const UTXO_ENTRY_OVERHEAD_BYTES = 160n;

/**
 * The minimum lovelace an output must carry, computed from PROTOCOL PARAMETERS
 * and the output's own serialised size.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN ANOTHER CONSTANT. min-UTxO scales with
 * SERIALISED OUTPUT SIZE, and three things that scale it are supplied by the
 * CALLER, not by us:
 *   - the CIP-68 metadata datum (name/description/ticker/url/logo). This
 *     package imposes no length caps at all, so the datum is UNBOUNDED.
 *   - the ASSET NAME. CIP-67-labelled names run to 32 bytes, and this package's
 *     API takes raw hex names at every boundary.
 *   - the QUANTITY, which is a CBOR integer and widens with magnitude.
 *
 * ⛔ AND EVOLUTION DOES NOT RESCUE AN UNDER-FUNDED OUTPUT. MEASURED on preview
 * (2026-09-01): `calculateMinimumUtxoLovelace` is applied ONLY to CHANGE and
 * unfracking outputs. An explicit `payToAddress` amount is passed through
 * verbatim — a build with a deliberately short datum-bearing output produced a
 * transaction carrying exactly the requested lovelace. The shortfall therefore
 * survives to submission, where the ledger rejects it as "insufficient Ada"
 * with a number and NEVER as "your datum grew".
 *
 * A flat constant cannot be right for an input the caller controls. This is the
 * successor to {@link REGISTRY_NODE_MIN_ADA}'s "deliberately generous" habit:
 * generous is a guess, and it was already wrong at 3 ADA for a CIP-68 datum
 * whose fields sit within a consumer's own documented caps.
 *
 * Built from PUBLIC Evolution API only, and solved as a fixed point because the
 * lovelace figure is itself part of what gets serialised.
 */
export function minUtxoForOutput(params: {
  /** Bech32 address the output pays to. */
  address: string;
  /** The output's assets. Its lovelace component is ignored and solved for. */
  assets: Assets.Assets;
  /** Inline datum the output will carry, if any. */
  datum?: Data.Data;
  /** `coinsPerUtxoByte` from the live protocol parameters. */
  coinsPerUtxoByte: bigint;
}): bigint {
  const address = EvoAddress.fromBech32(params.address);
  const datumOption = params.datum
    ? new InlineDatum.InlineDatum({ data: params.datum })
    : undefined;

  const required = (lovelace: bigint): bigint => {
    const output = new TxOut.TransactionOutput({
      address,
      assets: Assets.withLovelace(params.assets, lovelace),
      datumOption,
    });
    const size = BigInt(TxOut.toCBORBytes(output).length);
    return params.coinsPerUtxoByte * (UTXO_ENTRY_OVERHEAD_BYTES + size);
  };

  // Writing a larger number widens the CBOR, which raises the requirement. Two
  // or three rounds converge; the cap only stops a pathological non-convergence
  // from hanging a transaction build.
  let current = 0n;
  for (let i = 0; i < 10; i++) {
    const next = required(current);
    if (next === current) return next;
    current = next;
  }
  throw new Error(
    `min-UTxO did not converge after 10 iterations (last ${current} lovelace). ` +
      `This should not happen for a well-formed output; report it with the datum.`
  );
}

/** Round up to a whole ADA. */
export function ceilToWholeAda(lovelace: bigint): bigint {
  return ((lovelace + 999_999n) / 1_000_000n) * 1_000_000n;
}

/**
 * min-UTxO for an output, never returning less than `floor`.
 *
 * The floor keeps this change MONOTONE: every value this package used to emit
 * is preserved for ordinary inputs, and the figure only ever rises — where it
 * had to. A fix that lowered an amount would be a behaviour change smuggled in
 * beside a bug fix.
 */
export function minUtxoAtLeast(
  floor: bigint,
  params: Parameters<typeof minUtxoForOutput>[0],
): bigint {
  const computed = minUtxoForOutput(params);
  return computed > floor ? computed : floor;
}

// ---------------------------------------------------------------------------
// The coordination datum — the live protocol wiring
// ---------------------------------------------------------------------------

/**
 * `ProgrammableLogicGlobalParams` — the datum on the protocol-params UTxO.
 *
 * SIX fields in 0.5.0-alpha.4, ordered by upstream BY READ FREQUENCY:
 *
 *   0  plg_cred              <- programmable_logic_base, once per programmable INPUT
 *   1  issuance_logic_cred   <- issuance_mint, once per issuance tx (mint AND burn)
 *   2  transfer_cred         <- issuance_logic, precise delegation (audit finding 04)
 *   3  third_party_cred      <- issuance_logic, same reason
 *   4  upgrade_cred          <- protocol_params spend, the upgrade authority
 *   5  pending_upgrade_cred  <- protocol_params spend, Option<Credential>
 *
 * ⛔ INDEX 1 IS THE TRAP, AND IT IS SILENT BY CONSTRUCTION. alpha.3 had FOUR
 * fields with `transfer_cred` at index 1. alpha.4 INSERTS `issuance_logic_cred`
 * at index 1 — it was not appended — so `transfer_cred` moved to 2 and every
 * later field shifted. BOTH ARE CREDENTIALS. A six-field datum written in
 * alpha.3's order with two fields appended is six fields long, passes the arity
 * check below, decodes without a single error, and hands `issuance_mint` the
 * TRANSFER credential where it expects ISSUANCE_LOGIC.
 *
 * ⇒ No decoder can catch that, here or anywhere. What prevents PRODUCING it is
 * that {@link protocolParamsDatum} takes a KEYED record and offers no positional
 * form. What catches a datum already written that way is a read-back comparison
 * against the deployment record — the devnet bootstrap, which compares every
 * decoded field against what it deployed. See the demonstration test in
 * `test/datum-layout.test.mjs`.
 *
 * ⛔ TWO UPSTREAM COMMENTS ARE STALE AND WILL WALK YOU INTO EXACTLY THAT DEFECT.
 * They are recorded here so the next reader does not have to re-derive it:
 *   - `validators/issuance_mint.ak`'s header says `issuance_logic_cred` is
 *     "field 5". It is field 1.
 *   - `validators/issuance_logic.ak`'s header says "`transfer_cred`, field 1;
 *     `third_party_cred`, field 2". They are fields 2 and 3.
 * The `ProgrammableLogicGlobalParams` DECLARATION and the `*_field` accessors'
 * `tail_list` depths in `validators/programmable_logic/params.ak` are the
 * authority, and the vendored blueprint agrees with them. Never take a shape
 * from prose — take it from
 * `blueprints/standard/v0.5.0-alpha.4/plutus.json`'s `definitions`.
 *
 * ⛔ Nor from upstream's CONTRACT_SURFACE_CHANGES.md, which has now been wrong
 * about this repository twice — see the block comment at the top of
 * `src/standard/blueprint.ts`.
 *
 * ⚠ `max_inline_datum_bytes` did not disappear in alpha.3, it CHANGED KIND: a
 * compile-time parameter of transfer / third_party / unfracking rather than a
 * datum field. See DeploymentParams.maxInlineDatumBytes. `unfracking_cred` is
 * gone because the DISPATCHER names unfracking at compile time now, and
 * `registry_node_cs` because the registry reads its own policy off its own
 * input's payment credential (#117).
 */
export interface ProtocolParamsData {
  /**
   * index 0 — the dispatcher's credential. Read by programmable_logic_base once
   * per programmable input, which is why upstream put it first.
   *
   * ⛔ COHERENCE HAZARD, unenforceable on chain: nothing verifies that the
   * dispatcher named here was compiled against the delegates whose credentials
   * sit in fields 2 and 3. They must be written together.
   */
  plgCred: Cip113Credential;
  /**
   * index 1 — NEW IN alpha.4, and it DISPLACED `transferCred` from this slot.
   * The `issuance_logic` withdraw-0 credential, read by `issuance_mint` on every
   * mint and burn. Rewriting this field is how the protocol's issuance rules are
   * upgraded for every token that already exists, without moving a policy id.
   */
  issuanceLogicCred: Cip113Credential;
  /** index 2 — was index 1 in alpha.3. Read by issuance_logic for precise delegation. */
  transferCred: Cip113Credential;
  /** index 3 — seize / clawback. */
  thirdPartyCred: Cip113Credential;
  /** index 4 — the upgrade authority this datum trampolines to. */
  upgradeCred: Cip113Credential;
  /**
   * index 5 — NEW IN alpha.4. `Option<Credential>`: the INCOMING upgrade
   * authority while a handover is in flight, `null` at rest. An authority
   * handover is two phases (nominate, then the nominee promotes itself by
   * presenting its own withdraw-0), and this field is phase one's only effect.
   */
  pendingUpgradeCred: Cip113Credential | null;
}

/** Build the protocol-params datum. Field order is the on-chain contract. */
export function protocolParamsDatum(p: ProtocolParamsData): Data.Data {
  // `Option<Credential>`: Some(cred) = Constr(0, [Credential]), None = Constr(1, []).
  const pending =
    p.pendingUpgradeCred == null
      ? Data.constr(1n, [])
      : Data.constr(0n, [credToData(p.pendingUpgradeCred)]);

  return Data.constr(0n, [
    credToData(p.plgCred),
    credToData(p.issuanceLogicCred),
    credToData(p.transferCred),
    credToData(p.thirdPartyCred),
    credToData(p.upgradeCred),
    pending,
  ]);
}

/** Decode index 5's `Option<Credential>`. */
function dataToPendingCred(d: Data.Data): Cip113Credential | null {
  if (d instanceof Data.Constr) {
    if (d.index === 1n && d.fields.length === 0) return null;
    if (d.index === 0n && d.fields.length === 1) {
      return dataToCred(d.fields[0]!, "ProtocolParams.pendingUpgradeCred");
    }
  }
  throw new Error(
    `ProtocolParams.pendingUpgradeCred: field 5 is Option<Credential> — ` +
      `Constr(0, [Credential]) for a standing nomination, Constr(1, []) for none. ` +
      `pending_upgrade_cred was added in 0.5.0-alpha.4; a datum without it is not a ` +
      `six-field datum at all.`
  );
}

/**
 * Parse the protocol-params datum. STRICT on arity — see the block above for
 * why that strictness is load-bearing rather than defensive, AND for the one
 * misread it CANNOT catch.
 */
export function decodeProtocolParams(d: Data.Data): ProtocolParamsData {
  if (!(d instanceof Data.Constr) || d.index !== 0n) {
    throw new Error("ProgrammableLogicGlobalParams: expected Constr(0, ...)");
  }
  if (d.fields.length !== 6) {
    throw new Error(
      `ProgrammableLogicGlobalParams: expected exactly 6 fields, got ${d.fields.length}. ` +
        `alpha.4 INSERTED issuance_logic_cred at index 1 — it was not appended — so ` +
        `transfer_cred, which was index 1 in alpha.3, is now index 2. Both are Credentials, ` +
        `so a shifted positional read returns a well-formed value naming the wrong authority. ` +
        `A 4-field datum belongs to a 0.5.0-alpha.3 protocol instance and a 7-field one to ` +
        `0.5.0-alpha.2; point at that instance's SDK, do not relax this check.`
    );
  }
  const f = d.fields;
  return {
    plgCred: dataToCred(f[0]!, "ProtocolParams.plgCred"),
    issuanceLogicCred: dataToCred(f[1]!, "ProtocolParams.issuanceLogicCred"),
    transferCred: dataToCred(f[2]!, "ProtocolParams.transferCred"),
    thirdPartyCred: dataToCred(f[3]!, "ProtocolParams.thirdPartyCred"),
    upgradeCred: dataToCred(f[4]!, "ProtocolParams.upgradeCred"),
    pendingUpgradeCred: dataToPendingCred(f[5]!),
  };
}

/** Build a BlacklistNode datum */
export function blacklistNodeDatum(key: HexString, next: HexString): Data.Data {
  return Data.constr(0n, [Data.bytearray(key), Data.bytearray(next)]);
}

// ---------------------------------------------------------------------------
// Redeemer builders (CIP-113 validators)
// ---------------------------------------------------------------------------

/**
 * A `MintingRegistryProof` — where the token's registry node is in this
 * transaction.
 *
 *   ctor 0  RefInput    { index }  — the registry node is a REFERENCE input
 *   ctor 1  OutputIndex { index }  — the registry node is an OUTPUT of this tx
 *                                    (registration and first mint in one)
 *
 * ⛔ THIS IS NO LONGER `issuance_mint`'s REDEEMER, AND THE OLD COMMENT HERE WAS
 * AN INSTRUCTION FOR BUILDING A TRANSACTION THE LEDGER REFUSES. In 0.5.0-alpha.3
 * `issuance_mint` took a BARE `MintingRegistryProof`. In alpha.4 issuance was
 * split (upstream #129): the permanent per-token policy's redeemer is now
 * `IssuanceRedeemer { params_idx }` — see {@link issuanceRedeemer} — and the
 * proof travels as a VALUE inside the `issuance_logic` withdraw-0 redeemer's
 * map, keyed by policy id. See {@link issuanceLogicRedeemer}, which is where a
 * proof built here now goes.
 *
 * Signatures and encodings are UNCHANGED on purpose: `src/substandards/**`
 * still calls both, and rewiring those call sites is a separate slice.
 *
 * Verified against the blueprint's own `types/MintingRegistryProof` definition,
 * not upstream's prose.
 */
export function mintingProofRefInput(registryRefInputIndex: number): Data.Data {
  return Data.constr(0n, [Data.int(BigInt(registryRefInputIndex))]);
}

/** The other arm of {@link mintingProofRefInput} — see its block comment. */
export function mintingProofOutputIndex(registryOutputIndex: number): Data.Data {
  return Data.constr(1n, [Data.int(BigInt(registryOutputIndex))]);
}

/**
 * `issuance_mint`'s redeemer — `IssuanceRedeemer { params_idx }`.
 *
 * The PERMANENT half of issuance (upstream #129). This script's applied hash IS
 * a token's policy id, so its redeemer is frozen for as long as any token
 * exists: nothing but an index hint locating the protocol-params UTxO among the
 * reference inputs. Everything that could ever change moved to
 * {@link issuanceLogicRedeemer}.
 *
 * ⚠ `params_idx` INDEXES THE COMPLETE, LEDGER-SORTED REFERENCE-INPUT SET, and
 * the validator jumps straight to `list.at(reference_inputs, params_idx)` and
 * authenticates what it finds by the params NFT. Computing this index before
 * the builder has added every reference input is a builder bug, and it does not
 * report as one — it resolves to some other UTxO, fails the NFT check, and dies
 * naming nothing. Use `referenceInputIndexOf` in `src/core/ledger-order.ts`,
 * over the complete set, last.
 */
export function issuanceRedeemer(paramsIdx: number): Data.Data {
  if (!Number.isInteger(paramsIdx) || paramsIdx < 0) {
    throw new Error(
      `issuanceRedeemer: params_idx must be a non-negative integer, got ${paramsIdx}`
    );
  }
  return Data.constr(0n, [Data.int(BigInt(paramsIdx))]);
}

/**
 * `issuance_logic`'s withdraw-0 redeemer — a MAP from policy id to that
 * policy's `MintingRegistryProof`.
 *
 * The REPLACEABLE half of issuance (upstream #129). This is a Plutus `Pairs`
 * association list, NOT a Constr. The two consumers read disjoint halves of it:
 *
 *   - `issuance_mint` reads only the KEYS — `has_key(covered, own_policy)`. It
 *     never decodes a value.
 *   - `issuance_logic` reads only the VALUES — `list.all` over the entries,
 *     running the per-policy rule set on each proof.
 *
 * Entry ORDER is not significant to either, which is why this takes a list and
 * imposes no sort.
 *
 * Three refusals, each closing a builder bug that reports as something else:
 *
 * ⛔ AN EMPTY MAP. `list.all([])` is VACUOUSLY TRUE on chain, so an empty
 * redeemer sails through `issuance_logic` while every `issuance_mint` in the
 * transaction fails its `has_key`. The failure names the mint, not the empty
 * map, and nothing points at the omission.
 *
 * ⛔ A DUPLICATE POLICY ID. Compared as LOWER-CASED HEX STRINGS, not as encoded
 * keys. MEASURED: `Data.map` builds a JS `Map` keyed by `Uint8Array` IDENTITY,
 * so two distinct arrays holding identical bytes BOTH survive and the map is not
 * deduplicated for you. Which of the two proofs governs is then a property of
 * the ledger's map handling rather than of anything you wrote. The keys are
 * lower-cased first because hex case is presentation and two spellings of one
 * policy encode to identical bytes — the same normalisation `cip171.ts` applies
 * to raw script hashes, and the hazard `ledger-order.ts` measures for ordering.
 *
 * ⛔ A VALUE THAT IS NOT A `MintingRegistryProof`. The keys are the frozen
 * interface `issuance_mint` depends on; the values are what `issuance_logic`
 * decodes, and a value it cannot decode aborts the whole withdrawal.
 */
export function issuanceLogicRedeemer(
  entries: readonly { policyId: PolicyId; proof: Data.Data }[]
): Data.Data {
  if (entries.length === 0) {
    throw new Error(
      `issuanceLogicRedeemer: the entry list is EMPTY. On chain issuance_logic runs ` +
        `list.all over these entries, which is vacuously TRUE for an empty map — so an ` +
        `empty redeemer passes issuance_logic while every issuance_mint in the transaction ` +
        `fails its has_key check, and the error names the mint rather than the omission. ` +
        `Every policy this transaction issues must appear here.`
    );
  }

  const seen = new Set<string>();
  for (const e of entries) {
    const k = e.policyId.toLowerCase();
    if (seen.has(k)) {
      throw new Error(
        `issuanceLogicRedeemer: duplicate policy id ${e.policyId}. A policy occupies exactly ` +
          `one entry in the map issuance_mint's has_key runs against. MEASURED: Data.map is a ` +
          `JS Map keyed by Uint8Array IDENTITY, so two byte-identical keys BOTH survive and the ` +
          `map is not deduplicated — which of the two proofs governs is not something this ` +
          `builder decides.`
      );
    }
    seen.add(k);

    const p = e.proof;
    const ok =
      p instanceof Data.Constr && (p.index === 0n || p.index === 1n) && p.fields.length === 1;
    if (!ok) {
      throw new Error(
        `issuanceLogicRedeemer: the value for policy ${e.policyId} is not a ` +
          `MintingRegistryProof. issuance_logic decodes every value, and one it cannot decode ` +
          `aborts the whole withdrawal. Build it with mintingProofRefInput() when the registry ` +
          `node is a reference input, or mintingProofOutputIndex() when it is an output of this ` +
          `transaction.`
      );
    }
  }

  return Data.map(entries.map((e) => [Data.bytearray(e.policyId), e.proof]));
}

/**
 * Which of the three upgrade-path shapes a `protocol_params` SPEND is.
 * Field-less constructors; the index is the whole payload. Mirrors `PlgAct` in
 * `src/core/ledger-order.ts`.
 */
export const ProtocolParamsAct = {
  PROTOCOL_UPGRADE: 0n,
  NOMINATE_AUTHORITY: 1n,
  PROMOTE_AUTHORITY: 2n,
} as const;

export type ProtocolParamsActVariant = keyof typeof ProtocolParamsAct;

/**
 * Build a `ProtocolParamsRedeemer`.
 *
 * The arms carry no payload: every value a branch needs is already in the
 * continuing datum, which is validated regardless. They exist to make each
 * transaction DECLARE its intent, so `ProtocolUpgrade` freezes the nomination
 * and `NominateAuthority` freezes everything else — an authority handover can
 * never ride along inside a parameter change.
 *
 * ⛔ HAZARD: `ProtocolUpgrade` IS BYTE-IDENTICAL TO {@link voidData}, which is
 * `Constr(0, [])`. Every existing caller that passes `voidData()` as the params
 * spend redeemer therefore keeps working BY ACCIDENT, and no decoder anywhere —
 * on chain or off — can distinguish a migrated caller from a stale one, because
 * the bytes are the same bytes. Same shape as the `SpendViaTransfer` /
 * `BaseSpendRedeemer` collision recorded in WORKLOG S-6.
 *
 * ⇒ The silence is ASYMMETRIC, and that is the risk profile: the other two arms
 * are constructors 1 and 2, which `voidData()` cannot represent, so they fail
 * loudly. Only the upgrade path is quiet — and it is the one every deployment
 * exercises first.
 *
 * ⇒ Because no offline instrument can settle it, the proof that this redeemer
 * was ever really implemented is a devnet mutation: submit `Constr(1, [])` where
 * the validator expects `ProtocolUpgrade` and require it to go RED on chain. The
 * ledger is the only witness with jurisdiction.
 */
export function protocolParamsRedeemer(arm: ProtocolParamsActVariant): Data.Data {
  // `Object.hasOwn`, not `=== undefined`: `ProtocolParamsAct["valueOf"]` inherits
  // a FUNCTION from Object.prototype, so a plain lookup sails past an undefined
  // check and dies inside the encoder as a Data.Constr index type error naming
  // nothing the caller can act on.
  const idx = Object.hasOwn(ProtocolParamsAct, arm) ? ProtocolParamsAct[arm] : undefined;
  if (idx === undefined) {
    throw new Error(
      `protocolParamsRedeemer: unknown act ${JSON.stringify(arm)}. ` +
        `Expected one of: ${Object.keys(ProtocolParamsAct).join(", ")}.`
    );
  }
  return Data.constr(idx, []);
}

export interface RegistryProof {
  type: "exists" | "not-exists";
  nodeIdx: number;
}

/** Build a TransferAct redeemer for PLGlobal. */
export function transferActRedeemer(proofs: RegistryProof[]): Data.Data {
  return Data.constr(0n, [
    Data.list(
      proofs.map((p) =>
        p.type === "exists"
          ? Data.constr(0n, [Data.int(BigInt(p.nodeIdx))])
          : Data.constr(1n, [Data.int(BigInt(p.nodeIdx))])
      )
    ),
  ]);
}

/** Build a ThirdPartyAct redeemer for PLGlobal. */
export function thirdPartyActRedeemer(
  registryNodeIdx: number,
  outputsStartIdx: number
): Data.Data {
  return Data.constr(1n, [
    Data.int(BigInt(registryNodeIdx)),
    Data.int(BigInt(outputsStartIdx)),
  ]);
}

/**
 * `registry_mint`'s redeemer.
 *
 *   ctor 0  RegistryInit   {}                              — the origin node
 *   ctor 1  RegistryInsert { key, minting_logic_script }
 *
 * ⚠ The second field is a CREDENTIAL, not a bare hash. #52 replaced
 * `hashed_param: ByteArray` with `minting_logic_script: Credential`, and #52's
 * `mode: RegistrationMode` was removed again by re-audit R-06 — so a builder
 * written against either intermediate shape is wrong in a different way. Both
 * encode without complaint.
 */
export function registryInitRedeemer(): Data.Data {
  return Data.constr(0n, []);
}

export function registryInsertRedeemer(
  key: HexString,
  mintingLogicScript: Cip113Credential
): Data.Data {
  return Data.constr(1n, [Data.bytearray(key), credToData(mintingLogicScript)]);
}

/** Blacklist init (constructor 0) */
export function blacklistInitRedeemer(): Data.Data {
  return Data.constr(0n, []);
}

/** Blacklist add (constructor 1) */
export function blacklistAddRedeemer(stakingPkh: HexString): Data.Data {
  return Data.constr(1n, [Data.bytearray(stakingPkh)]);
}

/** Blacklist remove (constructor 2) */
export function blacklistRemoveRedeemer(stakingPkh: HexString): Data.Data {
  return Data.constr(2n, [Data.bytearray(stakingPkh)]);
}

// ---------------------------------------------------------------------------
// MultisigScript — the upgrade authority's tree
// ---------------------------------------------------------------------------

/**
 * Upper bound on the number of nodes (inner and leaf) a `MultisigScript` may
 * hold, from upstream `lib/multisig.ak`'s `max_size`. Chosen there on MEASURED
 * execution budget, not on feel, and baked into the validator's bytes — so a
 * tree above it is refused on chain and changing the cap is a redeployment.
 */
export const MULTISIG_MAX_SIZE = 20;

/**
 * A `MultisigScript` tree — native-script multisig semantics in Plutus, used for
 * the upgrade authority. Constructor indices are the on-chain contract:
 *
 *   0  Signature { key_hash }
 *   1  AllOf     { scripts }
 *   2  AnyOf     { scripts }
 *   3  AtLeast   { required, scripts }
 *   4  Before    { time }
 *   5  After     { time }
 *   6  Script    { script_hash }
 *
 * `time` is a bigint because a POSIX bound is a Plutus Int and must round-trip
 * exactly; `required` is a plain number because it is bounded by
 * {@link MULTISIG_MAX_SIZE}.
 */
export type MultisigScriptTree =
  | { type: "signature"; keyHash: HexString }
  | { type: "all-of"; scripts: readonly MultisigScriptTree[] }
  | { type: "any-of"; scripts: readonly MultisigScriptTree[] }
  | { type: "at-least"; required: number; scripts: readonly MultisigScriptTree[] }
  | { type: "before"; time: bigint }
  | { type: "after"; time: bigint }
  | { type: "script"; scriptHash: HexString };

/** Node count, leaves included — upstream `multisig.size`. */
function multisigSize(t: MultisigScriptTree): number {
  switch (t.type) {
    case "all-of":
    case "any-of":
    case "at-least":
      return 1 + t.scripts.reduce((acc, c) => acc + multisigSize(c), 0);
    default:
      return 1;
  }
}

function expect28ByteHash(hash: HexString, where: string): void {
  if (!/^[0-9a-fA-F]{56}$/.test(hash)) {
    throw new Error(
      `multisigScriptDatum: ${where} must be exactly 28 bytes (56 hex chars), got ` +
        `${hash.length} chars. A hash of any other length can never match a signatory or a ` +
        `withdrawal credential, so the leaf is permanently unsatisfiable — and an authority ` +
        `nobody can satisfy is a permanent brick with no repair path.`
    );
  }
}

/** Encode one node, enforcing upstream `shape_ok` as it goes. */
function encodeMultisigNode(t: MultisigScriptTree): Data.Data {
  switch (t.type) {
    case "signature":
      expect28ByteHash(t.keyHash, "Signature.key_hash");
      return Data.constr(0n, [Data.bytearray(t.keyHash)]);
    case "script":
      expect28ByteHash(t.scriptHash, "Script.script_hash");
      return Data.constr(6n, [Data.bytearray(t.scriptHash)]);
    case "before":
      return Data.constr(4n, [Data.int(t.time)]);
    case "after":
      return Data.constr(5n, [Data.int(t.time)]);
    case "all-of":
      return Data.constr(1n, [Data.list(encodeChildren(t.scripts, "AllOf"))]);
    case "any-of":
      return Data.constr(2n, [Data.list(encodeChildren(t.scripts, "AnyOf"))]);
    case "at-least": {
      if (!Number.isInteger(t.required) || t.required < 1 || t.required > t.scripts.length) {
        throw new Error(
          `multisigScriptDatum: AtLeast.required must satisfy 1 <= required <= ` +
            `${t.scripts.length} (the child count), got ${t.required}. A threshold of 0 or ` +
            `below authorises with no evidence at all; one above the child count can never be ` +
            `met. Upstream MINR-054 / audit-3 finding 05.`
        );
      }
      return Data.constr(3n, [
        Data.int(BigInt(t.required)),
        Data.list(encodeChildren(t.scripts, "AtLeast")),
      ]);
    }
  }
}

function encodeChildren(
  scripts: readonly MultisigScriptTree[],
  where: string
): Data.Data[] {
  if (scripts.length === 0) {
    throw new Error(
      `multisigScriptDatum: ${where} has an EMPTY child list. AllOf [] is VACUOUSLY TRUE on ` +
        `chain — a permissionless authority, the sharpest edge in the whole type — and AnyOf [] ` +
        `can never be satisfied at all. One rule for all three list nodes, as upstream does.`
    );
  }

  const encoded = scripts.map(encodeMultisigNode);

  // Structural equality, matching Aiken's `list.unique` over the children:
  // compare the ENCODED CBOR rather than the JS objects, which are distinct
  // references even when they describe the same node.
  const seen = new Set<string>();
  for (const child of encoded) {
    const key = bytesToHex(Data.toCBORBytes(child));
    if (seen.has(key)) {
      throw new Error(
        `multisigScriptDatum: ${where} has DUPLICATE children. A duplicate distorts AtLeast — ` +
          `[A, A, B] at threshold 2 is met by A alone — and upstream refuses it on every list ` +
          `node rather than only where it bites. Upstream MINR-054 / audit-3 finding 05.`
      );
    }
    seen.add(key);
  }

  return encoded;
}

/**
 * Build a `MultisigScript` datum, enforcing upstream `lib/multisig.ak`'s
 * `well_formed` — 28-byte hashes, non-empty and duplicate-free child lists,
 * `1 <= required <= |scripts|`, and at most {@link MULTISIG_MAX_SIZE} nodes.
 *
 * ⛔ THE RAIL LIVES ON THE ENCODER ONLY, AND {@link decodeMultisigScript}
 * DELIBERATELY ENFORCES NONE OF IT. The two functions answer different
 * questions: the encoder decides what may be WRITTEN, the decoder reads what is
 * ON CHAIN. A decoder that refused an ill-formed tree could not be used to
 * inspect one — and inspecting a live authority somebody managed to write is
 * exactly the moment you need to read it. Do not "tidy" the check into the
 * decoder for symmetry.
 */
export function multisigScriptDatum(tree: MultisigScriptTree): Data.Data {
  const size = multisigSize(tree);
  if (size > MULTISIG_MAX_SIZE) {
    throw new Error(
      `multisigScriptDatum: the tree has ${size} nodes, above MULTISIG_MAX_SIZE = ` +
        `${MULTISIG_MAX_SIZE}. The cap is baked into the validator's bytes and was chosen on ` +
        `MEASURED execution budget; an authority that writes itself a tree too expensive to ` +
        `evaluate has bricked the upgrade path.`
    );
  }
  return encodeMultisigNode(tree);
}

/**
 * Parse a `MultisigScript` datum. Reads what is on chain and enforces NO
 * well-formedness — see {@link multisigScriptDatum} for why the asymmetry is
 * deliberate.
 */
export function decodeMultisigScript(d: Data.Data): MultisigScriptTree {
  if (!(d instanceof Data.Constr)) {
    throw new Error("MultisigScript: expected a Constr");
  }
  const f = d.fields;
  const children = (where: string): MultisigScriptTree[] => {
    const list = f[0];
    if (!Array.isArray(list)) {
      throw new Error(`MultisigScript.${where}: expected a list of scripts`);
    }
    return list.map(decodeMultisigScript);
  };

  switch (d.index) {
    case 0n:
      return { type: "signature", keyHash: expectBytes(f[0]!, "MultisigScript.Signature.keyHash") };
    case 1n:
      return { type: "all-of", scripts: children("AllOf") };
    case 2n:
      return { type: "any-of", scripts: children("AnyOf") };
    case 3n: {
      const required = f[0];
      if (typeof required !== "bigint") {
        throw new Error("MultisigScript.AtLeast: expected required to be an Int");
      }
      const list = f[1];
      if (!Array.isArray(list)) {
        throw new Error("MultisigScript.AtLeast: expected a list of scripts");
      }
      return { type: "at-least", required: Number(required), scripts: list.map(decodeMultisigScript) };
    }
    case 4n:
    case 5n: {
      const time = f[0];
      if (typeof time !== "bigint") {
        throw new Error("MultisigScript.Before/After: expected time to be an Int");
      }
      return d.index === 4n ? { type: "before", time } : { type: "after", time };
    }
    case 6n:
      return { type: "script", scriptHash: expectBytes(f[0]!, "MultisigScript.Script.scriptHash") };
    default:
      throw new Error(
        `MultisigScript: unknown constructor index ${d.index}. Valid indices are 0..6 ` +
          `(Signature, AllOf, AnyOf, AtLeast, Before, After, Script).`
      );
  }
}

// ---------------------------------------------------------------------------
// Asset helpers
// ---------------------------------------------------------------------------

/** Build an Assets object with a single native token unit + min lovelace */
export function singleTokenAssets(policyId: string, assetName: string, qty: bigint): Assets.Assets {
  let assets = Assets.fromLovelace(0n);
  assets = Assets.addByHex(assets, policyId, assetName, qty);
  return Assets.withoutLovelace(assets);
}

/** Build mint assets map from unit -> qty entries (Evolution SDK format) */
export function mintAssetsFromMap(entries: Map<string, bigint>): Assets.Assets {
  let assets = Assets.fromLovelace(0n);
  for (const [unit, qty] of entries) {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    assets = Assets.addByHex(assets, policyId, assetName, qty);
  }
  return Assets.withoutLovelace(assets);
}

/** Build output assets: lovelace + optional token map */
export function outputAssets(lovelace: bigint, tokenMap?: Map<string, bigint>): Assets.Assets {
  let assets = Assets.fromLovelace(lovelace);
  if (tokenMap) {
    for (const [unit, qty] of tokenMap) {
      const policyId = unit.slice(0, 56);
      const assetName = unit.slice(56);
      assets = Assets.addByHex(assets, policyId, assetName, qty);
    }
  }
  return assets;
}

// ---------------------------------------------------------------------------
// UTxO datum extraction
// ---------------------------------------------------------------------------

/**
 * Get the inline datum from a UTxO. Returns undefined if no inline datum.
 */
export function getInlineDatum(utxo: EvoUTxO.UTxO): Data.Data | undefined {
  const datumOpt = (utxo as any).datumOption;
  if (datumOpt?._tag === "InlineDatum" && datumOpt.data != null) {
    return datumOpt.data as Data.Data;
  }
  return undefined;
}

/**
 * Get the UTxO's value as a check for a specific unit.
 */
export function utxoHasUnit(utxo: EvoUTxO.UTxO, unit: string): boolean {
  try {
    const qty = Assets.getByUnit(utxo.assets, unit);
    return qty > 0n;
  } catch {
    return false;
  }
}

/**
 * Get the quantity of a specific unit in a UTxO.
 */
export function utxoUnitQty(utxo: EvoUTxO.UTxO, unit: string): bigint {
  try {
    return Assets.getByUnit(utxo.assets, unit);
  } catch {
    return 0n;
  }
}

/**
 * Get the lovelace amount from a UTxO.
 */
export function utxoLovelace(utxo: EvoUTxO.UTxO): bigint {
  return Assets.lovelaceOf(utxo.assets);
}

/**
 * Get the txHash of a UTxO as a hex string.
 */
export function utxoTxHash(utxo: EvoUTxO.UTxO): string {
  return TransactionHash.toHex(utxo.transactionId);
}

/**
 * Get the output index of a UTxO as a number.
 */
export function utxoOutputIndex(utxo: EvoUTxO.UTxO): number {
  return Number(utxo.index);
}

/**
 * Get the bech32 address of a UTxO.
 */
export function utxoAddress(utxo: EvoUTxO.UTxO): string {
  return EvoAddress.toBech32(utxo.address);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max next pointer for linked list sentinel (30 bytes, matches Aiken #"ff"*30) */
export const MAX_NEXT = "ff".repeat(30);

/** Convert a UTF-8 string to hex */
export function stringToHex(str: string): string {
  return Buffer.from(str, "utf-8").toString("hex");
}

// ---------------------------------------------------------------------------
// CIP-68 / CIP-67 helpers
// ---------------------------------------------------------------------------

import type { CIP68MetadataInput } from "../substandards/interface.js";

/** Prefix an asset name hex with a CIP-67 label (e.g., 333 → "000f4141" + assetNameHex). */
export function labeledAssetName(label: number, assetNameHex: HexString): HexString {
  return Label.toLabel(label) + assetNameHex;
}

/** Strip a CIP-67 label prefix from an asset name hex, if present. Returns the stripped (unlabeled) name. */
export function stripCIP67Label(assetNameHex: HexString): HexString {
  // CIP-67 labels are 4 bytes = 8 hex chars
  if (!assetNameHex || assetNameHex.length <= 8) return assetNameHex || "";
  try {
    const labelHex = assetNameHex.substring(0, 8);
    // Label.fromLabel will throw/return null if not a valid CIP-67 label
    const label = Label.fromLabel(labelHex);
    if (label !== undefined && label !== null) {
      return assetNameHex.substring(8);
    }
  } catch {
    // Not a valid CIP-67 label prefix — return as-is
  }
  return assetNameHex;
}

/** Check if an asset name hex starts with a CIP-67 label prefix. */
export function hasCIP67Label(assetNameHex: HexString): boolean {
  if (!assetNameHex || assetNameHex.length <= 8) return false;
  try {
    const labelHex = assetNameHex.substring(0, 8);
    const label = Label.fromLabel(labelHex);
    return label !== undefined && label !== null;
  } catch {
    return false;
  }
}

/**
 * Build CIP-68 FT metadata datum: Constr(0, [metadata_map, version, extra]).
 *
 * Keys and text values are byte strings (standard CIP-68 convention).
 * Matches real-world CIP-68 FT datums (e.g., FLDT token).
 */
export function buildCIP68FTDatum(meta: CIP68MetadataInput): Data.Data {
  const entries: Array<[Data.Data, Data.Data]> = [];

  entries.push([Data.bytearray(stringToHex("name")), Data.bytearray(stringToHex(meta.name))]);

  if (meta.description) {
    entries.push([Data.bytearray(stringToHex("description")), Data.bytearray(stringToHex(meta.description))]);
  }
  if (meta.ticker) {
    entries.push([Data.bytearray(stringToHex("ticker")), Data.bytearray(stringToHex(meta.ticker))]);
  }
  if (meta.decimals !== undefined) {
    entries.push([Data.bytearray(stringToHex("decimals")), Data.int(BigInt(meta.decimals))]);
  }
  if (meta.url) {
    entries.push([Data.bytearray(stringToHex("url")), Data.bytearray(stringToHex(meta.url))]);
  }
  if (meta.logo) {
    entries.push([Data.bytearray(stringToHex("logo")), Data.bytearray(stringToHex(meta.logo))]);
  }

  return Data.constr(0n, [
    Data.map(entries),
    Data.int(1n),       // version
    Data.int(1n),       // extra (matches real-world CIP-68 datums)
  ]);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export {
  Data,
  Bytes,
  Assets,
  Credential,
  InlineDatum,
  KeyHash,
  EvoAddress,
  EvoScriptHash,
  TransactionHash,
  Transaction,
  UPLC,
};
