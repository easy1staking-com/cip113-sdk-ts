/**
 * In-place protocol upgrade — test fixture (T-D07), TARGETING alpha.4 at d37ca8d.
 *
 * The protocol-params UTxO holds the live wiring. An upgrade SPENDS it and
 * writes a continuing output with a new datum, rather than redeploying
 * programmable_logic_base — whose hash anchors every programmable token address
 * and therefore cannot move without moving every token.
 *
 * `protocol_params` is ONE validator with two handlers (mint and spend) sharing
 * one hash, so the params NFT policy id and the params address's payment
 * credential are the same value by construction. Its `spend` handler enforces
 * the structural rails and TRAMPOLINES the authorisation decision to whatever
 * `upgrade_cred` the CURRENT (spent) datum names — read from the old datum on
 * purpose, so the sitting authority authorises every change including a change
 * of authority.
 *
 * Rails, read from `validators/protocol_params.ak` at d37ca8d:
 *   * exactly one continuing output at the own address (`expect [cont]`);
 *   * non-ADA value STRICTLY equal in both directions — the NFT can never be
 *     split away and junk can never be injected;
 *   * ⚠ LOVELACE IS UNCONSTRAINED relative to the input. The alpha.3 one-way
 *     ADA ratchet is GONE: upstream removed it because it defended against
 *     nothing (the ledger's own min-UTxO rule is the real floor, and the only
 *     party who can spend this UTxO is the authority already trusted to replace
 *     every credential in the datum) while making over-funding unrecoverable
 *     forever. `extraLovelace` therefore no longer probes a ratchet;
 *   * no reference script on the continuing output;
 *   * every credential in the datum a well-formed 28-byte hash — enforced by
 *     `params_wellformed` on BOTH handlers, so the state the spend refuses to
 *     move to is also a state the mint refuses to create. A wrong-length value
 *     is a one-way brick with no repair path;
 *   * ⚠ THERE ARE NO FROZEN-FIELD RAILS LEFT. `prog_logic_cred` and
 *     `registry_node_cs` are not datum fields any more — they are compile-time
 *     parameters of the delegates. See the "DESIGNED OUT" block in the devnet
 *     test for what that does and does not buy;
 *   * authorisation: the redeemer DECLARES which of three shapes this is, and
 *     each arm is one closed rule set read against the OLD datum:
 *       - `ProtocolUpgrade`   — the sitting authority's withdraw-0, and BOTH
 *         `upgrade_cred` and `pending_upgrade_cred` frozen;
 *       - `NominateAuthority` — the sitting authority's withdraw-0, and
 *         everything except `pending_upgrade_cred` frozen (one record equality);
 *       - `PromoteAuthority`  — the standing NOMINEE's own withdraw-0, and the
 *         only permitted difference is that the nomination has become the
 *         authority.
 *     Declaring the act is what makes the three rule sets mutually exclusive:
 *     a handover can never begin inside a transaction that presents itself as a
 *     parameter change, and a promotion can never carry one.
 *
 * ⚠ This fixture implements `ProtocolUpgrade` end to end. `NominateAuthority`
 * and `PromoteAuthority` are reachable through `opts.act` and are exercised on
 * chain by T-F03-3, not here.
 */

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Bytes,
  Credential,
  KeyHash,
  InlineDatum,
  TransactionHash as EvoTransactionHash,
  type UTxO as EvoUTxO,
} from "@evolution-sdk/evolution";

import {
  decodeProtocolParams,
  protocolParamsDatum,
  protocolParamsRedeemer,
  ProtocolParamsAct,
  paymentCredentialHash,
  getInlineDatum,
  voidData,
  scriptAddress,
  buildEvoScript,
  createStandardScripts,
  type DeploymentParams,
  type PlutusBlueprint,
  type ProtocolParamsData,
} from "../../dist/index.js";

import { makeClient } from "./yaci.mjs";
import { createOgmiosEvaluator } from "./ogmios-evaluator.js";

/** Locate the coordination UTxO by the params NFT, structurally as the validator does. */
export async function readCoordination(
  client: any,
  deployment: DeploymentParams
): Promise<{ utxo: EvoUTxO.UTxO; params: ProtocolParamsData }> {
  const networkId = client.chain.id;
  const unit =
    deployment.protocolParams.policyId +
    Buffer.from("ProtocolParams", "utf-8").toString("hex");
  // policy == address in alpha.3: the params NFT sits at protocol_params own
  // address, and coordination_spend no longer exists as a separate validator.
  const addr = scriptAddress(networkId, deployment.protocolParams.policyId);
  const utxos = await client.getUtxosWithUnit(EvoAddress.fromBech32(addr), unit);
  if (utxos.length !== 1) {
    throw new Error(
      `Expected exactly one protocol-params UTxO holding ${unit}, found ${utxos.length}. ` +
        `The params NFT is one-shot; zero means it is locked at a different address.`
    );
  }
  const datum = getInlineDatum(utxos[0]);
  if (!datum) throw new Error("The protocol-params UTxO carries no inline datum");
  return { utxo: utxos[0], params: decodeProtocolParams(datum) };
}

/**
 * Locate the `upgrade_multisig` config UTxO — the one holding the config NFT
 * and the `MultisigScript` tree that IS the upgrade authority.
 *
 * ⚑ FOUND BY ITS NFT, NOT BY `deployment.upgradeMultisig.utxo`. The recorded
 * coordinate is a RECORD of where the config UTxO was at bootstrap; the NFT is
 * its IDENTITY. A signer rotation (`upgrade_multisig.spend`, out of scope here
 * — A-3) SPENDS that UTxO and recreates it at a new coordinate, so the recorded
 * value goes stale while the NFT does not. Reading the identity keeps this
 * fixture correct across a rotation it does not itself perform.
 *
 * ⚑ AND STRUCTURALLY, BY POLICY, EXACTLY AS THE VALIDATOR DOES —
 * `has_currency_symbol(i.output.value, own_hash)` in `upgrade_multisig.withdraw`.
 * Not an equality test against a unit string we just built: a lookup keyed on
 * our own constructed unit shares a blind spot with the code that constructed
 * it, and would agree with itself if we got the asset name wrong in both
 * places.
 *
 * ⚑ WHAT THE DECOY DOES AND DOES NOT DEFEND. It makes the CARDINALITY reading
 * non-vacuous: the address really holds >= 2, so "the only UTxO here" is wrong
 * as well as lazy, and over-narrowing is caught loudly (0 found among 2). It
 * does NOT make the POLICY VALUE load-bearing — measured, audit r1 A2a: delete
 * the `=== policy` comparison and test 1 stays green, because the decoy is
 * funded with lovelace only, so "has any native asset" discriminates
 * identically. The policy comparison stays because a *wrong* policy still
 * throws loudly and because it mirrors the validator's own
 * `has_currency_symbol`; it becomes genuinely load-bearing only once the decoy
 * carries a FOREIGN-POLICY asset, which lives in the frozen `bootstrap.ts` and
 * is seated as residue.
 *
 * T-F03-1's tx0 parks that second, NFT-free, datum-less UTxO deliberately —
 * upstream's `spend` handler explicitly contemplates junk parked at the address,
 * and anyone may pay to a script address at any time. The `>= 2` gate below
 * mirrors `bootstrap.ts` so that a vanished decoy is loud rather than silently
 * restoring vacuity.
 */
export async function readUpgradeMultisigConfig(
  client: any,
  deployment: DeploymentParams
): Promise<EvoUTxO.UTxO> {
  const networkId = client.chain.id;
  const policy = deployment.upgradeMultisig.scriptHash;
  const addr = scriptAddress(networkId, policy);
  const atAddress = await client.getUtxos(EvoAddress.fromBech32(addr));

  if (atAddress.length < 2) {
    throw new Error(
      `upgrade_multisig address ${addr} holds ${atAddress.length} UTxO(s); the bootstrap parks a ` +
        `decoy beside the config UTxO so the policy filter below is exercised. With fewer than 2 ` +
        `there is nothing to discriminate and this lookup proves nothing.`
    );
  }

  const candidates = atAddress.filter((u: EvoUTxO.UTxO) =>
    EvoAssets.getUnits(u.assets).some(
      (unit) => unit !== "lovelace" && unit.slice(0, 56) === policy
    )
  );
  if (candidates.length !== 1) {
    throw new Error(
      `upgrade_multisig config UTxO: expected exactly 1 UTxO at ${addr} carrying an asset of ` +
        `policy ${policy}, found ${candidates.length} among ${atAddress.length} UTxO(s) at the ` +
        `address. The config NFT is one-shot, so zero means it is not where the validator locks ` +
        `it, and more than one means this address is not what we think it is. ` +
        `upgrade_multisig.withdraw finds this UTxO among the REFERENCE INPUTS by exactly this ` +
        `policy test, so an authorisation built without it cannot succeed.`
    );
  }
  return candidates[0]!;
}

export interface UpgradeOptions {
  /**
   * Which of `protocol_params`' three arms this transaction DECLARES itself to
   * be. Required, and deliberately WITHOUT A DEFAULT.
   *
   * ⛔ A DEFAULT IS THE DEFECT THIS PARAMETER EXISTS TO PREVENT. `ProtocolUpgrade`
   * encodes as `Constr(0, [])`, which is BYTE-IDENTICAL to the `voidData()` this
   * redeemer replaces. So a defaulted `act` would leave the upgrade path
   * emitting exactly the bytes it emitted before, whether or not one single
   * caller ever read the parameter — and NO DECODER ANYWHERE, on chain or off,
   * could distinguish a migrated caller from a stale one. The absence of a
   * default is what forces every call site to state its intent in a place a
   * reader and a compiler can both see.
   *
   * ⇒ Routing all three arms through ONE `protocolParamsRedeemer(opts.act)` call
   * site is the other half. Arms 1 and 2 are `Constr(1, [])` / `Constr(2, [])`,
   * which `voidData()` cannot represent and which therefore fail loudly on
   * chain; proving those two travel through this call site proves the call site
   * is live, and arm 0 comes along by construction rather than by demonstration.
   * T-F03-3 is what discharges that second half — see the note in
   * `test/devnet/upgrade.test.ts`.
   */
  readonly act: keyof typeof ProtocolParamsAct;
  /** Mutate the current params into the desired new params. */
  readonly change: (current: ProtocolParamsData) => ProtocolParamsData;
  /** Omit the upgrade authority's whole authorisation — for proving the rail bites. */
  readonly omitAuthority?: boolean;
  /**
   * Extra lovelace on the continuing output.
   *
   * ⚠ NO LONGER A RATCHET PROBE. alpha.4 leaves lovelace unconstrained relative
   * to the input, in both directions; this only exercises that the non-ADA
   * equality rail is unaffected by moving the ADA leg.
   */
  readonly extraLovelace?: bigint;
}

/**
 * Perform an in-place upgrade. Returns the transaction hash.
 *
 * Devnet fixture only — see the constitution's scoped exception.
 */
export async function upgradeProtocol(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
  opts: UpgradeOptions
): Promise<string> {
  const client: any = await makeClient();
  const addressObj = await client.address();
  const networkId = client.chain.id;

  const { utxo, params } = await readCoordination(client, deployment);
  const next = opts.change(params);

  const builders = createStandardScripts(blueprint);
  // The SPEND handler of the merged protocol_params validator. One script now
  // carries both the mint and the spend arm, so the upgrade path attaches the
  // same artefact the genesis mint used -- and there is no nonce to supply.
  const paramsScript = builders.protocolParams(deployment.protocolParams.txInput);

  let tx = client.newTx();
  // ⛔ THE REDEEMER DECLARES THE ACT. Exactly one call site, reading `opts.act`
  // — see UpgradeOptions.act for why there is no default and why one call site
  // for all three arms is the point rather than an economy.
  tx = tx.collectFrom({ inputs: [utxo], redeemer: protocolParamsRedeemer(opts.act) });
  tx = tx.attachScript({ script: buildEvoScript(paramsScript.compiledCode) });

  // Continuing output: same address, and the INPUT'S OWN value carried through
  // rather than reconstructed. The validator requires non-ADA assets to be
  // STRICTLY equal, so reassembling the multi-asset by hand would be a
  // needless opportunity to drop the NFT; addLovelace touches only the ADA leg,
  // which alpha.4 leaves unconstrained.
  const outAssets = opts.extraLovelace
    ? EvoAssets.addLovelace(utxo.assets, opts.extraLovelace)
    : utxo.assets;
  tx = tx.payToAddress({
    address: utxo.address,
    assets: outAssets,
    datum: new InlineDatum.InlineDatum({ data: protocolParamsDatum(next) }),
  });

  // The trampoline: the CURRENT datum's authority must produce a withdraw-0.
  //
  // ⚑ ROUTED ON THE DATUM'S CREDENTIAL, NEVER ON `deployment.upgradeAuthority`.
  // The datum is the source of truth for who may authorise this spend — the
  // deployment record is a record, and a promotion (T-F03-3) moves the datum
  // without moving the record.
  if (!opts.omitAuthority) {
    if (params.upgradeCred.type === "script") {
      if (params.upgradeCred.hash !== deployment.upgradeMultisig.scriptHash) {
        throw new Error(
          `The datum names a SCRIPT upgrade authority ${params.upgradeCred.hash}, which is not ` +
            `this deployment's upgrade_multisig (${deployment.upgradeMultisig.scriptHash}). This ` +
            `fixture can satisfy only two authorities: a KEY credential the wallet holds, or the ` +
            `upgrade_multisig whose config UTxO and script body it can reconstruct. An unrelated ` +
            `script credential needs its own witness and its own satisfaction argument, neither ` +
            `of which DeploymentParams records.`
        );
      }

      // A multisig withdraw-0 needs FOUR things, and three of them are
      // invisible offline (WORKLOG S-11 defect 3 met the first two the hard
      // way, as "An associated script witness is missing" and as code 3141,
      // "rewards withdrawals must consume rewards in full" — which reads as a
      // balance problem and means an UNREGISTERED credential):
      //   1. the withdrawal entry itself      -> withdraw() below
      //   2. a SCRIPT WITNESS                 -> attachScript below
      //   3. a REGISTERED stake credential    -> the bootstrap's tx5
      //   4. the CONFIG UTxO as a REFERENCE INPUT -> readFrom below
      // (4) is the one a plain script withdraw-0 does not need:
      // `upgrade_multisig.withdraw` finds its tree among `self.reference_inputs`
      // and can do nothing without it.
      const multisigScript = builders.upgradeMultisig(deployment.upgradeMultisig.txInput);
      const configUtxo = await readUpgradeMultisigConfig(client, deployment);

      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(Bytes.fromHex(params.upgradeCred.hash)),
        amount: 0n,
        // The withdraw handler ignores its redeemer entirely; a script-witnessed
        // withdrawal still REQUIRES one to be present.
        redeemer: voidData(),
      });

      // ⚠ AN ATTACHED BODY, NOT A REFERENCE SCRIPT. Every script witness in this
      // repo is attached. `deployment.upgradeMultisigRefInput` is recorded and
      // DELIBERATELY UNREAD here: its consumer is a deployer, not this fixture,
      // and whether Evolution resolves a WITHDRAWAL's witness from a `readFrom`
      // scriptRef is untested in this repo. Do not "complete" this by wiring it
      // — that is a separate question with its own slice.
      tx = tx.attachScript({ script: buildEvoScript(multisigScript.compiledCode) });

      // ⛔ REFERENCE INPUT, NEVER A SPENT INPUT. Upstream is explicit: "The
      // config UTxO cannot be spent and referenced in one transaction", which
      // is why a signer rotation and a protocol upgrade are two transactions.
      tx = tx.readFrom({ referenceInputs: [configUtxo] });

      // `satisfied` on a `Signature { key_hash }` leaf is
      // `list.has(self.extra_signatories, key_hash)`, and `extra_signatories` is
      // the transaction's `required_signers` field. ⚠ A WALLET THAT MERELY SIGNS
      // IS NOT ENOUGH — the key hash must be explicitly added, which is what
      // addSigner does. The tree this bootstrap writes is Signature(adminPkh),
      // where adminPkh is the bootstrapping wallet's PAYMENT credential.
      const adminPkh = paymentCredentialHash(EvoAddress.toBech32(addressObj));
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(adminPkh) });
    } else if (params.upgradeCred.type === "key") {
      // withdraw-0: the entry's PRESENCE is the authorisation; the amount is
      // irrelevant to protocol_params, which only does has_key_or_fail. A key
      // credential carries no script and so needs no witness and no redeemer.
      tx = tx.withdraw({
        stakeCredential: Credential.makeKeyHash(Bytes.fromHex(params.upgradeCred.hash)),
        amount: 0n,
      });
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(params.upgradeCred.hash) });
    } else {
      throw new Error(
        `The datum's upgrade_cred is neither a key nor a script credential: ` +
          `${JSON.stringify(params.upgradeCred)}. This fixture can satisfy a KEY credential the ` +
          `wallet holds, or the SCRIPT credential of this deployment's upgrade_multisig ` +
          `(${deployment.upgradeMultisig.scriptHash}) — and nothing else.`
      );
    }
  }

  const built = await tx.build({
    changeAddress: addressObj,
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
    // ⛔ EXCLUDE EVERY UTxO CARRYING A REFERENCE SCRIPT. Without this, coin
    // selection is free to spend one of the SEVEN reference-script UTxOs the
    // bootstrap just published. MEASURED on preview: `seize` consumed a
    // deployment's third_party reference-script UTxO exactly this way and it
    // APPEARED TO WORK — a spent input's reference script still counts as
    // supplied (CIP-33) — until the next run failed with 3011 against
    // infrastructure that no longer existed. Mirrors bootstrap.ts's
    // `spendable()`.
    availableUtxos: (await client.getUtxos(addressObj)).filter((u: any) => !u.scriptRef),
  });
  const res = await built.signAndSubmit();
  const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res);
  await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 180_000);
  return hash;
}
