/**
 * alpha.5's genesis activation, on a live devnet — SUBJECT AND NEGATIVE CONTROL.
 *
 * ⛔ WHY A GREEN BOOTSTRAP IS NOT EVIDENCE HERE. `test/devnet/bootstrap.test.ts`
 * already stands a protocol up end to end, and under alpha.5 that run carries a
 * withdraw-0 from `upgrade_cred`. If it goes green, exactly two worlds are
 * consistent with what we saw:
 *
 *   (a) the new check ran and passed, or
 *   (b) the new check is not running at all — wrong blueprint vendored, wrong
 *       directory targeted, the validator's one line absent from the artefact —
 *       and the transaction succeeded for the reasons alpha.4's did.
 *
 * A success cannot tell those apart. Only a REFUSAL can: the same genesis, at
 * the same seeds, against the same config UTxO, with the withdrawal REMOVED and
 * nothing else changed. If the ledger accepts THAT, world (b) is the one we are
 * in, and the release is unsound regardless of how green everything else looks.
 *
 * ⚠ THE BYPASS IS BUILT HERE, NOT IN THE SDK AND NOT IN THE HARNESS. The
 * exported `buildProtocolGenesisTx` has no "skip the activation" option and
 * must not grow one — shipping the footgun to test the safety catch is a bad
 * trade. `bootstrapProtocol`'s `beforeProtocolGenesis` hook hands this file the
 * plan, the seeds and the config UTxO; the alpha.4-shaped genesis below is this
 * FIXTURE's, and its only difference from the real one is the withdrawal, the
 * reference input and the script witness that serve it.
 *
 * ⚠ ORDER MATTERS AND IS DELIBERATE. The control is submitted FIRST, from
 * inside the hook, because a refused transaction consumes nothing — the seeds
 * are still unspent when the real genesis follows a moment later. Running the
 * control second would need a whole second bootstrap to get fresh seeds, and
 * two bootstraps are two different subjects.
 *
 * LOCAL DEVNET ONLY. `requireDevnet()` refuses anything else, and
 * `bootstrapProtocol` refuses a non-testnet network id on top of that.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvoScript,
  ceilToWholeAda,
  mintAssetsFromMap,
  minUtxoAtLeast,
  outputAssets,
  registryInitRedeemer,
  REGISTRY_NODE_MIN_ADA,
  decodeProtocolParams,
} from "../../dist/index.js";
import {
  Address as EvoAddress,
  Data,
  InlineDatum,
} from "@evolution-sdk/evolution";

import { requireDevnet } from "../harness/yaci.mjs";
import {
  bootstrapProtocol,
  type BeforeProtocolGenesisContext,
} from "../harness/bootstrap.js";

before(async () => {
  await requireDevnet();
});

/** What the ledger said, however it was wrapped. */
function messageOf(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const parts = [String(e?.message ?? err)];
  if (e?.cause) parts.push(String((e.cause as { message?: string })?.message ?? e.cause));
  return parts.join(" | ");
}

/**
 * The alpha.4-shaped protocol genesis: everything `buildProtocolGenesisTx`
 * emits EXCEPT the activation.
 *
 * ⛔ KEPT DELIBERATELY CLOSE TO THE EXPORT'S BODY, mints, datums, min-UTxO
 * solving and script witnesses alike, because a control that differs in a
 * second place cannot attribute the refusal to the first. The three omissions
 * are named, and they are the three things alpha.5 added.
 */
async function buildGenesisWithoutActivation(c: BeforeProtocolGenesisContext) {
  const { plan } = c;
  const coinsPerUtxoByte = (await c.client.getProtocolParameters()).coinsPerUtxoByte;
  const solved = (address: string, assets: Map<string, bigint>, datum: Data.Data) =>
    ceilToWholeAda(
      minUtxoAtLeast(2_000_000n, {
        address,
        assets: outputAssets(0n, assets),
        datum,
        coinsPerUtxoByte,
      })
    );

  const paramsNft = new Map([[plan.assetUnits.protocolParamsNft, 1n]]);
  const registryNft = new Map([[plan.assetUnits.registryNode, 1n]]);
  const issuanceNft = new Map([[plan.assetUnits.issuanceCborHexNft, 1n]]);

  let tx = c.client.newTx();
  tx = tx.collectFrom({ inputs: [c.protocolParamsSeedUtxo, c.issuanceSeedUtxo] });
  tx = tx.mintAssets({
    assets: mintAssetsFromMap(registryNft),
    redeemer: registryInitRedeemer(),
  });
  tx = tx.mintAssets({ assets: mintAssetsFromMap(paramsNft), redeemer: Data.constr(1n, []) });
  tx = tx.mintAssets({ assets: mintAssetsFromMap(issuanceNft), redeemer: Data.constr(2n, []) });

  // ⛔ OMITTED, AND THIS IS THE WHOLE EXPERIMENT:
  //      tx.withdraw({ Script(upgrade_multisig), 0n })
  //      tx.readFrom({ the config UTxO })
  //      tx.attachScript({ upgrade_multisig })
  //      tx.addSigner({ the tree's key hash })
  // Everything below is byte-for-byte what the export still emits.

  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.protocolParams),
    assets: outputAssets(
      solved(plan.addresses.protocolParams, paramsNft, plan.datums.protocolParams),
      paramsNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.protocolParams }),
  });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.registry),
    assets: outputAssets(
      ceilToWholeAda(
        minUtxoAtLeast(REGISTRY_NODE_MIN_ADA, {
          address: plan.addresses.registry,
          assets: outputAssets(0n, registryNft),
          datum: plan.datums.registryOrigin,
          coinsPerUtxoByte,
        })
      ),
      registryNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.registryOrigin }),
  });
  tx = tx.payToAddress({
    address: EvoAddress.fromBech32(plan.addresses.issuanceCborHex),
    assets: outputAssets(
      solved(plan.addresses.issuanceCborHex, issuanceNft, plan.datums.issuanceCborHex),
      issuanceNft
    ),
    datum: new InlineDatum.InlineDatum({ data: plan.datums.issuanceCborHex }),
  });

  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.registry.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.protocolParams.compiledCode) });
  tx = tx.attachScript({ script: buildEvoScript(plan.scripts.issuanceCborHexMint.compiledCode) });

  return tx.build({
    changeAddress: EvoAddress.fromBech32(c.changeAddress),
    evaluator: c.evaluator,
    availableUtxos: await c.availableUtxos(),
  });
}

test("NEGATIVE CONTROL then SUBJECT: the genesis is refused without the withdraw-0 and accepted with it", async () => {
  let controlOutcome: { accepted: boolean; text: string } | undefined;
  let genesisPolicies:
    | { registry: string; protocolParams: string; issuanceCborHexMint: string }
    | undefined;

  const deployment = await bootstrapProtocol({
    beforeProtocolGenesis: async (c) => {
      // ⚑ PROVE THE CONTROL IS AIMED AT THE RIGHT PROTOCOL. If the plan's
      // upgrade credential were not the one the datum names, the refusal below
      // would be about something else entirely.
      const upgradeCred = plan_upgradeCred(c);
      assert.match(upgradeCred, /^[0-9a-f]{56}$/);
      assert.equal(upgradeCred, c.plan.scripts.upgradeMultisig.hash);
      genesisPolicies = {
        registry: c.plan.scripts.registry.hash,
        protocolParams: c.plan.scripts.protocolParams.hash,
        issuanceCborHexMint: c.plan.scripts.issuanceCborHexMint.hash,
      };

      let built;
      try {
        built = await buildGenesisWithoutActivation(c);
      } catch (err) {
        // ⛔ A BUILD failure is NOT the observation this test wants. Phase-2
        // evaluation runs during build, so the script may refuse here rather
        // than at submission — that is still the ledger refusing, and it is
        // recorded as such, with its own text.
        controlOutcome = { accepted: false, text: messageOf(err) };
        console.error(
          "  [negative control] REFUSED AT BUILD (phase-2 evaluation):\n  | " +
            controlOutcome.text.slice(0, 1500)
        );
        return;
      }

      try {
        const res = await built.signAndSubmit();
        controlOutcome = { accepted: true, text: String(res) };
        // ⛔ THROWN HERE, NOT ASSERTED LATER, AND A MUTATION RUN IS WHY. With
        // the activation restored the control IS accepted — and it then spends
        // the seeds, so the real genesis that follows dies with ledger code
        // 3117, "unknown UTxO references as inputs". MEASURED: that is the only
        // message the run produced, it names a UTxO, it reads as a builder bug,
        // and it arrives from a completely different transaction. Failing at
        // the moment of the observation is what keeps the diagnosis attached to
        // what was actually observed.
        throw new Error(
          `⛔ STOP — THE NEGATIVE CONTROL WAS ACCEPTED (tx ${String(res)}). A genesis with NO ` +
            `withdraw-0 from upgrade_cred was admitted by the ledger, so alpha.5's new check ` +
            `is not firing: wrong blueprint vendored, wrong directory targeted, or upstream's ` +
            `line absent from the artefact. Every other green in this suite says nothing about ` +
            `the activation. Do not paper over this.`
        );
      } catch (err) {
        if (controlOutcome?.accepted) throw err;
        controlOutcome = { accepted: false, text: messageOf(err) };
        console.error(
          "  [negative control] REFUSED AT SUBMISSION:\n  | " +
            controlOutcome.text.slice(0, 1500)
        );
      }
    },
  });

  // ---- the control ------------------------------------------------------
  assert.ok(controlOutcome, "the beforeProtocolGenesis hook did not run — nothing was measured");
  assert.ok(genesisPolicies, "the hook ran but recorded no policies — nothing to attribute to");
  assert.equal(
    controlOutcome.accepted,
    false,
    "⛔ STOP. The genesis WITHOUT the withdraw-0 was ACCEPTED. alpha.5's new check is not " +
      "firing — wrong blueprint, wrong target directory, or upstream's line is absent from the " +
      "artefact — and every green in this suite says nothing about it. Ledger response: " +
      controlOutcome.text
  );
  // ⛔ REFUSED IS NOT ENOUGH — REFUSED BY WHOM. A control that dies on a
  // balance error, a missing input or the registry's own mint arm would be
  // just as red and would prove nothing about the new check. Aiken's `?`
  // traces are compiled out of `aiken build` output (measured: the traces list
  // comes back EMPTY, and even `protocol_params`'s own entry trace is absent),
  // so the validator cannot name itself. What the ledger DOES give is the
  // failing redeemer's purpose and index.
  const failing = /\bmint@(\d+)\b/.exec(controlOutcome.text);
  assert.ok(
    failing,
    "the control was refused, but not by a MINT script — so it was refused for some reason " +
      "other than the activation, and this fixture is measuring the wrong thing. Ledger " +
      "response: " + controlOutcome.text
  );
  // Mint redeemers are indexed by the position of the policy id in the mint
  // field, which the ledger keeps sorted. Three policies mint here; only one of
  // them is `protocol_params`.
  const policies = [
    genesisPolicies!.registry,
    genesisPolicies!.protocolParams,
    genesisPolicies!.issuanceCborHexMint,
  ].sort();
  assert.equal(new Set(policies).size, 3, "three distinct minting policies");
  assert.equal(
    Number(failing[1]),
    policies.indexOf(genesisPolicies!.protocolParams),
    "a mint script refused the control, but not protocol_params — index " +
      `${failing[1]} of [${policies.join(", ")}] is not ` +
      `${genesisPolicies!.protocolParams}. The refusal is not the activation check.`
  );

  // ---- the subject ------------------------------------------------------
  assert.match(deployment.txHash, /^[0-9a-f]{64}$/, "the genesis WITH the activation was accepted");
  assert.equal(
    deployment.upgradeAuthority.hash,
    deployment.upgradeMultisig.scriptHash,
    "the authority the record names must be the credential that withdrew at genesis"
  );
  assert.equal(deployment.upgradeAuthority.type, "script");
});

/**
 * The upgrade credential the genesis datum carries — through the SDK's own
 * decoder rather than by reaching into `Data` positionally, which is the very
 * hazard `decodeProtocolParams` exists to close (field 1 moved between alpha.3
 * and alpha.4 and a positional read returned the wrong credential silently).
 */
function plan_upgradeCred(c: BeforeProtocolGenesisContext): string {
  const params = decodeProtocolParams(c.plan.datums.protocolParams);
  assert.equal(params.upgradeCred.type, "script", "upgrade_cred must be a script credential");
  return params.upgradeCred.hash;
}
