/**
 * T-G07 — the devnet rehearsal of all three upgrade lifecycle operations,
 * driven through the EXPORTED builders rather than the harness's own.
 *
 * ⛔ WHY THROUGH THE EXPORTS, AND WHY THAT IS THE POINT OF THE TICKET. The
 * harness has been able to perform a params upgrade since alpha.4. What has
 * never existed is a path a CONSUMER can take: `test/harness/` is not published,
 * so the platform would otherwise maintain its own port of a protocol-critical
 * sequence — the exact defect the 2026-09-17 boundary amendment exists to
 * remove. A rehearsal that used the harness builders would prove the harness
 * works and say nothing about the artefact that ships.
 *
 * The three operations, in the order the epic runs them:
 *   1. SIGNER ROTATION, twice — 1-of-1 → 2-of-3 (admin alone), then
 *      2-of-3 → a different 2-of-3 (two of three signers, multi-witness).
 *   2. PARAMS BREAK AND RESTORE — `third_party_cred` alone first, then all four
 *      mutable delegates, each round-tripped.
 *   3. AUTHORITY HANDOVER — a second `upgrade_multisig` stood up from scratch,
 *      registered, nominated, promoted.
 *
 * ⚠ ONE INSTANCE, SEQUENTIAL, SHARED STATE. These are not independent tests and
 * must not be reordered: a rotation changes who can authorise everything after
 * it, and a promotion changes it again. They are one `test()` for that reason —
 * node:test would otherwise be free to interleave them.
 *
 * ⚑ EVERY STEP RE-READS the UTxO it operates on. Both coordinates move on every
 * operation (`protocol_params` spend moves the params UTxO, `upgrade_multisig`
 * spend moves the config UTxO), so a cached coordinate is stale by construction
 * and the recorded one in `DeploymentParams` is stale after the first step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Address as EvoAddress,
  Transaction as EvoTransaction,
  TransactionWitnessSet as EvoWitnessSet,
} from "@evolution-sdk/evolution";

/**
 * ⚠ `submitTx` TAKES A Transaction OBJECT, NOT HEX. Evolution's Kupmios
 * provider calls `Transaction.toCBORHex` on its argument, so a hex string is
 * re-parsed as a Transaction and fails with a bare `ParseError` naming the whole
 * CBOR blob — which reads as a malformed transaction and means a wrong argument
 * type.
 *
 * ⚑ And the round-trip is SAFE for a witness-merged transaction: `fromCBORHex`
 * captures the CBOR format tree, so re-serialising preserves the original body
 * bytes and the signatures stay valid over what they signed. That is the same
 * property `test/upgrade-witnesses.test.mjs` pins offline.
 */
const asTx = (hex: string) => EvoTransaction.fromCBORHex(hex);

/**
 * `submitTx` returns a TransactionHash OBJECT whose `hash` is RAW BYTES, not
 * hex. Printing it directly yields a comma-separated byte list, which looks like
 * a corrupted hash and is simply the wrong rendering.
 */
const hashOf = (h: any): string => {
  if (typeof h === "string") return h;
  const raw = h?.hash;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("hex");
  if (typeof raw === "string") return raw;
  return String(h);
};

/** Every submission, in order — printed at the end as the campaign's record. */
const RECORD: Array<{ step: string; txHash: string }> = [];

import {
  assembleMultiSignedTx,
  assertVKeyWitnessCount,
  buildNominateAuthorityTx,
  buildProtocolUpgradeTx,
  buildPromoteAuthorityTx,
  buildRegisterCredentialTx,
  buildRotateMultisigTx,
  buildStandaloneMultisigGenesisTx,
  countVKeyWitnesses,
  locateProtocolParams,
  locateUpgradeMultisig,
  protocolParamsAddress,
  upgradeMultisigAddress,
  EvoAssets,
} from "../../dist/index.js";
import { createStandardScripts } from "../../dist/standard/scripts.js";
import { paymentCredentialHash, spendableWalletUtxos } from "../../dist/core/evo-utils.js";

import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { makeClient, waitFor as waitForNullable } from "../harness/yaci.mjs";

/**
 * `waitFor` is typed `T | null` because its predicate may legitimately return a
 * falsy "not yet". Every call in this file treats a timeout as fatal — the
 * campaign cannot continue past a step that did not land — so the non-null is
 * asserted ONCE here rather than with a `!` at each of a dozen call sites, where
 * one missing `!` would be a type error and one spurious one would hide a real
 * null.
 */
async function waitFor<T>(fn: () => Promise<T | null | undefined>, opts: any): Promise<T> {
  const got = await waitForNullable(fn, opts);
  if (got === null || got === undefined) {
    throw new Error(`waitFor: ${opts?.what ?? "condition"} never became true`);
  }
  return got as T;
}
import { createOgmiosEvaluator } from "../harness/ogmios-evaluator.js";

const OGMIOS = process.env.OGMIOS_URL ?? "http://localhost:1337";

type Signer = { readonly client: any; readonly pkh: string; readonly label: string };

test("the three upgrade lifecycle operations, end to end, through the exported builders", async () => {
  const blueprint = loadStandardBlueprint();
  const deployment = await bootstrapProtocol();
  const admin: any = await makeClient();
  const networkId = admin.chain.id;
  const evaluator = createOgmiosEvaluator(OGMIOS);

  const adminAddr = EvoAddress.toBech32(await admin.address());
  const adminPkh = paymentCredentialHash(adminAddr);

  /** Three more signers off the same mnemonic. They need no funds — only keys. */
  const signers: Signer[] = [{ client: admin, pkh: adminPkh, label: "acct0/admin" }];
  for (const i of [1, 2, 3]) {
    const c: any = await makeClient(undefined, { accountIndex: i });
    const a = EvoAddress.toBech32(await c.address());
    signers.push({ client: c, pkh: paymentCredentialHash(a), label: `acct${i}` });
  }
  const [S0, S1, S2, S3] = signers;
  assert.equal(new Set(signers.map((s) => s.pkh)).size, 4, "four DISTINCT signers, or the trees below are not what they claim");

  const MS_ADDR = upgradeMultisigAddress(networkId, deployment);
  const PP_ADDR = protocolParamsAddress(networkId, deployment);

  // -------------------------------------------------------------------------
  // Helpers — every one of them re-reads the chain
  // -------------------------------------------------------------------------

  const ctx = async () => {
    const wallet = await admin.getUtxos(EvoAddress.fromBech32(adminAddr));
    return {
      client: admin,
      changeAddress: adminAddr,
      availableUtxos: spendableWalletUtxos(wallet, deployment),
      evaluator,
    };
  };

  const readConfig = async () =>
    locateUpgradeMultisig({
      deployment,
      networkId,
      utxosAtAddress: await admin.getUtxos(EvoAddress.fromBech32(MS_ADDR)),
    });

  /**
   * Sign with each named signer, merge, COUNT, submit, await.
   *
   * ⛔ THE COUNT IS NOT DECORATION. Evolution's signer returns an EMPTY witness
   * set rather than failing when it holds none of the required keys — a
   * successful call that signs nothing. Without this assertion a 2-of-3
   * transaction carrying one witness reaches the chain and is refused for a
   * missing witness, naming a key rather than the signer that did nothing.
   */
  const submitSignedBy = async (cbor: string, who: readonly Signer[], what: string) => {
    const walletUtxos = await admin.getUtxos(EvoAddress.fromBech32(adminAddr));
    const sets: string[] = [];
    for (const s of who) {
      const ws = await s.client.signTx(cbor, { utxos: walletUtxos });
      const hex = EvoWitnessSet.toCBORHex(ws);
      sets.push(hex);
    }
    const signed = assembleMultiSignedTx(cbor, sets);
    assertVKeyWitnessCount(signed, who.length);
    const txHash = await admin.submitTx(asTx(signed));
    await admin.awaitTx(txHash);
    const h = hashOf(txHash);
    // eslint-disable-next-line no-console
    console.log(`   ✔ ${what} — tx ${h}`);
    RECORD.push({ step: what, txHash: h });
    return h;
  };

  const sig = (pkh: string) => ({ type: "signature" as const, keyHash: pkh });

  // =========================================================================
  // OPERATION 1 — signer rotation
  // =========================================================================

  const atBootstrap = await readConfig();
  assert.deepEqual(
    atBootstrap.tree,
    sig(adminPkh),
    "the bootstrap installs Signature(adminPkh) — a 1-of-1, which is what makes the first rotation signable by one key",
  );

  // --- Rotation 1: 1-of-1 -> 2-of-3, authorised by the single sitting key ----
  const TWO_OF_THREE = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S0.pkh), sig(S1.pkh), sig(S2.pkh)],
  };

  const rot1 = await buildRotateMultisigTx({
    ...(await ctx()),
    blueprint,
    deployment,
    configUtxo: atBootstrap.utxo,
    newTree: TWO_OF_THREE,
    signerKeyHashes: [adminPkh],
  });
  await submitSignedBy(rot1.cbor, [S0], "ROTATION 1: 1-of-1 -> 2-of-3");

  const afterRot1 = await waitFor(
    async () => {
      const c = await readConfig();
      return JSON.stringify(c.tree) === JSON.stringify(TWO_OF_THREE) ? c : null;
    },
    { what: "the 2-of-3 tree to appear on chain", timeoutMs: 120_000 },
  );
  assert.deepEqual(afterRot1.tree, TWO_OF_THREE, "the authority is now 2-of-3, read back off the chain");
  assert.notDeepEqual(
    afterRot1.ref,
    atBootstrap.ref,
    "and the config UTxO MOVED — which is why every later step re-reads it",
  );

  // --- Rotation 2: 2-of-3 -> a different 2-of-3, TWO witnesses --------------
  const ROTATED = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S0.pkh), sig(S1.pkh), sig(S3.pkh)], // S2 out, S3 in
  };

  const rot2 = await buildRotateMultisigTx({
    ...(await ctx()),
    blueprint,
    deployment,
    configUtxo: afterRot1.utxo,
    newTree: ROTATED,
    signerKeyHashes: [S0.pkh, S1.pkh],
  });

  // ⛔ THE MULTI-WITNESS PROOF. Two signers, two witness sets, merged. S1 owns
  // no UTxOs at all — it signs purely because the transaction NAMES its key in
  // required_signers, which is what `satisfied` reads for a Signature leaf.
  const w0 = EvoWitnessSet.toCBORHex(
    await S0.client.signTx(rot2.cbor, { utxos: (await ctx()).availableUtxos }),
  );
  const w1 = EvoWitnessSet.toCBORHex(await S1.client.signTx(rot2.cbor, { utxos: [] }));
  assert.ok(
    countVKeyWitnesses(assembleMultiSignedTx(rot2.cbor, [w1])) === 1,
    "an UNFUNDED signer must still produce a witness — it is named in required_signers",
  );
  const bothSigned = assembleMultiSignedTx(rot2.cbor, [w0, w1]);
  assertVKeyWitnessCount(bothSigned, 2);
  const rot2Submitted = await admin.submitTx(asTx(bothSigned));
  await admin.awaitTx(rot2Submitted);
  const rot2Hash = hashOf(rot2Submitted);
  RECORD.push({ step: "ROTATION 2: 2-of-3 -> 2-of-3' (TWO witnesses)", txHash: rot2Hash });
  // eslint-disable-next-line no-console
  console.log(`   ✔ ROTATION 2: 2-of-3 -> 2-of-3' with TWO witnesses — tx ${rot2Hash}`);

  const afterRot2 = await waitFor(
    async () => {
      const c = await readConfig();
      return JSON.stringify(c.tree) === JSON.stringify(ROTATED) ? c : null;
    },
    { what: "the rotated 2-of-3 tree", timeoutMs: 120_000 },
  );
  assert.deepEqual(afterRot2.tree, ROTATED, "a 2-of-3 authority rotated itself, satisfied by exactly two of three");

  // --- The negative: ONE of three is not enough ----------------------------
  // ⛔ THE REFUSAL THAT MAKES THE POSITIVE MEAN SOMETHING. Without it, "two
  // signatures worked" is consistent with the threshold being ignored entirely.
  const underQuorum = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S0.pkh), sig(S1.pkh), sig(S2.pkh)],
  };
  let refusedOffline: Error | undefined;
  try {
    await buildRotateMultisigTx({
      ...(await ctx()),
      blueprint,
      deployment,
      configUtxo: afterRot2.utxo,
      newTree: underQuorum,
      signerKeyHashes: [S0.pkh], // one of the three the CURRENT tree needs two of
    });
  } catch (e) {
    refusedOffline = e as Error;
  }
  assert.ok(refusedOffline, "a 1-of-3 quorum must be refused");
  assert.match(
    refusedOffline!.message,
    /do NOT satisfy the authority tree/,
    "and refused OFFLINE by the preflight, before a fee is paid — the chain's answer is an empty trace list",
  );

  // eslint-disable-next-line no-console
  console.log(
    `\n   OPERATION 1 COMPLETE — rotations: ${afterRot1.ref.txHash}#${afterRot1.ref.outputIndex} ` +
      `then ${afterRot2.ref.txHash}#${afterRot2.ref.outputIndex}\n`,
  );

  // =========================================================================
  // OPERATION 2 — break the params and restore them
  // =========================================================================

  const msCompiled = createStandardScripts(blueprint).upgradeMultisig(
    deployment.upgradeMultisig.txInput,
  ).compiledCode;

  const readParams = async () =>
    locateProtocolParams({
      deployment,
      networkId,
      utxosAtAddress: await admin.getUtxos(EvoAddress.fromBech32(PP_ADDR)),
    });

  /** The sitting authority, re-read every time: its config UTxO moves on every rotation. */
  const sittingAuth = async (who: readonly Signer[]) => ({
    kind: "script" as const,
    scriptHash: deployment.upgradeMultisig.scriptHash,
    compiledCode: msCompiled,
    configUtxo: (await readConfig()).utxo,
    signerKeyHashes: who.map((w) => w.pkh),
  });

  const QUORUM = [S0, S1] as const; // the rotated 2-of-3 is satisfied by these two

  const atGenesis = await readParams();
  // eslint-disable-next-line no-console
  console.log(`   params at genesis: thirdParty=${atGenesis.params.thirdPartyCred.hash}`);

  /** Recognisable on sight: no script exists behind any of these. */
  const FAKE_THIRD_PARTY = { type: "script" as const, hash: "de".repeat(28) };

  // --- Break ONE credential first — the narrowest possible blast radius -----
  const break1 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: atGenesis.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({ ...p, thirdPartyCred: FAKE_THIRD_PARTY }),
  });
  await submitSignedBy(break1.cbor, QUORUM, "BREAK 1: thirdPartyCred -> de*28 (no such script exists)");

  const broken1 = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.thirdPartyCred.hash === FAKE_THIRD_PARTY.hash ? p : null;
    },
    { what: "the fake thirdPartyCred on chain", timeoutMs: 120_000 },
  );
  assert.equal(broken1.params.thirdPartyCred.hash, FAKE_THIRD_PARTY.hash, "the protocol now names a script that does not exist");
  assert.deepEqual(
    broken1.params.upgradeCred,
    atGenesis.params.upgradeCred,
    "⛔ AND THE AUTHORITY IS UNMOVED — this arm freezes it, which is the whole reason the break is recoverable",
  );

  // --- Restore it -----------------------------------------------------------
  const restore1 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: broken1.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({ ...p, thirdPartyCred: atGenesis.params.thirdPartyCred }),
  });
  await submitSignedBy(restore1.cbor, QUORUM, "RESTORE 1: thirdPartyCred back to the real script");

  const restored1 = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.thirdPartyCred.hash === atGenesis.params.thirdPartyCred.hash ? p : null;
    },
    { what: "thirdPartyCred restored", timeoutMs: 120_000 },
  );
  assert.deepEqual(restored1.params, atGenesis.params, "the datum is byte-for-byte what it was at genesis — a true round trip");

  // --- Now all four at once -------------------------------------------------
  const ALL_FAKE = {
    plgCred: { type: "script" as const, hash: "de".repeat(28) },
    issuanceLogicCred: { type: "script" as const, hash: "ad".repeat(28) },
    transferCred: { type: "script" as const, hash: "be".repeat(28) },
    thirdPartyCred: { type: "script" as const, hash: "ef".repeat(28) },
  };
  const break4 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: restored1.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({ ...p, ...ALL_FAKE }),
  });
  await submitSignedBy(break4.cbor, QUORUM, "BREAK 4: ALL FOUR mutable delegates -> fakes");

  const broken4 = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.plgCred.hash === ALL_FAKE.plgCred.hash ? p : null;
    },
    { what: "all four fakes on chain", timeoutMs: 120_000 },
  );
  for (const [field, cred] of Object.entries(ALL_FAKE)) {
    assert.equal((broken4.params as any)[field].hash, cred.hash, `${field} is the fake`);
  }

  // ⛔ THE CENTRAL CLAIM OF OPERATION 2, NOW MEASURED RATHER THAN REASONED: a
  // protocol pointing at four non-existent scripts is still repairable, because
  // the repair is authorised by `upgradeCred` — which this arm freezes and which
  // no delegate credential influences.
  const restore4 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: broken4.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({
      ...p,
      plgCred: atGenesis.params.plgCred,
      issuanceLogicCred: atGenesis.params.issuanceLogicCred,
      transferCred: atGenesis.params.transferCred,
      thirdPartyCred: atGenesis.params.thirdPartyCred,
    }),
  });
  await submitSignedBy(restore4.cbor, QUORUM, "RESTORE 4: all four back — the protocol works again");

  const restored4 = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.plgCred.hash === atGenesis.params.plgCred.hash ? p : null;
    },
    { what: "all four restored", timeoutMs: 120_000 },
  );
  assert.deepEqual(
    restored4.params,
    atGenesis.params,
    "ROUND TRIP COMPLETE: the live wiring is identical to genesis, after being broken in four places",
  );

  // eslint-disable-next-line no-console
  console.log("\n   OPERATION 2 COMPLETE — broken and restored twice, datum identical to genesis\n");

  // =========================================================================
  // OPERATION 3 — the authority handover, four ordered transactions
  // =========================================================================

  // --- (a) stand up a SECOND upgrade_multisig, from scratch ----------------
  const spare = (await ctx()).availableUtxos.find((u: any) => EvoAssets.lovelaceOf(u.assets) > 20_000_000n);
  assert.ok(spare, "a spare wallet UTxO is needed as the new authority's one-shot seed");

  const NOMINEE_TREE = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S2.pkh), sig(S3.pkh)],
  };

  const genesis2 = await buildStandaloneMultisigGenesisTx({
    ...(await ctx()),
    blueprint,
    seedUtxo: spare,
    tree: NOMINEE_TREE,
  });
  const nomineeHash = (genesis2.metadata as any).scriptHash as string;
  const nomineeCode = (genesis2.metadata as any).compiledCode as string;
  const nomineeAddr = (genesis2.metadata as any).address as string;
  assert.notEqual(nomineeHash, deployment.upgradeMultisig.scriptHash, "the nominee is a DIFFERENT script, not a rotation");
  await submitSignedBy(genesis2.cbor, [S0], `HANDOVER a: second upgrade_multisig minted (${nomineeHash.slice(0, 16)}…)`);

  const nomineeConfig = await waitFor(
    async () => {
      const utxos = await admin.getUtxos(EvoAddress.fromBech32(nomineeAddr));
      return utxos.length > 0 ? utxos : null;
    },
    { what: "the nominee's config UTxO", timeoutMs: 120_000 },
  );

  // --- (b) register its stake credential, in its OWN transaction -----------
  // ⛔ WITHDRAWALS APPLY BEFORE CERTIFICATES, so this cannot share a
  // transaction with the promotion that uses it. Four transactions, minimum.
  const reg = await buildRegisterCredentialTx({
    ...(await ctx()),
    credentials: [{ scriptHash: nomineeHash, compiledCode: nomineeCode }],
  });
  await submitSignedBy(reg.cbor, [S0], "HANDOVER b: the nominee's stake credential registered");

  // --- (c) nominate it, authorised by the SITTING authority ----------------
  const beforeNomination = await readParams();
  const nominate = await buildNominateAuthorityTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: beforeNomination.utxo,
    authorisation: await sittingAuth(QUORUM),
    nominee: { type: "script", hash: nomineeHash },
  });
  await submitSignedBy(nominate.cbor, QUORUM, "HANDOVER c: NominateAuthority — the sitting authority names its successor");

  const nominated = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.pendingUpgradeCred?.hash === nomineeHash ? p : null;
    },
    { what: "the nomination on chain", timeoutMs: 120_000 },
  );
  assert.deepEqual(
    nominated.params.upgradeCred,
    atGenesis.params.upgradeCred,
    "a nomination does NOT move the authority — only the promotion may",
  );

  // --- (d) promote it, authorised by the NOMINEE ITSELF --------------------
  // ⛔ THE SITTING AUTHORITY DOES NOT APPEAR. The evidence the rail demands is
  // that the incoming authority EXISTS, RUNS and CONSENTS.
  const promote = await buildPromoteAuthorityTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: nominated.utxo,
    authorisation: {
      kind: "script",
      scriptHash: nomineeHash,
      compiledCode: nomineeCode,
      configUtxo: nomineeConfig[0],
      signerKeyHashes: [S2.pkh, S3.pkh],
    },
  });
  assert.deepEqual(
    (promote.metadata as any).withdrewFrom,
    [{ type: "script", hash: nomineeHash }],
    "EXCLUSIVITY: the promotion withdraws ONLY the nominee — unenforceable on chain, so asserted here",
  );
  // ⛔⛔ MEASURED HERE, AND IT IS A FINDING WORTH THE WHOLE RUN. Signing this
  // with the nominee's quorum ALONE was refused with ledger code 3101,
  // `missingSignatories: [00b7847c…]` — the ADMIN's payment key.
  //
  // The reason is that a transaction's signer set is the UNION of two disjoint
  // requirements, and only one of them is about the authority:
  //   * the AUTHORITY's satisfying subset, which the tree reads out of
  //     `required_signers` (here S2 + S3, the nominee's 2-of-2); and
  //   * whoever OWNS THE INPUTS, because the fee and collateral come from an
  //     ordinary wallet and those UTxOs are locked by its payment key (here S0).
  //
  // ⚠ WHY IT DID NOT SURFACE EARLIER IN THIS VERY CAMPAIGN: every preceding step
  // was signed by a set that happened to CONTAIN the fee payer — the rotations
  // by [S0] and [S0, S1], the upgrades by [S0, S1]. The promotion is the first
  // transaction whose authority quorum EXCLUDES the wallet paying for it, which
  // is precisely the shape a real handover has: the incoming authority consents,
  // and somebody else pays.
  //
  // ⇒ So `signerKeyHashes` on the authorisation stays [S2, S3] — those are what
  // the TREE needs — and the SIGNING set is [S0, S2, S3]. The two are different
  // questions and conflating them is a 3101 naming a key with no explanation.
  await submitSignedBy(
    promote.cbor,
    [S0, S2, S3],
    "HANDOVER d: PromoteAuthority — the nominee promotes itself (fee payer signs too)",
  );

  const promoted = await waitFor(
    async () => {
      const p = await readParams();
      return p.params.upgradeCred.hash === nomineeHash ? p : null;
    },
    { what: "the promotion on chain", timeoutMs: 120_000 },
  );
  assert.equal(promoted.params.upgradeCred.hash, nomineeHash, "the authority has MOVED to the second multisig");
  assert.equal(promoted.params.pendingUpgradeCred, null, "and the nomination is cleared");
  assert.notEqual(
    promoted.params.upgradeCred.hash,
    atGenesis.params.upgradeCred.hash,
    "a multisig -> multisig handover, which no chain had seen before this run",
  );

  // --- And the new authority really governs: it can upgrade --------------
  // ⛔ THE PROOF THAT THE HANDOVER WAS REAL AND NOT COSMETIC. A datum field that
  // changed proves a write; an upgrade authorised by the NEW authority proves
  // the credential is live, registered, and satisfied by its own tree.
  const afterHandover = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: promoted.utxo,
    authorisation: {
      kind: "script",
      scriptHash: nomineeHash,
      compiledCode: nomineeCode,
      configUtxo: nomineeConfig[0],
      signerKeyHashes: [S2.pkh, S3.pkh],
    },
    change: (p) => ({ ...p, thirdPartyCred: FAKE_THIRD_PARTY }),
  });
  await submitSignedBy(
    afterHandover.cbor,
    [S0, S2, S3],
    "HANDOVER e: the NEW authority performs an upgrade",
  );

  await waitFor(
    async () => {
      const p = await readParams();
      return p.params.thirdPartyCred.hash === FAKE_THIRD_PARTY.hash ? p : null;
    },
    { what: "an upgrade authorised by the new authority", timeoutMs: 120_000 },
  );

  // eslint-disable-next-line no-console
  console.log(
    "\n   OPERATION 3 COMPLETE — multisig -> multisig handover in four ordered transactions\n" +
      "\n=== CAMPAIGN RECORD ===\n" +
      RECORD.map((r, i) => `${String(i + 1).padStart(2)}. ${r.txHash}  ${r.step}`).join("\n") +
      "\n=======================\n",
  );

  assert.ok(RECORD.length >= 11, `the campaign should have submitted at least 11 transactions; got ${RECORD.length}`);
});
