/**
 * T-G08 — run the three upgrade lifecycle operations on the PREVIEW public
 * chain, against an instance recorded by `deploy-preview.ts`.
 *
 * Usage:  node --import tsx test/harness/upgrade-preview.ts --instance <name>
 *
 * ⛔ WHY THIS EXISTS SEPARATELY FROM THE DEVNET TEST. The operations are the
 * same exported builders driven in the same order; what differs is everything
 * around them, and the differences are the ones that have cost this repo runs
 * before:
 *
 *   - BLOCKFROST SERVES INCONSISTENT VIEWS. `/txs/{hash}` and
 *     `/addresses/{addr}/utxos` advance independently, so a transaction can be
 *     confirmed while the UTxO set still shows the pre-spend state. Every read
 *     here therefore polls for the EXPECTED STATE rather than for a
 *     confirmation — the condition is "the chain says what I expect", not "the
 *     indexer admits the tx exists".
 *   - A TRANSPORT BLIP THROWS rather than returning a bad status, so every
 *     fetch is wrapped. A bootstrap once died on a bare `fetch failed` after
 *     all seven transactions had landed, leaving one-shot seeds spent and no
 *     record.
 *   - `awaitTx` FROM THE SDK GIVES UP TOO EARLY on preview: Blockfrost's
 *     confirmation view lags block inclusion, so the poller and the reader
 *     disagree and a transaction that SUCCEEDED aborts the run.
 *
 * ⚠ THIS SCRIPT SUBMITS REAL TRANSACTIONS and spends real (worthless) preview
 * ADA. It is a harness fixture, never shipped: `files` ships only `dist` and
 * `blueprints`.
 *
 * ⚑ THE AUTHORITY KEYS ARE DERIVED FROM THE FUNDING WALLET'S OWN MNEMONIC,
 * accounts 1–3. An earlier draft of the epic claimed the resulting instance
 * would be one "Giovanni does not control", which gate 3 correctly called an
 * internal contradiction: every account derived from his seed is a key he
 * holds. He then ruled custody irrelevant — *"I don't care and I don't want the
 * keys, all I care is to review the tx and that the code matches the prod
 * tokens code version 0.0.1"* — so the simplest honest arrangement is used and
 * the doc states it plainly rather than claiming a property it does not have.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  Address as EvoAddress,
  Transaction as EvoTransaction,
  TransactionWitnessSet as EvoWitnessSet,
} from "@evolution-sdk/evolution";

import type { DeploymentParams } from "../../dist/types.js";
import {
  assembleMultiSignedTx,
  assertDeploymentScripts,
  assertVKeyWitnessCount,
  buildNominateAuthorityTx,
  buildProtocolUpgradeTx,
  buildPromoteAuthorityTx,
  buildRegisterCredentialTx,
  buildRotateMultisigTx,
  buildStandaloneMultisigGenesisTx,
  evoClient,
  locateProtocolParams,
  locateUpgradeMultisig,
  previewChain,
  protocolParamsAddress,
  spendableWalletUtxos,
  upgradeMultisigAddress,
  EvoAssets,
} from "../../dist/index.js";
import { paymentCredentialHash } from "../../dist/core/evo-utils.js";
import { createStandardScripts } from "../../dist/standard/scripts.js";
import { loadStandardBlueprint } from "./bootstrap.js";
import { loadInstance, requireInstanceName } from "./instances.mjs";

const BF = "https://cardano-preview.blockfrost.io/api/v0";

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

const RECORD: Array<{ n: number; step: string; txHash: string; note?: string }> = [];

async function main(): Promise<void> {
  const instanceName = requireInstanceName("preview");
  const env = loadEnv(new URL("../../.env.preview", import.meta.url).pathname);
  for (const k of ["WALLET_MNEMONIC", "BLOCKFROST_KEY"]) {
    if (!env[k]) throw new Error(`.env.preview is missing ${k}`);
  }
  const projectId = env.BLOCKFROST_KEY!;

  const mkClient = (accountIndex: number) =>
    evoClient(previewChain)
      .withBlockfrost({ projectId, baseUrl: BF })
      .withSeed({ mnemonic: env.WALLET_MNEMONIC!, accountIndex });

  const admin: any = mkClient(0);
  if (admin.chain.id !== 0) throw new Error("refusing: not a testnet");
  const networkId = admin.chain.id;

  const adminAddr = EvoAddress.toBech32(await admin.address());
  const signers: Array<{ client: any; pkh: string; label: string }> = [
    { client: admin, pkh: paymentCredentialHash(adminAddr), label: "acct0/admin" },
  ];
  for (const i of [1, 2, 3]) {
    const c: any = mkClient(i);
    signers.push({
      client: c,
      pkh: paymentCredentialHash(EvoAddress.toBech32(await c.address())),
      label: `acct${i}`,
    });
  }
  const [S0, S1, S2, S3] = signers;
  if (new Set(signers.map((s) => s.pkh)).size !== 4) throw new Error("signers are not distinct");

  // ⚑ `loadInstance` is declared `unknown` on purpose — a record read off disk
  // is not a validated `DeploymentParams`. The narrowing here is a CLAIM, and
  // the claim is checked immediately below by `assertDeploymentScripts`, which
  // re-derives all ten script hashes from the blueprint and refuses a record
  // that does not reproduce. Narrowing without that check would be a cast
  // asserting what nothing verified.
  const blueprint = loadStandardBlueprint();
  const deployment = loadInstance("preview", instanceName) as DeploymentParams;
  const MS_ADDR = upgradeMultisigAddress(networkId, deployment);
  const PP_ADDR = protocolParamsAddress(networkId, deployment);

  // ⛔ THE CODE-VERSION CHECK, AND IT IS THE THING GIOVANNI ASKED FOR. Every
  // script hash in the record is re-derived from the shipped v0.0.1 blueprint;
  // a record describing any other protocol version, or any other instance, is
  // refused here rather than discovered at submission.
  const checks = assertDeploymentScripts(blueprint, deployment);
  console.log(`provenance : ${checks.length} script hashes re-derived from the v0.0.1 blueprint and matched`);
  console.log(`network    : preview (id ${networkId})`);
  console.log(`instance   : ${instanceName}`);
  console.log(`protocol   : ${deployment.txHash}`);
  console.log(`params addr: ${PP_ADDR}`);
  console.log(`authority  : ${deployment.upgradeMultisig.scriptHash} at ${MS_ADDR}`);
  console.log(`signers    : ${signers.map((s) => `${s.label}=${s.pkh.slice(0, 12)}…`).join("  ")}\n`);

  // -------------------------------------------------------------------------
  // Lag-tolerant primitives
  // -------------------------------------------------------------------------

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A fetch that treats a transport failure as "not yet", never as fatal. */
  const tryGet = async (url: string): Promise<any | null> => {
    try {
      const r = await fetch(url, { headers: { project_id: projectId } });
      if (r.status === 404) return null;
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  const awaitTx = async (txHash: string, what: string): Promise<void> => {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const seen = await tryGet(`${BF}/txs/${txHash}`);
      if (seen?.hash) return;
      await sleep(5_000);
    }
    throw new Error(`timed out waiting for ${what} (${txHash}) to be indexed`);
  };

  /** Poll until the chain says what we expect. Not until the tx is confirmed. */
  const waitForState = async <T>(
    read: () => Promise<T | null>,
    what: string,
    timeoutMs = 600_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const got = await read();
        if (got) return got;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await sleep(5_000);
    }
    throw new Error(`timed out waiting for ${what}${lastErr ? ` (last: ${lastErr})` : ""}`);
  };

  /**
   * Wait until the provider's UTxO view STOPS CHANGING.
   *
   * ⛔ MEASURED HERE, 2026-10-01, and it cost the first preview run. Operation 2
   * was built immediately after rotation 2 confirmed, and evaluation was refused
   * with a bare `Blockfrost evaluateTx failed`. The cause is that Blockfrost
   * serves `/txs/{hash}` and `/addresses/{addr}/utxos` from INDEPENDENTLY
   * ADVANCING views: a transaction is confirmed while the UTxO set still shows
   * the outputs it spent. Building against that view puts an already-spent input
   * (or a stale reference input) into the next transaction, and the evaluator
   * refuses it without saying which input or why.
   *
   * ⚠ WAITING FOR THE TRANSACTION IS NOT ENOUGH — that is the view that is
   * already correct. The condition has to be about the view the BUILDER reads.
   * Two consecutive identical fingerprints is the cheapest honest proxy for
   * "it has stopped moving".
   */
  const settleWallet = async (what: string): Promise<void> => {
    const fingerprint = async () => {
      const us = await admin.getUtxos(EvoAddress.fromBech32(adminAddr));
      return us
        .map((u: any) => `${Buffer.from(u.transactionId.hash).toString("hex")}#${u.index}`)
        .sort()
        .join(",");
    };
    const deadline = Date.now() + 300_000;
    let previous = "";
    let stable = 0;
    while (Date.now() < deadline) {
      let now = "";
      try {
        now = await fingerprint();
      } catch {
        await sleep(4_000);
        continue;
      }
      if (now === previous && now.length > 0) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
      previous = now;
      await sleep(4_000);
    }
    throw new Error(`the wallet UTxO view never settled after ${what}`);
  };

  const hashOf = (h: any): string => {
    if (typeof h === "string") return h;
    const raw = h?.hash;
    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("hex");
    return typeof raw === "string" ? raw : String(h);
  };

  const ctx = async () => {
    const wallet = await admin.getUtxos(EvoAddress.fromBech32(adminAddr));
    return {
      client: admin,
      changeAddress: adminAddr,
      availableUtxos: spendableWalletUtxos(wallet, deployment),
    };
  };

  const submitSignedBy = async (
    cbor: string,
    who: ReadonlyArray<{ client: any; pkh: string; label: string }>,
    step: string,
    note?: string,
  ): Promise<string> => {
    const walletUtxos = await admin.getUtxos(EvoAddress.fromBech32(adminAddr));
    const sets: string[] = [];
    for (const s of who) {
      const ws = await s.client.signTx(cbor, { utxos: walletUtxos });
      sets.push(EvoWitnessSet.toCBORHex(ws));
    }
    const signed = assembleMultiSignedTx(cbor, sets);
    assertVKeyWitnessCount(signed, who.length);
    const submitted = await admin.submitTx(EvoTransaction.fromCBORHex(signed));
    const txHash = hashOf(submitted);
    await awaitTx(txHash, step);
    RECORD.push({ n: RECORD.length + 1, step, txHash, note });
    console.log(`  ${String(RECORD.length).padStart(2)}. ✔ ${step}\n      ${txHash}`);
    // ⛔ SETTLE BEFORE THE NEXT BUILD, not merely await the transaction. See
    // settleWallet: a confirmed transaction and an updated UTxO view are two
    // different facts on Blockfrost, and the builder reads the second one.
    await settleWallet(step);
    return txHash;
  };

  const readConfig = async () =>
    locateUpgradeMultisig({
      deployment,
      networkId,
      utxosAtAddress: await admin.getUtxos(EvoAddress.fromBech32(MS_ADDR)),
    });
  const readParams = async () =>
    locateProtocolParams({
      deployment,
      networkId,
      utxosAtAddress: await admin.getUtxos(EvoAddress.fromBech32(PP_ADDR)),
    });

  const sig = (pkh: string) => ({ type: "signature" as const, keyHash: pkh });
  /** Rotation 2's target, needed by rotation 1's skip check before it is used. */
  const ROTATED_PREVIEW = () => ({
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S0!.pkh), sig(S1!.pkh), sig(S3!.pkh)],
  });
  const msCompiled = createStandardScripts(blueprint).upgradeMultisig(
    deployment.upgradeMultisig.txInput,
  ).compiledCode;
  const sittingAuth = async (who: ReadonlyArray<{ pkh: string }>) => ({
    kind: "script" as const,
    scriptHash: deployment.upgradeMultisig.scriptHash,
    compiledCode: msCompiled,
    configUtxo: (await readConfig()).utxo,
    signerKeyHashes: who.map((w) => w.pkh),
  });

  // =========================================================================
  // OPERATION 1 — signer rotation
  // =========================================================================
  console.log("OPERATION 1 — signer rotation\n");

  const atBootstrap = await readConfig();
  console.log(`  tree at bootstrap: ${JSON.stringify(atBootstrap.tree)}`);

  const TWO_OF_THREE = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S0!.pkh), sig(S1!.pkh), sig(S2!.pkh)],
  };
  /**
   * ⚑ SKIP WHAT IS ALREADY DONE, so a campaign interrupted by a provider
   * problem can be resumed rather than restarted.
   *
   * ⛔ This matters more on a public chain than it looks: a restart would need a
   * fresh bootstrap, because the one-shot seeds and the authority tree have both
   * MOVED — the rotations are not idempotent, and re-running one against an
   * already-rotated tree is refused by the preflight (correctly) for a quorum
   * that no longer matches. Resuming is the difference between losing two
   * confirmed transactions and losing a whole instance.
   */
  const sameTree = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  let afterRot1: Awaited<ReturnType<typeof readConfig>>;
  if (sameTree(atBootstrap.tree, TWO_OF_THREE) || sameTree(atBootstrap.tree, ROTATED_PREVIEW())) {
    console.log("   ↷ ROTATION 1 already on chain — skipping (the tree is past it)");
    afterRot1 = atBootstrap;
  } else {
    const rot1 = await buildRotateMultisigTx({
      ...(await ctx()),
      blueprint,
      deployment,
      configUtxo: atBootstrap.utxo,
      newTree: TWO_OF_THREE,
      signerKeyHashes: [S0!.pkh],
    });
    await submitSignedBy(rot1.cbor, [S0!], "ROTATION 1: 1-of-1 -> 2-of-3", "the bootstrap's single key installs a quorum");
    afterRot1 = await waitForState(async () => {
      const c = await readConfig();
      return sameTree(c.tree, TWO_OF_THREE) ? c : null;
    }, "the 2-of-3 tree on chain");
  }

  const ROTATED = ROTATED_PREVIEW();
  let afterRot2: Awaited<ReturnType<typeof readConfig>>;
  if (sameTree(afterRot1.tree, ROTATED)) {
    console.log("   ↷ ROTATION 2 already on chain — skipping");
    afterRot2 = afterRot1;
  } else {
    const rot2 = await buildRotateMultisigTx({
      ...(await ctx()),
      blueprint,
      deployment,
      configUtxo: afterRot1.utxo,
      newTree: ROTATED,
      signerKeyHashes: [S0!.pkh, S1!.pkh],
    });
    await submitSignedBy(rot2.cbor, [S0!, S1!], "ROTATION 2: 2-of-3 -> 2-of-3'", "TWO witnesses; acct2 rotated out, acct3 in");
    afterRot2 = await waitForState(async () => {
      const c = await readConfig();
      return sameTree(c.tree, ROTATED) ? c : null;
    }, "the rotated 2-of-3 tree");
  }
  console.log(`  tree now: ${JSON.stringify(afterRot2.tree)}\n`);

  // =========================================================================
  // OPERATION 2 — break and restore
  // =========================================================================
  console.log("OPERATION 2 — break the params and restore them\n");

  const QUORUM = [S0!, S1!] as const;
  const atGenesis = await readParams();
  const FAKE = { type: "script" as const, hash: "de".repeat(28) };

  const break1 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: atGenesis.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({ ...p, thirdPartyCred: FAKE }),
  });
  await submitSignedBy(break1.cbor, QUORUM, "BREAK 1: thirdPartyCred -> de…de", "a well-formed hash behind which no script exists");

  const broken1 = await waitForState(async () => {
    const p = await readParams();
    return p.params.thirdPartyCred.hash === FAKE.hash ? p : null;
  }, "the fake thirdPartyCred on chain");

  const restore1 = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: broken1.utxo,
    authorisation: await sittingAuth(QUORUM),
    change: (p) => ({ ...p, thirdPartyCred: atGenesis.params.thirdPartyCred }),
  });
  await submitSignedBy(restore1.cbor, QUORUM, "RESTORE 1: thirdPartyCred restored", "authorised by the same authority the break could not touch");

  const restored1 = await waitForState(async () => {
    const p = await readParams();
    return p.params.thirdPartyCred.hash === atGenesis.params.thirdPartyCred.hash ? p : null;
  }, "thirdPartyCred restored");

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
  await submitSignedBy(break4.cbor, QUORUM, "BREAK 4: all four mutable delegates -> fakes", "the protocol now points at four scripts that do not exist");

  const broken4 = await waitForState(async () => {
    const p = await readParams();
    return p.params.plgCred.hash === ALL_FAKE.plgCred.hash ? p : null;
  }, "all four fakes on chain");

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
  await submitSignedBy(restore4.cbor, QUORUM, "RESTORE 4: all four restored", "round trip complete — the datum is identical to genesis");

  const restored4 = await waitForState(async () => {
    const p = await readParams();
    return p.params.plgCred.hash === atGenesis.params.plgCred.hash ? p : null;
  }, "all four restored");
  const roundTripExact =
    JSON.stringify(restored4.params) === JSON.stringify(atGenesis.params);
  console.log(`  round trip byte-exact against genesis: ${roundTripExact}\n`);
  if (!roundTripExact) throw new Error("the restored datum differs from genesis");

  // =========================================================================
  // OPERATION 3 — the authority handover
  // =========================================================================
  console.log("OPERATION 3 — authority handover, four ordered transactions\n");

  const spare = (await ctx()).availableUtxos.find(
    (u: any) => EvoAssets.lovelaceOf(u.assets) > 20_000_000n,
  );
  if (!spare) throw new Error("no spare wallet UTxO for the new authority's one-shot seed");

  const NOMINEE_TREE = {
    type: "at-least" as const,
    required: 2,
    scripts: [sig(S2!.pkh), sig(S3!.pkh)],
  };
  const genesis2 = await buildStandaloneMultisigGenesisTx({
    ...(await ctx()),
    blueprint,
    seedUtxo: spare,
    tree: NOMINEE_TREE,
  });
  const meta = genesis2.metadata as any;
  const nomineeHash: string = meta.scriptHash;
  const nomineeCode: string = meta.compiledCode;
  const nomineeAddr: string = meta.address;
  if (nomineeHash === deployment.upgradeMultisig.scriptHash) {
    throw new Error("the nominee must be a DIFFERENT script, not a rotation");
  }
  await submitSignedBy(genesis2.cbor, [S0!], "HANDOVER a: second upgrade_multisig minted", `${nomineeHash} — a 2-of-2 of acct2+acct3`);

  const nomineeConfig = await waitForState(async () => {
    const utxos = await admin.getUtxos(EvoAddress.fromBech32(nomineeAddr));
    return utxos.length > 0 ? utxos : null;
  }, "the nominee's config UTxO");

  const reg = await buildRegisterCredentialTx({
    ...(await ctx()),
    credentials: [{ scriptHash: nomineeHash, compiledCode: nomineeCode }],
  });
  await submitSignedBy(reg.cbor, [S0!], "HANDOVER b: the nominee's stake credential registered", "its OWN transaction — withdrawals apply before certificates");

  const beforeNomination = await readParams();
  const nominate = await buildNominateAuthorityTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: beforeNomination.utxo,
    authorisation: await sittingAuth(QUORUM),
    nominee: { type: "script", hash: nomineeHash },
  });
  await submitSignedBy(nominate.cbor, QUORUM, "HANDOVER c: NominateAuthority", "the sitting authority names its successor; upgradeCred unmoved");

  const nominated = await waitForState(async () => {
    const p = await readParams();
    return p.params.pendingUpgradeCred?.hash === nomineeHash ? p : null;
  }, "the nomination on chain");

  const nomineeAuth = {
    kind: "script" as const,
    scriptHash: nomineeHash,
    compiledCode: nomineeCode,
    configUtxo: nomineeConfig[0],
    signerKeyHashes: [S2!.pkh, S3!.pkh],
  };
  const promote = await buildPromoteAuthorityTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: nominated.utxo,
    authorisation: nomineeAuth,
  });
  const withdrew = (promote.metadata as any).withdrewFrom;
  if (JSON.stringify(withdrew) !== JSON.stringify([{ type: "script", hash: nomineeHash }])) {
    throw new Error(`the promotion must withdraw ONLY the nominee; got ${JSON.stringify(withdrew)}`);
  }
  // The fee payer signs because it OWNS THE INPUTS — a separate requirement
  // from the authority quorum. Measured on devnet as ledger code 3101.
  await submitSignedBy(promote.cbor, [S0!, S2!, S3!], "HANDOVER d: PromoteAuthority", "withdraws ONLY the nominee; acct0 signs as fee payer, not as authority");

  const promoted = await waitForState(async () => {
    const p = await readParams();
    return p.params.upgradeCred.hash === nomineeHash ? p : null;
  }, "the promotion on chain");
  if (promoted.params.pendingUpgradeCred !== null) throw new Error("the nomination was not cleared");

  const afterHandover = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: promoted.utxo,
    authorisation: nomineeAuth,
    change: (p) => ({ ...p, thirdPartyCred: FAKE }),
  });
  await submitSignedBy(afterHandover.cbor, [S0!, S2!, S3!], "HANDOVER e: the NEW authority performs an upgrade", "proves the credential is live, registered and satisfied by its own tree");

  await waitForState(async () => {
    const p = await readParams();
    return p.params.thirdPartyCred.hash === FAKE.hash ? p : null;
  }, "an upgrade authorised by the new authority");

  // --- And put it back, so the instance is left working --------------------
  const finalRestore = await buildProtocolUpgradeTx({
    ...(await ctx()),
    blueprint,
    deployment,
    paramsUtxo: (await readParams()).utxo,
    authorisation: nomineeAuth,
    change: (p) => ({ ...p, thirdPartyCred: atGenesis.params.thirdPartyCred }),
  });
  await submitSignedBy(finalRestore.cbor, [S0!, S2!, S3!], "HANDOVER f: restored, under the new authority", "the instance is left in a working state");

  const final = await waitForState(async () => {
    const p = await readParams();
    return p.params.thirdPartyCred.hash === atGenesis.params.thirdPartyCred.hash ? p : null;
  }, "the final restore");

  // -------------------------------------------------------------------------
  // The record
  // -------------------------------------------------------------------------
  const out = {
    network: "preview",
    instance: instanceName,
    protocolTxHash: deployment.txHash,
    protocolParamsAddress: PP_ADDR,
    protocolParamsPolicyId: deployment.protocolParams.policyId,
    upgradeMultisigAtBootstrap: deployment.upgradeMultisig.scriptHash,
    upgradeMultisigAddress: MS_ADDR,
    nomineeAuthority: { scriptHash: nomineeHash, address: nomineeAddr, tree: NOMINEE_TREE },
    signers: signers.map((s) => ({ label: s.label, paymentKeyHash: s.pkh })),
    treeAtBootstrap: atBootstrap.tree,
    treeAfterRotation1: TWO_OF_THREE,
    treeAfterRotation2: ROTATED,
    paramsAtGenesis: atGenesis.params,
    paramsFinal: final.params,
    roundTripByteExact: roundTripExact,
    authorityAtEnd: final.params.upgradeCred,
    transactions: RECORD,
  };
  const path = new URL("../../deployments/preview/upgrade-lifecycle-record.json", import.meta.url)
    .pathname;
  writeFileSync(path, JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? `${v}` : v), 2) + "\n");

  console.log(`\n=== CAMPAIGN COMPLETE — ${RECORD.length} transactions ===`);
  for (const r of RECORD) console.log(`${String(r.n).padStart(2)}. ${r.txHash}  ${r.step}`);
  console.log(`\nrecord written: ${path}`);
  console.log(`authority at end: ${final.params.upgradeCred.type}(${final.params.upgradeCred.hash})`);
}

main().catch((e) => {
  console.error("\nFAILED:", e?.message ?? e);
  if (RECORD.length > 0) {
    console.error("\nTransactions that DID land before the failure:");
    for (const r of RECORD) console.error(`${String(r.n).padStart(2)}. ${r.txHash}  ${r.step}`);
  }
  process.exit(1);
});
