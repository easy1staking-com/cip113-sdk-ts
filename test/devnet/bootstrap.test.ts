/**
 * Protocol bootstrap on a live devnet — CIP-113 0.5.0-alpha.4.
 *
 * ⚠ THIS IS A FIRST-EVER EXECUTION, NOT A REGRESSION TEST. No alpha.4 bootstrap
 * has ever run. A green here is a SINGLE OBSERVATION with nothing behind it —
 * it does not inherit the alpha.3 greens and "restored parity" is the wrong way
 * to read it. The qualifier belongs here, inside the acceptance, rather than in
 * a footnote of whatever report cites this file.
 *
 * This file previously asserted a BLOCKER: the bundled 0.3.0 blueprint had no
 * `publish` handler on programmable_logic_global, so registering its stake
 * credential died at evaluation with an empty trace list. That test was written
 * to FAIL the moment a publish-capable blueprint landed, and it has now been
 * deleted as designed.
 *
 * Worth recording WHY it is gone, because it is not why anyone expected: PLG was
 * not given a publish handler. PLG was DISSOLVED (upstream #110). Its three
 * successors — transfer, third_party, unfracking — each carry one, and the
 * bootstrap registers all three.
 *
 * This is the first point in workstream W-D where anything becomes OBSERVED
 * rather than DERIVED. Everything up to here is a builder producing bytes; only
 * a transaction the devnet accepted proves the bytes were right.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  assertDeploymentScripts,
  DeploymentMismatchError,
  decodeProtocolParams,
  decodeRegistryNode,
  scriptAddress,
  stringToHex,
  getInlineDatum,
  decodeMultisigScript,
  paymentCredentialHash,
} from "../../dist/index.js";
import {
  Address as EvoAddress,
  Assets as EvoAssets,
  ScriptHash as EvoScriptHash,
  TransactionHash as EvoTransactionHash,
  TransactionInput as EvoTransactionInput,
} from "@evolution-sdk/evolution";
import { requireDevnet, makeClient } from "../harness/yaci.mjs";
import { bootstrapProtocol, loadStandardBlueprint } from "../harness/bootstrap.js";
import { createStandardScripts } from "../../dist/standard/scripts.js";

before(async () => {
  await requireDevnet();
});

test("bootstraps a protocol instance on a live devnet", async () => {
  const deployment = await bootstrapProtocol();

  assert.match(deployment.txHash, /^[0-9a-f]{64}$/, "tx hash should be 32 bytes of hex");

  for (const [name, hash] of [
    ["protocolParams.policyId", deployment.protocolParams.policyId],
    ["programmableLogicGlobal.scriptHash", deployment.programmableLogicGlobal.scriptHash],
    ["programmableLogicBase.scriptHash", deployment.programmableLogicBase.scriptHash],
    ["transfer.scriptHash", deployment.transfer.scriptHash],
    ["thirdParty.scriptHash", deployment.thirdParty.scriptHash],
    ["unfracking.scriptHash", deployment.unfracking.scriptHash],
    ["upgradeMultisig.scriptHash", deployment.upgradeMultisig.scriptHash],
    ["upgradeAuthority.hash", deployment.upgradeAuthority.hash],
    ["issuanceLogic.scriptHash", deployment.issuanceLogic.scriptHash],
    ["issuance.policyId", deployment.issuance.policyId],
    ["registry.scriptHash", deployment.registry.scriptHash],
  ] as const) {
    assert.match(hash, /^[0-9a-f]{56}$/, `${name} should be a 28-byte script hash`);
  }

  // The three delegates MUST be distinct. programmable_logic_base dispatches to
  // them by credential and the arm is meaningful only while they are pairwise
  // different — upstream does NOT enforce that on chain, calling it a
  // deployment responsibility. This is that responsibility.
  const delegates = [
    deployment.transfer.scriptHash,
    deployment.thirdParty.scriptHash,
    deployment.unfracking.scriptHash,
  ];
  assert.equal(new Set(delegates).size, 3, "transfer / third_party / unfracking must be distinct");

  // The params NFT is locked at protocol_params own address, never always_fail.
  assert.notEqual(
    deployment.protocolParams.policyId,
    deployment.issuance.alwaysFailScriptHash,
    "the params NFT lives at protocol_params; always_fail now guards only issuance"
  );

  // The dispatcher must be distinct from every delegate it names.
  assert.ok(
    !delegates.includes(deployment.programmableLogicGlobal.scriptHash),
    "the dispatcher must not collide with a delegate"
  );

  // ⛔ THREE DISTINCT ONE-SHOT SEEDS, PAIRWISE. Two reasons, and the second is
  // the one that grew teeth in alpha.4:
  //
  //  1. Colliding seeds mean colliding parameterised policies, so the protocol
  //     could be re-bootstrapped over itself.
  //  2. `DeploymentParams` now carries TWO same-typed one-shot outrefs —
  //     `protocolParams.txInput` and `upgradeMultisig.txInput` — and
  //     `assertDeploymentScripts` derives a script hash from each. Two same-typed
  //     outrefs in one record are TWO CHANCES FOR A VACUOUS CHECK: give them one
  //     value and the `upgrade_multisig` derivation reproduces whichever field
  //     the code actually reads, so the check cannot fail and a genuine
  //     wrong-field bug is invisible. That is precisely how the alpha.3
  //     `upgrade_multisig` check stayed green for an entire migration.
  const seeds = [
    ["protocolParams", deployment.protocolParams.txInput],
    ["issuance", deployment.issuance.txInput],
    ["upgradeMultisig", deployment.upgradeMultisig.txInput],
  ] as const;
  const seedKeys = seeds.map(([, r]) => `${r.txHash}#${r.outputIndex}`);
  assert.equal(
    new Set(seedKeys).size,
    3,
    `protocolParams, issuance and upgradeMultisig must each consume a DIFFERENT seed UTxO; ` +
      `got ${seeds.map(([n], i) => `${n}=${seedKeys[i]}`).join(", ")}`
  );

  // Persist and reload so blueprint and deployment are independent artifacts —
  // the only situation in which this assertion can actually fail. Asserting
  // inside the bootstrap, against values it just derived, is a tautology.
  const reloaded = JSON.parse(JSON.stringify(deployment));
  const blueprint = loadStandardBlueprint();
  const checks = assertDeploymentScripts(blueprint, reloaded);
  // TEN in alpha.4, up from eight — `issuance_logic` and `upgrade_multisig`
  // both became derivable.
  //
  // ⚑ KEEP THE HISTORY, because it is the reason this pin exists. In alpha.3
  // `upgrade_multisig` was NOT derivable and the count was deliberately
  // shrunk to eight: S-4 had derived it as
  //     upgradeMultisig([upgradeAuthority.hash], 1)
  // — a PAYMENT-vs-STAKE relationship THAT DOES NOT EXIST — and the check
  // passed anyway, for an entire migration, because the offline fixture used
  // ONE VALUE FOR BOTH FIELDS and so the wrong derivation reproduced exactly.
  // A fixture that conflates two values cannot test whether the code conflates
  // them; only a real deployment, where they genuinely differ, exposed it. The
  // signer set was a deployment choice `DeploymentParams` did not record, so
  // the check was removed rather than corrected.
  //
  // alpha.4 restores it on a sound basis rather than by relaxing anything:
  // `upgrade_multisig` is now parameterised by a RECORDABLE one-shot `utxo_ref`
  // and holds its signer tree in a config UTxO, so the derivation reads a field
  // that genuinely determines the hash. See the three-distinct-seeds assertion
  // above, which is what stops the new derivation going vacuous the same way.
  //
  // The count stays PINNED and the pin stays a pin: a silent SHRINK is what it
  // catches, and it caught that one.
  assert.equal(checks.length, 10, "all ten derivable scripts must be checked");
  for (const c of checks) assert.equal(c.derived, c.deployed, `${c.name} must reproduce`);

  // And prove that is not vacuous: substitute a DIFFERENT validator's program
  // and the same deployment must be rejected.
  //
  // NOT a trailing-byte flip. UPLC is flat-encoded and padded to a byte
  // boundary, so the last byte is frequently padding that decode -> apply ->
  // re-encode regenerates; measured on this artifact, flipping it leaves the
  // parameterised hash bit-identical and this assertion passes by throwing
  // nothing. That is what the earlier version of this file did.
  const changed = structuredClone(blueprint);
  const victim = changed.validators.find(
    // registry_spend no longer exists in alpha.3 (merged into `registry`), so
    // the victim moved with it. The mechanism under test — a blueprint swapped
    // under an unchanged deployment — is unchanged.
    (x: { title: string }) => x.title === "registry.registry.mint"
  );
  const donor = changed.validators.find(
    (x: { title: string }) => x.title === "unfracking.unfracking.withdraw"
  );
  assert.ok(victim && donor && victim.compiledCode !== donor.compiledCode);
  victim.compiledCode = donor.compiledCode;
  assert.throws(
    () => assertDeploymentScripts(changed, deployment),
    (err: unknown) => err instanceof DeploymentMismatchError,
    "a deployment paired with a different blueprint must be rejected"
  );
});

test("the deployed protocol state is what the bootstrap intended — read back from chain", async () => {
  // A transaction the node accepted is a RECEIPT. It proves the bytes were
  // well-formed, not that the protocol is wired correctly. This reads the state
  // back out of the chain through an independent query and checks the wiring.
  const deployment = await bootstrapProtocol();
  const client = await makeClient();
  const networkId = client.chain.id;

  // --- the params NFT must be at coordination_spend, NOT always_fail --------
  const paramsUnit = deployment.protocolParams.policyId + stringToHex("ProtocolParams");
  const coordAddr = scriptAddress(networkId, deployment.protocolParams.policyId);
  const coordUtxos = await client.getUtxosWithUnit(EvoAddress.fromBech32(coordAddr), paramsUnit);

  assert.equal(
    coordUtxos.length,
    1,
    "exactly one coordination UTxO must hold the params NFT — the NFT is one-shot, " +
      "and finding zero means it was locked somewhere else (the always_fail address is " +
      "where the 0.3.x fixture put it, and that mistake is invisible to every offline check)"
  );

  // --- its datum must be the SIX-field layout, wired to the real delegates ---
  const datum = getInlineDatum(coordUtxos[0]);
  assert.ok(datum, "the coordination UTxO must carry an inline datum");
  const params = decodeProtocolParams(datum);

  // ⛔ READ BACK BY NAME, FIELD BY FIELD, AND MIND INDICES 1 AND 2.
  //
  // alpha.4 INSERTED `issuance_logic_cred` at index 1, displacing
  // `transfer_cred` to index 2. Both are `Credential` — same constructor, same
  // 28 bytes — so a datum written in alpha.3's order is still six fields long,
  // still passes `params_wellformed`, and still DECODES CLEANLY. A shifted read
  // returns a perfectly well-formed value that names the WRONG AUTHORITY, and
  // no decoder anywhere can catch it: there is nothing malformed to catch.
  // Only comparing each field to the script it is supposed to name does.
  assert.equal(params.plgCred.hash, deployment.programmableLogicGlobal.scriptHash, "field 0 = plg_cred");
  assert.equal(
    params.issuanceLogicCred.hash,
    deployment.issuanceLogic.scriptHash,
    "field 1 = issuance_logic_cred — NEW in alpha.4, and it displaced transfer_cred from this slot"
  );
  assert.equal(
    params.transferCred.hash,
    deployment.transfer.scriptHash,
    "field 2 = transfer_cred — was field 1 in alpha.3"
  );
  assert.equal(params.thirdPartyCred.hash, deployment.thirdParty.scriptHash, "field 3 = third_party");
  assert.equal(params.upgradeCred.hash, deployment.upgradeAuthority.hash, "field 4 = upgrade_cred");
  assert.equal(params.upgradeCred.type, deployment.upgradeAuthority.type, "upgrade_cred kind");
  // ⛔ `pending_upgrade_cred` MUST be None at genesis. protocol_params runs
  // `params_wellformed(genesis_params, is_init: True)`, and `is_init: True` is
  // precisely what forbids a nomination baked into the genesis datum. A handover
  // is two-phase; phase one has not happened.
  assert.equal(
    params.pendingUpgradeCred,
    null,
    "field 5 = pending_upgrade_cred must be None at genesis — a nomination baked into the " +
      "genesis datum is forbidden by params_wellformed(is_init: True)"
  );

  // ⚠ THE BRICK CHECK — INVERTED IN PLACE, AND THE HARM ANALYSIS TRAVELS WITH IT.
  //
  // This assertion used to read `"key"`. It is not being relaxed; the fact that
  // justified it has been removed upstream, and the flip is left visible in the
  // diff for exactly that reason.
  //
  // WHY IT EXISTED: protocol_params requires `upgrade_cred` to appear in
  // `tx.withdrawals`, so the credential must be a REGISTERED stake credential.
  // alpha.3's `upgrade_multisig` had `withdraw` and `else` and NOTHING ELSE — a
  // Conway RegCert runs the script under the **publish** purpose, so a
  // script-witnessed registration fell through to `else` and failed, and
  // Evolution refuses an unwitnessed one outright ("Redeemer required for
  // script-controlled stake credential registration"). Naming a credential that
  // could never be registered is upstream's ONE-WAY BRICK: the authority check
  // becomes "permanently unsatisfiable, with no repair path". So the fixture
  // installed the wallet's verification key instead, and this pin guarded it.
  //
  // WHAT REMOVED THE REASON, specifically and narrowly: upstream d37ca8d added
  //     publish(_r, c, _s) { when c is { RegisterCredential { .. } -> True
  //                                      _ -> False } }
  // to `upgrade_multisig`. THAT HANDLER IS THE ENTIRE JUSTIFICATION for a script
  // authority here. The rule above still holds unchanged — the credential must
  // be registrable — and alpha.4 is the first version in which this particular
  // credential satisfies it.
  assert.equal(
    params.upgradeCred.type,
    "script",
    "alpha.4 installs a SCRIPT upgrade authority — legitimate only because " +
      "upgrade_multisig.publish(RegisterCredential) exists at d37ca8d and makes the credential " +
      "registrable. Without that handler this is a one-way brick."
  );
  assert.equal(
    params.upgradeCred.hash,
    deployment.upgradeMultisig.scriptHash,
    "the installed authority must be THIS deployment's upgrade_multisig"
  );
  // ⛔ THE COHERENCE CHECK THE LEDGER CANNOT MAKE. The datum names a dispatcher;
  // the dispatcher was compiled against three delegate hashes. Nothing on chain
  // compares them — a script cannot read another script parameters — so a stale
  // pair deploys cleanly and fails later at withdrawal time with an index error
  // naming neither cause. Re-derive it here, on the live artefact.
  {
    const bp = loadStandardBlueprint();
    const rederived = createStandardScripts(bp).programmableLogicGlobal(
      deployment.transfer.scriptHash,
      deployment.thirdParty.scriptHash,
      deployment.unfracking.scriptHash,
    ).hash;
    assert.equal(
      params.plgCred.hash,
      rederived,
      "the dispatcher in the datum must be the one compiled against these delegates"
    );
  }

  // Each credential must be a SCRIPT credential. A key credential here has the
  // same shape and the same hash length; only the constructor index differs,
  // and programmable_logic_base would never resolve the delegate.
  for (const [name, c] of [
    ["plg", params.plgCred],
    ["issuanceLogic", params.issuanceLogicCred],
    ["transfer", params.transferCred],
    ["thirdParty", params.thirdPartyCred],
  ] as const) {
    assert.equal(c.type, "script", `${name} must be a SCRIPT credential, not a key credential`);
  }

  // --- the registry origin node must be the SEVEN-field layout --------------
  // policy == address: one hash serves as both.
  const registryAddr = scriptAddress(networkId, deployment.registry.scriptHash);
  const registryUtxos = await client.getUtxosWithUnit(
    EvoAddress.fromBech32(registryAddr),
    deployment.registry.scriptHash
  );
  assert.equal(registryUtxos.length, 1, "exactly one registry origin node");
  const originDatum = getInlineDatum(registryUtxos[0]);
  assert.ok(originDatum, "the registry origin must carry an inline datum");
  const origin = decodeRegistryNode(originDatum);
  assert.equal(origin.key, "", "sentinel head has an empty key");
  assert.equal(origin.next, "ff".repeat(30), "sentinel tail pointer");

  // --- the upgrade authority is OPERABLE, not merely NAMED ------------------
  //
  // ⛔ §15b, and the measured instance of "correct and useless" IS THIS REPO: a
  // deployment named an authority credential that could not be registered at
  // all. Every hash reproduced, every read-back matched, every test passed, and
  // the protocol's upgrade path was permanently unsatisfiable. "It exists and
  // is well-formed" left "and can be used" untested.
  //
  // The datum assertions above prove the deployment NAMES upgrade_multisig.
  // They say nothing about whether that authority can be satisfied. The tree
  // lives in a config UTxO, not in the script's parameters, so an authority
  // whose config UTxO is missing, bundled, or carrying the wrong tree is named
  // correctly and unusable.
  const multisigAddr = scriptAddress(networkId, deployment.upgradeMultisig.scriptHash);
  const multisigNftUnit =
    deployment.upgradeMultisig.scriptHash + stringToHex("UpgradeMultisig");
  const atMultisigAddr = await client.getUtxos(EvoAddress.fromBech32(multisigAddr));
  // ⛔ FIRST, PROVE THIS LOOKUP HAS TO DISCRIMINATE AT ALL. The bootstrap parks
  // a decoy — an NFT-free UTxO — at this address in tx0, so the address holds at
  // least two. Without it, "filter by policy" and "take anything here" are the
  // same function over a population of one, which is exactly what audit r1 F-2
  // measured: deleting the policy clause from this filter changed nothing.
  // Asserting the decoy exists is what keeps the next assertion honest.
  assert.ok(
    atMultisigAddr.length >= 2,
    `the multisig address must hold the config UTxO AND the bootstrap's parked decoy, so the ` +
      `policy filter below has something to reject; found ${atMultisigAddr.length} UTxO(s)`
  );
  // Located STRUCTURALLY, by policy, exactly as `upgrade_multisig.mint` does —
  // not by an equality test on a unit string this test built for itself.
  const configUtxos = atMultisigAddr.filter(
    (u: { assets: EvoAssets.Assets }) =>
      EvoAssets.getUnits(u.assets).some(
        (unit: string) =>
          unit !== "lovelace" && unit.slice(0, 56) === deployment.upgradeMultisig.scriptHash
      )
  );
  assert.equal(
    configUtxos.length,
    1,
    "exactly one config UTxO must hold the UpgradeMultisig NFT — it is one-shot, so zero " +
      "means the authority named by the genesis datum has no configuration and is unsatisfiable"
  );
  const configUtxo = configUtxos[0];

  // ⛔ THE NFT AND NOTHING ELSE. `upgrade_multisig.mint` finds its output with
  // `has_nft_strict`, which is strict about the WHOLE value: bundle any other
  // asset alongside the NFT and the output is simply NOT FOUND. Asserting this
  // off chain pins the property the validator will silently refuse on.
  const configUnits = EvoAssets.getUnits(configUtxo.assets).filter((u: string) => u !== "lovelace");
  assert.deepEqual(
    configUnits,
    [multisigNftUnit],
    "the config UTxO must carry the UpgradeMultisig NFT and NO other asset — has_nft_strict " +
      "does not find a bundled output"
  );
  assert.ok(
    !(configUtxo as { scriptRef?: unknown }).scriptRef,
    "the config UTxO must carry NO reference script — upgrade_multisig.mint requires " +
      "reference_script == None, and every later upgrade pays for it if it is there"
  );

  // And the tree itself must be the authority we meant, by name.
  const configDatum = getInlineDatum(configUtxo);
  assert.ok(configDatum, "the config UTxO must carry an inline datum — the tree IS the authority");
  const tree = decodeMultisigScript(configDatum);
  const walletPkh = paymentCredentialHash(EvoAddress.toBech32(await client.address()));
  assert.deepEqual(
    tree,
    { type: "signature", keyHash: walletPkh },
    "the config UTxO must hold Signature(<the wallet's payment credential>) — an authority " +
      "nobody can satisfy is a permanent brick with no repair path"
  );

  // --- all six delegate/authority stake credentials are DISTINCT ------------
  //
  // Six credentials, six roles. Upstream does NOT enforce distinctness on
  // chain — it is explicitly a deployment responsibility — and the roles are
  // structurally identical 28-byte hashes, so a swap deploys cleanly and a real
  // chain ACCEPTS it. (Measured: a deliberately-swapped delegate credential was
  // submitted for real and the chain took it. Only a read-back caught it.)
  const stakeCreds = [
    ["plg", deployment.programmableLogicGlobal.scriptHash],
    ["transfer", deployment.transfer.scriptHash],
    ["thirdParty", deployment.thirdParty.scriptHash],
    ["unfracking", deployment.unfracking.scriptHash],
    ["issuanceLogic", deployment.issuanceLogic.scriptHash],
    ["upgradeMultisig", deployment.upgradeMultisig.scriptHash],
  ] as const;
  assert.equal(
    new Set(stakeCreds.map(([, h]) => h)).size,
    6,
    `all six withdraw-0 credentials must be distinct; got ` +
      stakeCreds.map(([n, h]) => `${n}=${h.slice(0, 8)}`).join(", ")
  );

  // --- the SEVEN reference inputs: a COUNT plus an identity ------------------
  //
  // ⛔ THE MEMBERSHIP LIST THIS REPLACES NAMED FOUR AND SILENTLY OMITTED
  // `programmableLogicGlobal` — the §2d shape exactly: the member a list stops
  // noticing is the NEWEST one, which is also the one least covered anywhere
  // else. A membership list only ever detects REMOVALS; it decays into a stale
  // subset and reads as coverage the whole time.
  //
  // So collect the RefInput fields off the deployment rather than naming them,
  // and assert the COUNT as well as the properties. Adding an eighth reference
  // script without recording it now fails here.
  const refInputs = Object.entries(deployment).filter(([k]) => k.endsWith("RefInput")) as Array<
    [string, { txHash: string; outputIndex: number }]
  >;
  assert.equal(
    refInputs.length,
    7,
    `DeploymentParams must carry exactly 7 *RefInput fields (plb, plg, transfer, thirdParty, ` +
      `unfracking, issuanceLogic, upgradeMultisig); found ${refInputs.length}: ` +
      refInputs.map(([k]) => k).join(", ")
  );
  // All seven name the SAME publish transaction — they are one tx2's outputs.
  const refTxHashes = new Set(refInputs.map(([, v]) => v.txHash));
  assert.equal(
    refTxHashes.size,
    1,
    `all seven reference inputs must name the same publish transaction; got ` +
      `${[...refTxHashes].join(", ")}`
  );
  for (const [name, ref] of refInputs) {
    assert.match(ref.txHash, /^[0-9a-f]{64}$/, `${name} reference input needs a real tx hash`);
  }
  // And seven DISTINCT output indices. Two fields sharing an index means one
  // script was published and the other's reference input points at the wrong
  // body — which does not fail loudly, it fails at evaluation naming neither.
  //
  // ⚠ WHAT THESE THREE DO **NOT** CATCH — do not delete the resolution block
  // below as redundant, it is the half that has teeth.
  //
  // MEASURED (audit r1, F-1): drop `issuanceLogic` from the tx2 publish loop and
  // from REF_SCRIPT_ORDER and all three of these stay GREEN. `refIdx` returns
  // **-1** for a name it no longer holds, the script is never published, and -1
  // is a perfectly distinct seventh index — so the count is 7, the txHash is
  // shared, the indices are distinct, and `DeploymentParams` ships naming output
  // -1. These three assertions only ever catch a future EIGHTH ref input added
  // to the record and not counted; every other change to the field SET is
  // already a compile error against the interface. Whether a recorded index
  // points at a script that was actually PUBLISHED is a different question, and
  // only the on-chain resolution below asks it.
  assert.equal(
    new Set(refInputs.map(([, v]) => v.outputIndex)).size,
    7,
    `the seven reference inputs must have pairwise distinct output indices; got ` +
      refInputs.map(([k, v]) => `${k}=${v.outputIndex}`).join(", ")
  );

  // --- every recorded RefInput must RESOLVE to the script it NAMES ----------
  //
  // ⛔ THE PROPERTY `REF_SCRIPT_ORDER`'s OWN COMMENT SAYS MATTERS: "a mismatch
  // here does not fail loudly, it hands out a reference input carrying the WRONG
  // script and the transaction dies at evaluation naming neither." Everything
  // above this line is arithmetic on the record; this reads the chain.
  //
  // The mapping is written out BY HAND on purpose. Deriving the target from the
  // key by string surgery (`fooRefInput` -> `deployment.foo`) would make the
  // check agree with a record whose naming convention drifted, and would silently
  // skip any field the transformation failed to resolve — the check and the thing
  // checked would share a blind spot. An explicit table cannot skip anything, and
  // the exhaustiveness assertion beneath it makes a missing row fail loudly.
  const refTargets: Record<string, string> = {
    programmableBaseRefInput: deployment.programmableLogicBase.scriptHash,
    programmableLogicGlobalRefInput: deployment.programmableLogicGlobal.scriptHash,
    transferRefInput: deployment.transfer.scriptHash,
    thirdPartyRefInput: deployment.thirdParty.scriptHash,
    unfrackingRefInput: deployment.unfracking.scriptHash,
    issuanceLogicRefInput: deployment.issuanceLogic.scriptHash,
    upgradeMultisigRefInput: deployment.upgradeMultisig.scriptHash,
  };
  // An eighth RefInput added without a row here fails NOW, at a message that
  // names it, rather than by being quietly unresolved.
  assert.deepEqual(
    refInputs.map(([k]) => k).sort(),
    Object.keys(refTargets).sort(),
    "every *RefInput field must have an explicit expected-script row in refTargets — " +
      "an unmapped field is an unchecked field"
  );

  for (const [name, ref] of refInputs) {
    const expectedHash = refTargets[name]!;

    // (a) The index must be a real output index BEFORE anything tries to look it
    // up. -1 is what `REF_SCRIPT_ORDER.indexOf` returns for a name it no longer
    // holds, and it is the exact value the audit measured shipping undetected.
    // Asserted separately so the red NAMES the field instead of surfacing as a
    // schema error from deep inside the provider.
    assert.ok(
      Number.isInteger(ref.outputIndex) && ref.outputIndex >= 0,
      `${name} records outputIndex ${ref.outputIndex}, which is not a real output index. ` +
        `-1 means REF_SCRIPT_ORDER.indexOf did not find the name — the script was never ` +
        `published and this record points at nothing.`
    );

    // (b) The output must exist, and (c) carry a reference script.
    const resolved = await client.getUtxosByOutRef([
      new EvoTransactionInput.TransactionInput({
        transactionId: EvoTransactionHash.fromHex(ref.txHash),
        index: BigInt(ref.outputIndex),
      }),
    ]);
    assert.equal(
      resolved.length,
      1,
      `${name} points at ${ref.txHash}#${ref.outputIndex}, which does not exist on chain`
    );
    const scriptRef = (resolved[0] as { scriptRef?: unknown }).scriptRef;
    assert.ok(
      scriptRef,
      `${name} resolves to ${ref.txHash}#${ref.outputIndex}, but that output carries NO ` +
        `reference script. A reference input without a script body is useless to every ` +
        `operation that names it.`
    );

    // (d) And it must be the RIGHT script. This is the "right index, wrong body"
    // case: publishing in one order and recording in another produces indices
    // that all exist, all carry scripts, and hand out the wrong bytes.
    assert.equal(
      EvoScriptHash.toHex(EvoScriptHash.fromScript(scriptRef as never)),
      expectedHash,
      `${name} resolves to a reference script whose hash is not the one the record names`
    );
  }
});
