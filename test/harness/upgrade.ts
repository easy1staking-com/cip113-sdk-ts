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
 * ⚠ All three arms are implemented end to end and all three are exercised on
 * chain by `test/devnet/upgrade.test.ts`. `nominateAuthority` and
 * `promoteAuthority` are thin entry points onto `upgradeProtocol`, deliberately:
 * ONE transaction builder, ONE authorisation router, ONE
 * `protocolParamsRedeemer` call site. Forking a second authorisation path for
 * the promotion is the mistake this shape exists to prevent.
 *
 * ⛔ AND THEY ARE TWO ENTRY POINTS, NOT ONE `handover()`. There is deliberately
 * no wrapper that nominates and then promotes. Each phase takes CHAIN STATE as
 * its input — `promoteAuthority` reads the nominee out of the datum, not from
 * an argument — so a run that dies between the two is resumed by calling the
 * second one, never by starting over. WORKLOG S-12 is why that is a requirement
 * rather than a preference: a three-step preview deployment failed at step
 * three against a lagging indexer and could not be re-run, because step one had
 * spent one-shot seeds. **Every step after the first irreversible one must be
 * separately runnable**, and phase one of a handover is irreversible in the only
 * sense that matters — it is on chain.
 */

import {
  Address as EvoAddress,
  Assets as EvoAssets,
  Bytes,
  Credential,
  KeyHash,
  InlineDatum,
  TransactionHash as EvoTransactionHash,
  Withdrawals as EvoWithdrawals,
  type Transaction as EvoTransaction,
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
  minUtxoAtLeast,
  type Cip113Credential,
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

/**
 * Every credential a BUILT transaction withdraws from, as CIP-113 credentials.
 *
 * ⛔ READ OFF THE BUILT TRANSACTION, NEVER OFF A BOOKKEEPING ARRAY, AND THAT
 * DISTINCTION IS THE WHOLE VALUE OF THIS FUNCTION. A list of "credentials we
 * intended to withdraw from", appended to beside each `withdraw()` call, would
 * share a blind spot with the code it describes: someone adding a second
 * `tx.withdraw(...)` and not appending to the list produces a transaction whose
 * withdrawal set has grown and whose RECORD has not, and every assertion
 * downstream would go on passing. `built.toTransaction()` is the artefact the
 * ledger will see, so this cannot disagree with what was actually built.
 *
 * ⚠ AN UNKNOWN CREDENTIAL TAG THROWS rather than defaulting to "key". A default
 * here would make a script withdrawal INVISIBLE to the exclusivity assertion in
 * the devnet test — an instrument returning a plausible, wrong, quiet answer,
 * which is precisely the reading that assertion exists to make impossible.
 *
 * EXPORTED for R-1 (T-F03-3 audit residue): every transaction the green suite
 * builds carries exactly one withdrawal, so a mutant that truncates this
 * reader to its first entry survived undetected. `test/devnet/upgrade.test.ts`
 * unit-tests the multi-entry path offline, against a hand-built `Withdrawals`
 * — no chain needed, because the property being pinned is about THIS
 * function's read, not about anything the ledger decides.
 */
export function withdrawalCredentials(tx: EvoTransaction.Transaction): Cip113Credential[] {
  const withdrawals = tx.body.withdrawals;
  if (!withdrawals) return [];
  return EvoWithdrawals.entries(withdrawals).map(([account]) => {
    const cred: any = account.stakeCredential;
    if (cred._tag !== "ScriptHash" && cred._tag !== "KeyHash") {
      throw new Error(
        `withdrawalCredentials: unrecognised stake-credential tag ${JSON.stringify(cred._tag)}. ` +
          `Refusing to guess: this list is what proves a promotion withdraws from the NOMINEE ` +
          `and from nobody else, and a credential silently classified as the wrong kind would ` +
          `make that proof vacuous.`
      );
    }
    return {
      type: cred._tag === "ScriptHash" ? "script" : "key",
      hash: Bytes.toHex(cred.hash),
    };
  });
}

/**
 * What an upgrade-path transaction did, as observable facts rather than a hash.
 */
export interface UpgradeResult {
  /** The submitted transaction's hash. */
  readonly txHash: string;
  /**
   * Every credential the transaction withdrew from, read back off the built
   * body — see {@link withdrawalCredentials}.
   *
   * ⛔ WHY THIS IS RETURNED AT ALL, AND WHAT THE CHAIN CANNOT DO ABOUT IT.
   * Upstream's promotion rail is `pairs.has_key(withdrawals, nominee)` — an
   * EXISTENCE check. A promotion that carries the nominee's withdrawal AND the
   * sitting multisig's is therefore **accepted on chain**. So the property "the
   * promotion does not need the outgoing authority" is not enforceable by any
   * on-chain negative, and a devnet suite alone can never see it break.
   *
   * ⇒ It has to be asserted OFF-CHAIN, on the transaction we built. That is
   * what this field is for, and `test/devnet/upgrade.test.ts` asserts the
   * promotion's list is exactly the nominee's.
   */
  readonly withdrewFrom: readonly Cip113Credential[];
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
  /**
   * WHOSE withdraw-0 authorises this spend, chosen from the CURRENT (spent)
   * datum. Defaults to the sitting authority, `upgrade_cred`.
   *
   * ⛔ THE ONE ASYMMETRY IN THIS VALIDATOR, AND THE ONLY REASON THIS HOOK
   * EXISTS. Two of the three arms — `protocol_upgrade` and `nominate_authority`
   * — call `sitting_authority_approves`, which is
   * `pairs.has_key(withdrawals, old.upgrade_cred)`. `promote_authority` does
   * NOT: it calls `pairs.has_key(withdrawals, nominee)` where the nominee is
   * `old.pending_upgrade_cred`, and the sitting authority does not appear in a
   * promotion at all.
   *
   * ⚠ THE WRONG IMPLEMENTATION IS SILENT ON THE BUILD SIDE. Adding the sitting
   * authority's withdrawal to a promotion is not refused for being extra — it
   * is simply not what the rule reads, so the transaction is refused for
   * MISSING the nominee's, and a reader who assumed symmetry sees a puzzling
   * 3012 rather than their own mistake. Mutation P1 is what proves this branch
   * was implemented rather than assumed.
   *
   * ⚑ IT TAKES THE DATUM, NOT A CREDENTIAL. A credential passed in by a caller
   * and a credential on chain are two facts that can disagree, and only the
   * on-chain one decides — so the value that ends up in the withdrawals map is
   * read from the same datum the validator reads.
   */
  readonly authoriseAs?: (current: ProtocolParamsData) => Cip113Credential;
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
): Promise<UpgradeResult> {
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
  const carried = opts.extraLovelace
    ? EvoAssets.addLovelace(utxo.assets, opts.extraLovelace)
    : utxo.assets;
  const nextDatum = protocolParamsDatum(next);

  // ⛔ THE ADA LEG MUST BE RE-FLOORED, BECAUSE THE DATUM CAN GROW. min-UTxO
  // scales with the SERIALISED OUTPUT SIZE, and `pending_upgrade_cred` is the
  // one field of this datum whose size changes: `None` is 3 bytes of CBOR,
  // `Some(Credential)` is ~40. So a NOMINATION widens the continuing output
  // past the floor the genesis output was funded to, while every other upgrade
  // leaves it exactly where it was.
  //
  // MEASURED on devnet 2026-09-10, before this line existed: carrying the
  // input's 2,000,000 lovelace through a nomination was rejected at SUBMISSION
  // with ledger code **3125**, `minimumRequiredValue 2,012,770`. ⚠ AND EVOLUTION
  // DOES NOT RESCUE AN UNDER-FUNDED `payToAddress` — it applies its own
  // min-UTxO arithmetic to CHANGE outputs only, so an explicit amount is passed
  // through verbatim and the shortfall survives to the ledger, which reports
  // "insufficient Ada" and NEVER "your datum grew". Nothing offline notices.
  //
  // `minUtxoAtLeast` takes the current lovelace as its FLOOR, so this only ever
  // raises: a promotion, which SHRINKS the datum back to `None`, leaves the
  // output funded where it was rather than clawing ADA back. Legitimate on
  // alpha.4 precisely because the one-way ADA ratchet is gone — lovelace is
  // unconstrained relative to the input in both directions.
  //
  // ⛔ THE FLOOR ARGUMENT IS LOAD-BEARING, AND HERE IS THE MUTANT THAT PROVES
  // IT. Audit r1 M11 replaced this `EvoAssets.lovelaceOf(carried)` with `0n` —
  // removing the floor, so the amount may FALL — and the whole subset stayed
  // GREEN. Measured consequence: a promotion shrinks the datum
  // `Some(Credential)` -> `None`, so this output would be re-set from 2,012,770
  // down to **1,861,920 lovelace — 150,850 drifting out of the protocol UTxO
  // into the wallet's change, per promotion**, with the chain permitting it
  // because alpha.4 leaves lovelace unconstrained. It SURVIVES A, it does NOT
  // survive B: A = the suite as audited at r1; B = the "never below the input"
  // assertion the handover test now makes on every phase, which reddens M11.
  //
  // The address is rebuilt rather than read off `utxo.address` because
  // `minUtxoForOutput` takes bech32; it is the same address by construction —
  // `readCoordination` found this UTxO by querying exactly it.
  const coinsPerUtxoByte = (await client.getProtocolParameters()).coinsPerUtxoByte;
  const outAssets = EvoAssets.withLovelace(
    carried,
    minUtxoAtLeast(EvoAssets.lovelaceOf(carried), {
      address: scriptAddress(networkId, deployment.protocolParams.policyId),
      assets: carried,
      datum: nextDatum,
      coinsPerUtxoByte,
    })
  );

  tx = tx.payToAddress({
    address: utxo.address,
    assets: outAssets,
    datum: new InlineDatum.InlineDatum({ data: nextDatum }),
  });

  // The trampoline: a withdraw-0 from the credential this arm demands.
  //
  // ⛔⛔ EXACTLY ONE WITHDRAWAL, AND THE ARGUMENT IS BY CONSTRUCTION — SO HERE IS
  // WHAT WOULD BREAK IT, AND WHAT ENFORCES IT.
  //
  //   * BY CONSTRUCTION: there is exactly one `tx.withdraw(...)` call per branch
  //     below, the two branches are mutually exclusive (`authCred.type` is
  //     "script" xor "key"), and `authoriseAs` is the ONLY thing that selects
  //     which credential either of them uses. No other code path in this file
  //     adds a withdrawal.
  //   * THE EDIT THAT WOULD BREAK IT: adding a second `tx.withdraw(...)` to the
  //     promote path — most plausibly the SITTING authority's, added by a
  //     maintainer who reads the P1 note, decides to "be safe", and does not
  //     realise the two-phase design depends on the nominee being able to act
  //     ALONE.
  //   * ⚠ AND THE CHAIN WOULD NOT STOP THEM. Upstream is
  //     `pairs.has_key(withdrawals, nominee)` — an EXISTENCE check that never
  //     mentions `old.upgrade_cred`. A promotion carrying BOTH withdrawals is
  //     ACCEPTED. So no on-chain negative can ever cover this, and a devnet
  //     suite alone cannot see the property break (audit r1 F-1; the auditor's
  //     attempt to demonstrate it on chain died at `withdraw@1=3110`,
  //     "Extraneous (non-required) redeemers" — a malformed transaction of the
  //     experiment's own making, reported INCONCLUSIVE rather than counted).
  //   * ⇒ WHAT ENFORCES IT: `UpgradeResult.withdrewFrom`, read off the BUILT
  //     transaction by {@link withdrawalCredentials}, asserted in
  //     `test/devnet/upgrade.test.ts` to be exactly the nominee for a promotion
  //     and exactly the multisig for a nomination. That pair is the positive
  //     control and the negative in one: the nomination proves the instrument
  //     can SEE a script withdrawal, which is what makes the promotion's
  //     "no script withdrawal" a real negative rather than a silent zero.
  //     Mutation-verified: adding the sitting authority's withdrawal here
  //     reddens that assertion OFF-CHAIN, at the assertion.
  //
  // This is the same standard as the arm-0 / `voidData()` residue note in
  // `UpgradeOptions.act` — with the difference that this one IS enforced, so it
  // is a claim with a mutant behind it rather than a claim closed by
  // construction alone.
  //
  // ⚑ ROUTED ON THE DATUM'S CREDENTIAL, NEVER ON `deployment.upgradeAuthority`.
  // The datum is the source of truth for who may authorise this spend — the
  // deployment record is a record, and a promotion moves the datum without
  // moving the record.
  //
  // WHICH credential is the arm's business, not this router's: two arms want
  // the sitting authority (the default below) and `promote_authority` wants the
  // standing nominee. See `UpgradeOptions.authoriseAs`.
  const authCred: Cip113Credential = opts.authoriseAs
    ? opts.authoriseAs(params)
    : params.upgradeCred;

  if (!opts.omitAuthority) {
    if (authCred.type === "script") {
      if (authCred.hash !== deployment.upgradeMultisig.scriptHash) {
        throw new Error(
          `This transaction must be authorised by the SCRIPT credential ${authCred.hash}, which ` +
            `is not this deployment's upgrade_multisig (${deployment.upgradeMultisig.scriptHash}). ` +
            `This fixture can satisfy only two authorities: a KEY credential the wallet holds, or ` +
            `the upgrade_multisig whose config UTxO and script body it can reconstruct. An ` +
            `unrelated script credential needs its own witness and its own satisfaction argument, ` +
            `neither of which DeploymentParams records.`
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
        stakeCredential: Credential.makeScriptHash(Bytes.fromHex(authCred.hash)),
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
    } else if (authCred.type === "key") {
      // withdraw-0: the entry's PRESENCE is the authorisation; the amount is
      // irrelevant to protocol_params, which only does has_key_or_fail. A key
      // credential carries no script and so needs no witness and no redeemer.
      tx = tx.withdraw({
        stakeCredential: Credential.makeKeyHash(Bytes.fromHex(authCred.hash)),
        amount: 0n,
      });
      tx = tx.addSigner({ keyHash: KeyHash.fromHex(authCred.hash) });
    } else {
      throw new Error(
        `The credential this transaction must authorise as is neither a key nor a script ` +
          `credential: ${JSON.stringify(authCred)}. This fixture can satisfy a KEY credential the ` +
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
  // ⛔ READ THE WITHDRAWAL SET OFF THE BUILT BODY, BEFORE SUBMITTING. This is
  // the artefact the ledger will see — not a note of what this function meant
  // to do — which is what makes the devnet test's "the promotion withdraws from
  // the nominee and nobody else" assertion capable of failing. See
  // {@link UpgradeResult.withdrewFrom} for why the chain cannot cover it.
  const withdrewFrom = withdrawalCredentials(await built.toTransaction());

  const res = await built.signAndSubmit();
  const txHash = typeof res === "string" ? res : EvoTransactionHash.toHex(res);
  await client.awaitTx(EvoTransactionHash.fromHex(txHash), 2_000, 180_000);
  return { txHash, withdrewFrom };
}

// ---------------------------------------------------------------------------
// The two-phase authority handover
//
// Upstream (issue #125) refused the single-step form on purpose. A direct
// rewrite of `upgrade_cred` reinstates the one-way brick: a typo, or the hash of
// a script nobody ever deployed, becomes the authority and nothing can move it
// back. What the two phases demand instead is EVIDENCE THAT THE INCOMING
// AUTHORITY EXISTS, RUNS AND CONSENTS — which is exactly what a withdraw-0 from
// the nominee's own credential is. The co-signature form drafted in #125 was
// rejected because it would require the nominee to appear inside a transaction
// built by someone else, which no governance action and no slowly-assembled
// quorum can promise.
// ---------------------------------------------------------------------------

/**
 * PHASE ONE. The SITTING authority nominates `nominee`, writing
 * `pending_upgrade_cred = Some(nominee)`. Returns the transaction hash.
 *
 * Nothing takes effect. `upgrade_cred` is untouched and the nominee holds no
 * power whatsoever until it activates itself in phase two — which is also why
 * a nomination is revocable by another nomination (`None` revokes).
 *
 * ⚑ IT READS EVERYTHING EXCEPT THE NOMINEE FROM CHAIN, so it is runnable on its
 * own against a protocol in any state. That is the property, not a convenience:
 * a handover that half-happened is completed by calling the next phase, never by
 * replaying this one from a variable some caller was holding (WORKLOG S-12).
 *
 * The authorisation is the DEFAULT branch — `sitting_authority_approves`, i.e.
 * `pairs.has_key(withdrawals, old.upgrade_cred)`, the same rule `protocol_upgrade`
 * uses. Only the promotion below departs from it.
 */
export async function nominateAuthority(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
  nominee: Cip113Credential
): Promise<UpgradeResult> {
  return upgradeProtocol(blueprint, deployment, {
    // `Constr(1, [])` — a value `voidData()` cannot represent, which is why
    // this arm landing on chain is half of the proof that the single
    // `protocolParamsRedeemer` call site really encodes the act it is given.
    act: "NOMINATE_AUTHORITY",
    // `nominate_authority` is ONE RECORD EQUALITY over everything else, so this
    // spread must change exactly one field. Adding a second here is what test
    // "REFUSED: a parameter change cannot ride inside a NominateAuthority"
    // exists to catch.
    change: (current) => ({ ...current, pendingUpgradeCred: nominee }),
  });
}

export interface PromoteOptions {
  /**
   * Drop the nominee's authorisation entirely — no withdrawal, no signer.
   * For the refusal test only: it is what makes
   * `pairs.has_key(withdrawals, nominee)` the rail under observation.
   */
  readonly omitNomineeWithdrawal?: boolean;
  /**
   * Perturb the continuing datum AFTER the promotion has been applied to it.
   * For the refusal test only.
   *
   * ⚑ APPLIED LAST, ON PURPOSE, so the transaction differs from a VALID
   * promotion by exactly one variable — the smuggled field — and the record
   * equality is the only rail that can be answering. A negative built by
   * hand-assembling a different datum would violate several rails at once and
   * could not say which one fired.
   */
  readonly smuggleChange?: (promoted: ProtocolParamsData) => ProtocolParamsData;
}

/**
 * PHASE TWO. The standing NOMINEE promotes itself: `upgrade_cred` becomes the
 * nomination and `pending_upgrade_cred` is cleared. Returns the transaction
 * hash.
 *
 * ⛔⛔ THE SITTING AUTHORITY DOES NOT APPEAR IN THIS TRANSACTION AT ALL. Every
 * OTHER arm of this validator is authorised by `old.upgrade_cred`;
 * `promote_authority` is authorised by `old.pending_upgrade_cred` and by
 * nothing else. A reader who assumes symmetry will add the sitting authority's
 * withdrawal here and never notice the mistake, because an extra withdrawal is
 * not REFUSED — it is simply not what the rule reads, so the failure names the
 * missing nominee withdrawal instead. Mutation P1 (authorise with the sitting
 * authority instead) is what proves this asymmetry was implemented rather than
 * assumed; it is refused on chain.
 *
 * ⚑ THE NOMINEE IS READ FROM THE DATUM, NEVER FROM AN ARGUMENT — which is why
 * this function takes none. A nominee passed in by a caller and a nominee on
 * chain are two facts that can disagree, and only the on-chain one decides:
 * the validator reads the datum, so the withdrawal this builds must be keyed on
 * the same value the validator will read.
 */
export async function promoteAuthority(
  blueprint: PlutusBlueprint,
  deployment: DeploymentParams,
  opts: PromoteOptions = {}
): Promise<UpgradeResult> {
  // ⛔ THE CLIENT-SIDE REFUSAL, AND IT FIRES BEFORE ANYTHING IS BUILT OR SPENT.
  // On chain, promoting with no standing nomination dies on
  // `expect Some(nominee) = old.pending_upgrade_cred` — an `expect` failure,
  // which produces an evaluation error with an EMPTY TRACE LIST naming nothing.
  // A check that fires before the expensive, irreversible half has already won
  // (verification-harness §16b), and this one additionally converts a message
  // that names nothing into one that names the protocol, the field and the
  // remedy. MEASURED as mutation P4: deleting this guard and calling the
  // function on a protocol with `pending = null` produces exactly that
  // uninformative on-chain failure.
  const client: any = await makeClient();
  const { params } = await readCoordination(client, deployment);
  if (params.pendingUpgradeCred === null) {
    throw new Error(
      `promoteAuthority: there is no standing nomination on this protocol — ` +
        `pending_upgrade_cred is None, and promote_authority has nothing to promote. ` +
        `The sitting authority (${params.upgradeCred.type} ${params.upgradeCred.hash}) must ` +
        `run nominateAuthority() first; a promotion is phase TWO of two and cannot be the ` +
        `first transaction of a handover.`
    );
  }

  /**
   * Re-read the nominee from the datum `upgradeProtocol` itself fetched. The
   * pre-read above is the guard; THIS is the value that reaches the
   * transaction, so the two cannot drift apart if the chain moves between them.
   */
  const requireNominee = (current: ProtocolParamsData): Cip113Credential => {
    const nominee = current.pendingUpgradeCred;
    if (nominee === null) {
      throw new Error(
        `promoteAuthority: the nomination disappeared between the pre-flight read and the ` +
          `build — pending_upgrade_cred is now None. The sitting authority revoked it; ` +
          `nominate again before promoting.`
      );
    }
    return nominee;
  };

  return upgradeProtocol(blueprint, deployment, {
    // `Constr(2, [])` — the other value `voidData()` cannot represent.
    act: "PROMOTE_AUTHORITY",
    change: (current) => {
      // `promote_authority` is a PURE RECORD EQUALITY: `new == old` with
      // `upgrade_cred: nominee` and `pending_upgrade_cred: None`, and nothing
      // else. Written as a spread from `current` so a field added to the datum
      // later is carried through automatically rather than silently dropped —
      // the same reason upstream wrote the rail as one equality instead of
      // field by field.
      const promoted: ProtocolParamsData = {
        ...current,
        upgradeCred: requireNominee(current),
        pendingUpgradeCred: null,
      };
      return opts.smuggleChange ? opts.smuggleChange(promoted) : promoted;
    },
    // ⛔ THE NOMINEE'S WITHDRAWAL, NOT THE SITTING AUTHORITY'S. See the block
    // comment above; this one line is the whole asymmetry.
    authoriseAs: requireNominee,
    omitAuthority: opts.omitNomineeWithdrawal === true,
  });
}
