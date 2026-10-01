/**
 * The three `protocol_params` spend arms — and the generalisation that makes a
 * multisig → multisig authority handover possible at all.
 *
 * ⛔ WHY THAT HANDOVER HAD NEVER BEEN EXECUTED, in one sentence from the code
 * that could not do it: the harness's authorisation router throws unless a
 * script authority IS this deployment's `upgradeMultisig`, because it
 * reconstructs the body and config UTxO from `DeploymentParams`. A nominee has a
 * different hash, a different seed and a different config UTxO — exactly the
 * case that guard rejects by name. So the only handover ever run on any chain
 * was multisig → KEY. `FOREIGN AUTHORITY` below is the test that unblocks it.
 *
 * ⛔ THE ASYMMETRY THAT MAKES THE ARMS NOT INTERCHANGEABLE. Two arms call
 * `sitting_authority_approves(old, withdrawals)`. `promote_authority` does NOT:
 * it reads `has_key(withdrawals, nominee)` and the sitting authority appears
 * nowhere in it. Getting that backwards is SILENT on the build side — the
 * validator does not refuse an extra withdrawal for being extra, it simply does
 * not read it, so the transaction is refused for MISSING the one the rule names
 * and the error names a script rather than the mistake.
 *
 * ⚑ AND THE LOVELACE FLOOR, which a passing suite once failed to defend.
 * `pendingUpgradeCred` is the only field of this datum whose serialised size
 * changes — `None` is 3 bytes of CBOR, `Some(Credential)` about 40 — so a
 * NOMINATION widens the continuing output past the floor the genesis funded.
 * Audit r1 M11 replaced the floor with `0n` and the suite stayed green; the
 * measured consequence was a promotion draining 150,850 lovelace per promotion
 * out of the protocol UTxO into change, legally, because the chain leaves
 * lovelace unconstrained. The pair `NOMINATION RAISES` / `PROMOTION DOES NOT
 * LOWER` is what reddens it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildNominateAuthorityTx,
  buildPromoteAuthorityTx,
  buildProtocolUpgradeTx,
  protocolParamsDatum,
  EvoAssets,
  EvoData,
} from "../dist/index.js";
import { createStandardScripts } from "../dist/standard/scripts.js";

import { h, utxo } from "./support/fes-rig.mjs";

const NETWORK_ID = 0;
const BP = JSON.parse(
  readFileSync(new URL("../blueprints/standard/v0.0.1/plutus.json", import.meta.url), "utf8"),
);

const PP_SEED = { txHash: "c3".repeat(32), outputIndex: 1 };
const MS_SEED = { txHash: "a1".repeat(32), outputIndex: 3 };
const SCRIPTS = createStandardScripts(BP);
const PP_SCRIPT = SCRIPTS.protocolParams(PP_SEED);
const MS_SCRIPT = SCRIPTS.upgradeMultisig(MS_SEED);

/** A SECOND multisig instance — the nominee. The deployment knows nothing of it. */
const NOMINEE_SEED = { txHash: "d4".repeat(32), outputIndex: 0 };
const NOMINEE_SCRIPT = SCRIPTS.upgradeMultisig(NOMINEE_SEED);

const DEPLOYMENT = {
  protocolParams: { policyId: PP_SCRIPT.hash, txInput: PP_SEED },
  upgradeMultisig: { scriptHash: MS_SCRIPT.hash, txInput: MS_SEED },
};

const { protocolParamsAddress, upgradeMultisigAddress } = await import("../dist/index.js");
const PP_ADDR = protocolParamsAddress(NETWORK_ID, DEPLOYMENT);
const MS_ADDR = upgradeMultisigAddress(NETWORK_ID, DEPLOYMENT);
const PP_NFT = PP_SCRIPT.hash + Buffer.from("ProtocolParams", "utf-8").toString("hex");
const MS_NFT = MS_SCRIPT.hash + Buffer.from("UpgradeMultisig", "utf-8").toString("hex");
const NOMINEE_NFT = NOMINEE_SCRIPT.hash + Buffer.from("UpgradeMultisig", "utf-8").toString("hex");

const script = (hash) => ({ type: "script", hash });
const key = (hash) => ({ type: "key", hash });
const SIGNER = h("a1");

/** The live wiring. Four mutable delegates plus the two authority fields. */
const LIVE = {
  plgCred: script(h("01")),
  issuanceLogicCred: script(h("02")),
  transferCred: script(h("03")),
  thirdPartyCred: script(h("04")),
  upgradeCred: script(MS_SCRIPT.hash),
  pendingUpgradeCred: null,
};

/** Recognisable-on-sight fakes: well-formed 28-byte hashes behind which no script exists. */
const FAKE = {
  plgCred: script("de".repeat(28)),
  issuanceLogicCred: script("ad".repeat(28)),
  transferCred: script("be".repeat(28)),
  thirdPartyCred: script("ef".repeat(28)),
};

const paramsUtxo = (params = LIVE, lovelace = 2_000_000n) =>
  utxo({
    address: PP_ADDR,
    lovelace,
    units: { [PP_NFT]: 1n },
    datum: protocolParamsDatum(params),
  });

const msConfigUtxo = () => utxo({ address: MS_ADDR, units: { [MS_NFT]: 1n }, lovelace: 3_000_000n });
const nomineeConfigUtxo = () =>
  utxo({ address: MS_ADDR, units: { [NOMINEE_NFT]: 1n }, lovelace: 3_000_000n });

/** The sitting authority: this deployment's multisig. */
const SITTING = {
  kind: "script",
  scriptHash: MS_SCRIPT.hash,
  compiledCode: MS_SCRIPT.compiledCode,
  configUtxo: msConfigUtxo(),
  signerKeyHashes: [SIGNER],
};
/** The nominee authority: a second multisig, foreign to the deployment. */
const NOMINEE_AUTH = {
  kind: "script",
  scriptHash: NOMINEE_SCRIPT.hash,
  compiledCode: NOMINEE_SCRIPT.compiledCode,
  configUtxo: nomineeConfigUtxo(),
  signerKeyHashes: [h("b9")],
};

class RecorderStop extends Error {}

function makeClient() {
  const ops = [];
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return (arg) => {
          if (prop === "build") throw new RecorderStop("recorder: build reached");
          ops.push({ op: String(prop), arg });
          return builder;
        };
      },
    },
  );
  return {
    ops,
    client: {
      chain: { id: NETWORK_ID },
      newTx: () => builder,
      async getProtocolParameters() {
        return { coinsPerUtxoByte: 4310n };
      },
    },
  };
}

async function drive(build, overrides = {}) {
  const { ops, client } = makeClient();
  const params = {
    client,
    changeAddress: PP_ADDR,
    availableUtxos: [utxo({ address: PP_ADDR, lovelace: 50_000_000n })],
    blueprint: BP,
    deployment: DEPLOYMENT,
    paramsUtxo: paramsUtxo(),
    authorisation: SITTING,
    ...overrides,
  };
  let error;
  try {
    await build(params);
  } catch (e) {
    error = e;
  }
  return { ops, error };
}

const reached = (r) => r.error instanceof RecorderStop;
const refusedWith = (r, re, why) => {
  assert.ok(r.error instanceof Error, `${why}: must be refused`);
  assert.ok(!(r.error instanceof RecorderStop), `${why}: it BUILT instead of refusing`);
  assert.match(r.error.message, re, why);
};
const datumOf = (r) => {
  const pay = r.ops.find((o) => o.op === "payToAddress");
  return pay.arg.datum.data ?? pay.arg.datum;
};
const cborOf = (d) => Buffer.from(EvoData.toCBORBytes(d)).toString("hex");
const withdrawalsOf = (r) => r.ops.filter((o) => o.op === "withdraw");
const redeemerOf = (r) => cborOf(r.ops.find((o) => o.op === "collectFrom").arg.redeemer);

// ---------------------------------------------------------------------------
// Operation 2 — break and restore
// ---------------------------------------------------------------------------

test("PROTOCOL_UPGRADE: rewrites all four mutable delegates and declares arm 0", async () => {
  const r = await drive(buildProtocolUpgradeTx, { change: (p) => ({ ...p, ...FAKE }) });
  assert.ok(reached(r), `the break must build; got: ${r.error?.message}`);
  assert.equal(redeemerOf(r), cborOf(EvoData.constr(0n, [])), "arm 0 — Constr(0, [])");
  assert.equal(
    cborOf(datumOf(r)),
    cborOf(protocolParamsDatum({ ...LIVE, ...FAKE })),
    "the continuing datum carries the fakes",
  );
  assert.equal(withdrawalsOf(r).length, 1, "exactly one withdrawal");
});

test("PROTOCOL_UPGRADE: the RESTORE is a mirror of the break and needs nothing the break removed", async () => {
  // ⛔ THE CENTRAL SAFETY PROPERTY OF OPERATION 2. The revert is authorised by
  // `upgradeCred`, which this arm FREEZES, and no delegate credential appears
  // anywhere in the spend, withdrawal, address or fee path. So a protocol
  // pointing at four non-existent scripts can still be repaired by the same
  // authority that broke it.
  const broken = paramsUtxo({ ...LIVE, ...FAKE });
  const r = await drive(buildProtocolUpgradeTx, {
    paramsUtxo: broken,
    change: (p) => ({
      ...p,
      plgCred: LIVE.plgCred,
      issuanceLogicCred: LIVE.issuanceLogicCred,
      transferCred: LIVE.transferCred,
      thirdPartyCred: LIVE.thirdPartyCred,
    }),
  });
  assert.ok(reached(r), `the restore must build from a BROKEN datum; got: ${r.error?.message}`);
  assert.equal(cborOf(datumOf(r)), cborOf(protocolParamsDatum(LIVE)), "back to the original wiring");
});

test("REFUSED: PROTOCOL_UPGRADE may not move upgradeCred — the arm freezes it", async () => {
  const r = await drive(buildProtocolUpgradeTx, {
    change: (p) => ({ ...p, upgradeCred: script(NOMINEE_SCRIPT.hash) }),
  });
  refusedWith(r, /FREEZES upgradeCred/, "a handover cannot ride inside a parameter change");
  assert.match(r.error.message, /buildNominateAuthorityTx then buildPromoteAuthorityTx/, "names the real path");
});

test("REFUSED: PROTOCOL_UPGRADE may not move pendingUpgradeCred either", async () => {
  const r = await drive(buildProtocolUpgradeTx, {
    change: (p) => ({ ...p, pendingUpgradeCred: key(h("99")) }),
  });
  refusedWith(r, /FREEZES pendingUpgradeCred/, "a nomination cannot ride inside an upgrade");
});

// ---------------------------------------------------------------------------
// Operation 3 — the two phases
// ---------------------------------------------------------------------------

test("NOMINATE_AUTHORITY: writes the nomination, declares arm 1, freezes everything else", async () => {
  const r = await drive(buildNominateAuthorityTx, { nominee: script(NOMINEE_SCRIPT.hash) });
  assert.ok(reached(r), `the nomination must build; got: ${r.error?.message}`);
  assert.equal(redeemerOf(r), cborOf(EvoData.constr(1n, [])), "arm 1 — which voidData() cannot represent");
  assert.equal(
    cborOf(datumOf(r)),
    cborOf(protocolParamsDatum({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) })),
    "only pendingUpgradeCred moved",
  );
  const w = withdrawalsOf(r);
  assert.equal(w.length, 1, "the SITTING authority, once");
});

test("NOMINATE_AUTHORITY: null withdraws a standing nomination", async () => {
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  const r = await drive(buildNominateAuthorityTx, { paramsUtxo: nominated, nominee: null });
  assert.ok(reached(r), `withdrawing a nomination must build; got: ${r.error?.message}`);
  assert.equal(cborOf(datumOf(r)), cborOf(protocolParamsDatum(LIVE)), "back to None — a nomination is reversible");
});

test("PROMOTE_AUTHORITY: moves upgradeCred, clears the nomination, declares arm 2", async () => {
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  const r = await drive(buildPromoteAuthorityTx, {
    paramsUtxo: nominated,
    authorisation: NOMINEE_AUTH,
  });
  assert.ok(reached(r), `the promotion must build; got: ${r.error?.message}`);
  assert.equal(redeemerOf(r), cborOf(EvoData.constr(2n, [])), "arm 2");
  assert.equal(
    cborOf(datumOf(r)),
    cborOf(protocolParamsDatum({ ...LIVE, upgradeCred: script(NOMINEE_SCRIPT.hash), pendingUpgradeCred: null })),
    "the nominee is now the authority and the nomination is cleared",
  );
});

test("FOREIGN AUTHORITY: the promotion is authorised by a multisig the DEPLOYMENT NEVER NAMES", async () => {
  // ⛔ THIS IS THE UNBLOCK. The deployment records `upgradeMultisig` = the
  // sitting authority; the nominee is a second instance with its own seed, hash,
  // body and config UTxO. The harness refuses exactly this, which is why no
  // multisig → multisig handover has ever been run on any chain.
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  const r = await drive(buildPromoteAuthorityTx, {
    paramsUtxo: nominated,
    authorisation: NOMINEE_AUTH,
  });
  assert.ok(reached(r), "a foreign script authority must be accepted");

  assert.notEqual(NOMINEE_SCRIPT.hash, MS_SCRIPT.hash, "the two authorities are genuinely different scripts");
  const refs = r.ops.filter((o) => o.op === "readFrom");
  assert.equal(refs.length, 1, "the NOMINEE's config UTxO is the reference input");
  const refUnits = EvoAssets.getUnits(refs[0].arg.referenceInputs[0].assets);
  assert.ok(refUnits.includes(NOMINEE_NFT), "and it carries the NOMINEE's NFT, not the sitting authority's");
  assert.ok(!refUnits.includes(MS_NFT), "the sitting authority's config is NOT referenced");
});

test("EXCLUSIVITY: the promotion withdraws ONLY the nominee — the sitting authority is absent", async () => {
  // ⚠ UNENFORCEABLE ON CHAIN. Upstream's rail is `has_key(withdrawals, nominee)`,
  // an EXISTENCE check, so a promotion carrying BOTH withdrawals is ACCEPTED.
  // No on-chain negative can cover this; the guard is that there is exactly one
  // `withdraw` call and this assertion reads it off the built transaction.
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  const r = await drive(buildPromoteAuthorityTx, { paramsUtxo: nominated, authorisation: NOMINEE_AUTH });
  const w = withdrawalsOf(r);
  assert.equal(w.length, 1, "exactly one withdrawal, and it is the nominee's");
  const attached = r.ops.filter((o) => o.op === "attachScript");
  assert.equal(attached.length, 2, "two script witnesses: protocol_params (spend) and the nominee (withdraw)");
});

test("REFUSED: a promotion with NO standing nomination", async () => {
  const r = await drive(buildPromoteAuthorityTx, { authorisation: NOMINEE_AUTH });
  refusedWith(r, /NO STANDING NOMINATION/, "there is nothing to promote");
  assert.match(r.error.message, /expect Some\(nominee\)/, "quotes the rail that would fail");
  assert.match(r.error.message, /buildNominateAuthorityTx/, "and names the prerequisite");
});

test("REFUSED: a promotion authorised by the SITTING authority instead of the nominee", async () => {
  // The asymmetry, caught offline. On chain this is refused for MISSING the
  // nominee's withdrawal, which names a script and not the mistake.
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  const r = await drive(buildPromoteAuthorityTx, { paramsUtxo: nominated, authorisation: SITTING });
  refusedWith(r, /STANDING NOMINEE/, "the sitting authority cannot promote its own successor");
  assert.match(r.error.message, /SILENT ON THE BUILD SIDE/, "and explains why the chain's answer misleads");
});

test("REFUSED: an upgrade or nomination authorised by the wrong credential", async () => {
  refusedWith(
    await drive(buildProtocolUpgradeTx, { change: (p) => p, authorisation: NOMINEE_AUTH }),
    /SITTING authority/,
    "arm 0 wants the sitting authority",
  );
  refusedWith(
    await drive(buildNominateAuthorityTx, { nominee: key(h("99")), authorisation: NOMINEE_AUTH }),
    /SITTING authority/,
    "arm 1 wants the sitting authority",
  );
});

// ---------------------------------------------------------------------------
// The one-way brick
// ---------------------------------------------------------------------------

test("REFUSED: a credential that is not 28 bytes — the one-way brick, refused before a fee", async () => {
  for (const field of ["upgradeCred", "plgCred", "transferCred"]) {
    const change =
      field === "upgradeCred"
        ? null // frozen by this arm; covered by its own test
        : (p) => ({ ...p, [field]: script("ab") });
    if (!change) continue;
    const r = await drive(buildProtocolUpgradeTx, { change });
    refusedWith(r, /ONE-WAY BRICK/, `${field} must be a 28-byte hash`);
    assert.match(r.error.message, /no repair path at any timescale/, "and the message says why it is terminal");
  }
  // And via a nomination, which is the field that CAN move an authority.
  const r = await drive(buildNominateAuthorityTx, { nominee: script("abcd") });
  refusedWith(r, /ONE-WAY BRICK/, "a malformed nominee would be unpromotable AND unclearable by it");
});

// ---------------------------------------------------------------------------
// The lovelace floor — the pair that reddens audit r1 M11
// ---------------------------------------------------------------------------

test("NOMINATION RAISES the continuing output's lovelace, because the datum grew", async () => {
  const IN = 2_000_000n;
  const r = await drive(buildNominateAuthorityTx, {
    paramsUtxo: paramsUtxo(LIVE, IN),
    nominee: script(NOMINEE_SCRIPT.hash),
  });
  const out = EvoAssets.lovelaceOf(r.ops.find((o) => o.op === "payToAddress").arg.assets);
  assert.ok(
    out > IN,
    `a nomination widens the datum from None (3 bytes) to Some(Credential) (~40), so min-UTxO ` +
      `rises above the input's ${IN}; got ${out}. Measured on devnet as ledger code 3125 before ` +
      `the re-flooring existed.`,
  );
});

test("PROMOTION DOES NOT LOWER it, though the datum shrinks back to None", async () => {
  // ⛔ THE M11 MUTANT. Replacing the floor with `0n` leaves every other test
  // green and drains 150,850 lovelace per promotion out of the protocol UTxO
  // into change — legally, because the chain leaves lovelace unconstrained
  // relative to the input. This is the only assertion that sees it.
  const IN = 2_012_770n;
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) }, IN);
  const r = await drive(buildPromoteAuthorityTx, { paramsUtxo: nominated, authorisation: NOMINEE_AUTH });
  const out = EvoAssets.lovelaceOf(r.ops.find((o) => o.op === "payToAddress").arg.assets);
  assert.equal(out, IN, "the floor is the input's own lovelace, so a shrinking datum never claws ADA back");
});

test("RAIL: non-ADA value is carried through every arm untouched", async () => {
  const r = await drive(buildProtocolUpgradeTx, { change: (p) => ({ ...p, ...FAKE }) });
  const out = r.ops.find((o) => o.op === "payToAddress").arg.assets;
  assert.equal(EvoAssets.getByUnit(out, PP_NFT), 1n, "the params NFT continues");
});

// ---------------------------------------------------------------------------
// Script-authorisation completeness
// ---------------------------------------------------------------------------

test("REFUSED: a script authorisation without its configUtxo or body", async () => {
  refusedWith(
    await drive(buildProtocolUpgradeTx, {
      change: (p) => p,
      authorisation: { ...SITTING, configUtxo: undefined },
    }),
    /requires configUtxo/,
    "the withdraw handler finds its tree among the reference inputs",
  );
  refusedWith(
    await drive(buildProtocolUpgradeTx, {
      change: (p) => p,
      authorisation: { ...SITTING, compiledCode: "" },
    }),
    /requires compiledCode/,
    "a script-witnessed withdrawal needs the body",
  );
});

test("REFUSED: a params UTxO that does not carry the params NFT", async () => {
  const foreign = utxo({ address: PP_ADDR, units: { [MS_NFT]: 1n }, datum: protocolParamsDatum(LIVE) });
  refusedWith(
    await drive(buildProtocolUpgradeTx, { change: (p) => p, paramsUtxo: foreign }),
    /carries no asset of policy/,
    "the wrong UTxO upgrades nothing",
  );
});

test("REFUSED: a nomination that already reads the same on chain", async () => {
  const nominated = paramsUtxo({ ...LIVE, pendingUpgradeCred: script(NOMINEE_SCRIPT.hash) });
  refusedWith(
    await drive(buildNominateAuthorityTx, {
      paramsUtxo: nominated,
      nominee: script(NOMINEE_SCRIPT.hash),
    }),
    /already reads/,
    "a no-op nomination pays a fee and changes nothing",
  );
});
