/**
 * In-place protocol upgrade — test fixture (T-D07).
 *
 * The coordination UTxO holds the live wiring. An upgrade SPENDS it and writes a
 * continuing output with a new datum, rather than redeploying
 * programmable_logic_base — whose hash anchors every programmable token address
 * and therefore cannot move without moving every token.
 *
 * `coordination_spend` enforces the structural rails and TRAMPOLINES the
 * authorisation decision to whatever `upgrade_cred` the CURRENT (spent) datum
 * names — read from the old datum on purpose, so the sitting authority
 * authorises every change including a change of authority.
 *
 * Rails, from the validator itself:
 *   * exactly one input at the coordination address, exactly one continuing
 *     output there;
 *   * non-ADA value STRICTLY equal (the NFT continues, no junk injected), ADA
 *     may only GROW — the ratchet is one-way and over-funding is unrecoverable;
 *   * `prog_logic_cred` and `registry_node_cs` FROZEN forever;
 *   * every mutable credential a well-formed 28-byte hash — a wrong-length
 *     value is a one-way brick with no repair path;
 *   * no reference script on the continuing output;
 *   * `upgrade_cred`'s withdraw-0 present in the transaction.
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

export interface UpgradeOptions {
  /** Mutate the current params into the desired new params. */
  readonly change: (current: ProtocolParamsData) => ProtocolParamsData;
  /** Omit the upgrade authority's withdraw-0 — for proving the rail bites. */
  readonly omitAuthority?: boolean;
  /** Extra lovelace on the continuing output (the ADA ratchet permits growth). */
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
  // The redeemer is untyped -- the validator ignores the value entirely -- but a
  // script-locked input still REQUIRES one to be present.
  tx = tx.collectFrom({ inputs: [utxo], redeemer: voidData() });
  tx = tx.attachScript({ script: buildEvoScript(paramsScript.compiledCode) });

  // Continuing output: same address, and the INPUT'S OWN value carried through
  // rather than reconstructed. The validator requires non-ADA assets to be
  // STRICTLY equal, so reassembling the multi-asset by hand would be a
  // needless opportunity to drop the NFT; addLovelace touches only the ADA leg,
  // which is the one the validator permits to grow.
  const outAssets = opts.extraLovelace
    ? EvoAssets.addLovelace(utxo.assets, opts.extraLovelace)
    : utxo.assets;
  tx = tx.payToAddress({
    address: utxo.address,
    assets: outAssets,
    datum: new InlineDatum.InlineDatum({ data: protocolParamsDatum(next) }),
  });

  // The trampoline: the CURRENT datum's authority must produce a withdraw-0.
  if (!opts.omitAuthority) {
    if (params.upgradeCred.type !== "key") {
      throw new Error(
        `This fixture can only satisfy a KEY upgrade authority; the datum names a ` +
          `script credential (${params.upgradeCred.hash}), which must be a registered ` +
          `stake credential with a publish handler to be registerable at all.`
      );
    }
    // withdraw-0: the entry's PRESENCE is the authorisation; the amount is
    // irrelevant to coordination_spend, which only does has_key_or_fail.
    tx = tx.withdraw({
      stakeCredential: Credential.makeKeyHash(Bytes.fromHex(params.upgradeCred.hash)),
      amount: 0n,
    });
    tx = tx.addSigner({ keyHash: KeyHash.fromHex(params.upgradeCred.hash) });
  }

  const built = await tx.build({
    changeAddress: addressObj,
    evaluator: createOgmiosEvaluator(process.env.OGMIOS_URL ?? "http://localhost:1337"),
  });
  const res = await built.signAndSubmit();
  const hash = typeof res === "string" ? res : EvoTransactionHash.toHex(res);
  await client.awaitTx(EvoTransactionHash.fromHex(hash), 2_000, 180_000);
  return hash;
}
