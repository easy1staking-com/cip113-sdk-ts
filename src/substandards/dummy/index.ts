/**
 * Dummy substandard — minimal programmable token.
 *
 * Uses simple withdraw validators:
 * - issue: redeemer == 100
 * - transfer: redeemer == 200
 *
 * No compliance features, no blacklist.
 * Uses Evolution SDK directly — no adapter abstraction.
 */

import {
  Address as EvoAddress,
  Bytes,
  Data,
  Transaction,
} from "@evolution-sdk/evolution";

import type { UTxO as EvoUTxO } from "@evolution-sdk/evolution";

import type { PlutusBlueprint, PlutusScript } from "../../types.js";
import type {
  SubstandardPlugin,
  SubstandardContext,
  EvoClient,
  RegisterParams,
  MintParams,
  BurnParams,
  TransferParams,
  UnsignedTx,
} from "../interface.js";
import { getValidatorCode } from "../../standard/blueprint.js";
import {
  sortTxInputs,
  findRefInputIndex,
  findRegistryNode,
  findCoveringNode,
  utxoToTxInput,
} from "../../core/registry.js";
import {
  baseSpendRedeemer,
  transferRedeemer,
  referenceInputIndexOf,
  withdrawalIndexOf,
  type WithdrawalKey,
} from "../../core/ledger-order.js";
import {
  buildEvoScript,
  computeScriptHash,
  scriptAddress,
  baseAddress,
  stakingCredentialHash,
  stringToHex,
  voidData,
  registryNodeDatum,
  decodeRegistryNode,
  registryInsertRedeemer,
  mintingProofOutputIndex,
  mintingProofRefInput,
  mintAssetsFromMap,
  getInlineDatum,
  utxoUnitQty,
  outputAssets,
  Credential,
  KeyHash,
  InlineDatum,
} from "../../core/evo-utils.js";

const DUMMY_VALIDATORS = {
  ISSUE: "transfer.issue.withdraw",
  TRANSFER: "transfer.transfer.withdraw",
} as const;

export function dummySubstandard(config: {
  blueprint: PlutusBlueprint;
}): SubstandardPlugin {
  let ctx: SubstandardContext;
  let issueScript: PlutusScript;
  let transferScript: PlutusScript;
  let networkId: number;

  function buildScript(validatorTitle: string): PlutusScript {
    const code = getValidatorCode(config.blueprint, validatorTitle);
    const hash = computeScriptHash(code);
    return { type: "PlutusV3", compiledCode: code, hash };
  }

  const hexToBytes = (hex: string) => Bytes.fromHex(hex);

  /**
   * ⛔ Both of dummy's validators are withdraw-0, and a withdraw-0 needs its
   * stake credential REGISTERED on chain before it can appear in a transaction.
   * Registering emits a Conway RegCert, which runs the script under the PUBLISH
   * purpose — so a validator with no `publish` handler falls through to `else`
   * and the registration fails at evaluation with an empty trace list.
   *
   * The bundled dummy blueprint (v0.1.0, Aiken v1.1.19) has ONLY `withdraw` and
   * `else`. MEASURED on a devnet, with two different redeemers:
   *
   *     validator { index: 0, purpose: "publish" }
   *     "The machine terminated because of an error", traces: []
   *
   * and consequently a register/mint/transfer fails later and more obscurely,
   * at submission, with code 3141 naming a reward account nobody recognises.
   *
   * This is the SAME blocker that stopped the standard bootstrap under the
   * 0.3.0 blueprint, recurring one layer down — and the standard side was only
   * ever unblocked because upstream dissolved PLG into validators that DO carry
   * publish handlers. Nothing has done that for the substandards.
   *
   * Refused here, up front, rather than allowed to surface as an opaque
   * submission error three transactions later. Fixing it needs a dummy blueprint
   * compiled with publish handlers, which is upstream's business: this repo
   * consumes blueprints and does not build them (see the constitution — an
   * `.ak` file here is an escalation).
   */
  function requirePublishHandlers(): void {
    const titles = config.blueprint.validators.map((v) => v.title);
    const missing = [
      DUMMY_VALIDATORS.ISSUE.replace(".withdraw", ".publish"),
      DUMMY_VALIDATORS.TRANSFER.replace(".withdraw", ".publish"),
    ].filter((t) => !titles.includes(t));
    if (missing.length === 0) return;
    throw new Error(
      `The dummy blueprint cannot operate on CIP-113 0.5.x: it lacks publish handler(s) ` +
        `${missing.join(", ")}.\n` +
        `Both dummy validators are withdraw-0, so their stake credentials must be registered ` +
        `before any register/mint/transfer can validate. Registration runs the script under ` +
        `the PUBLISH purpose and a blueprint without that handler fails at evaluation with an ` +
        `empty trace list (MEASURED on devnet).\n` +
        `Present handlers: ${titles.join(", ")}\n` +
        `Blueprint: "${config.blueprint.preamble.title}" v${config.blueprint.preamble.version} ` +
        `(${config.blueprint.preamble.compiler?.name} ${config.blueprint.preamble.compiler?.version}).\n` +
        `A publish-capable dummy blueprint is required. This repository consumes blueprints ` +
        `and does not build them. See PLAN.md, workstream W-D / T-D08.`
    );
  }

  /**
   * The coordination UTxO — every programmable_logic_base spend and every
   * delegate reads it, so every operation here needs it as a reference input.
   *
   * ⚠ It lives at coordination_spend in 0.5.x, NOT at always_fail. The
   * parameter naming that lock target kept its arity and its type across the
   * change, so a lookup at the old address finds nothing and reports only that
   * the UTxO is missing.
   */
  async function findParamsUtxo(): Promise<EvoUTxO.UTxO> {
    const unit = ctx.deployment.protocolParams.policyId + stringToHex("ProtocolParams");
    const addr = EvoAddress.fromBech32(
      scriptAddress(networkId, ctx.deployment.coordination.scriptHash)
    );
    const utxos = await ctx.client.getUtxosWithUnit(addr, unit);
    if (utxos.length === 0) {
      throw new Error(
        `Protocol params UTxO not found (unit ${unit}) at the coordination address. ` +
          `The params NFT is one-shot: zero results means it is locked elsewhere, not that ` +
          `the protocol is un-deployed.`
      );
    }
    return utxos[0]!;
  }

  /**
   * The IssuanceCborHex UTxO.
   *
   * `registry_mint`'s RegistryInsert requires this as a REFERENCE INPUT: it
   * reads the issuance template from the datum and re-derives the token policy
   * from it, so the key being registered is cryptographically bound to the
   * minting logic rather than merely asserted. Omitting it fails with
   * "Expected a non-empty list but got an empty one" — an `expect_find` over
   * reference_inputs — which names neither the input nor the reason.
   */
  async function findIssuanceCborUtxo(): Promise<EvoUTxO.UTxO> {
    const unit = ctx.deployment.issuance.policyId + stringToHex("IssuanceCborHex");
    const addr = EvoAddress.fromBech32(
      scriptAddress(networkId, ctx.deployment.issuance.alwaysFailScriptHash)
    );
    const utxos = await ctx.client.getUtxosWithUnit(addr, unit);
    if (utxos.length === 0) {
      throw new Error(`IssuanceCborHex UTxO not found (unit ${unit})`);
    }
    return utxos[0]!;
  }

  /** Build the transaction and shape it into an UnsignedTx. */
  async function finish(
    tx: unknown,
    changeAddress: string,
    extra: { tokenPolicyId?: string; unit?: string; outputIndices?: Record<string, number> } = {}
  ): Promise<UnsignedTx> {
    const result = await (tx as any).build({
      changeAddress: EvoAddress.fromBech32(changeAddress),
      ...(ctx.evaluator ? { evaluator: ctx.evaluator } : {}),
    });
    const txObj = await result.toTransaction();
    const cbor = Transaction.toCBORHex(txObj);
    const txHash =
      typeof result.chainResult === "function" ? result.chainResult().txHash : "";
    return {
      cbor,
      txHash,
      tokenPolicyId: extra.tokenPolicyId,
      metadata: { unit: extra.unit, outputIndices: extra.outputIndices },
      _signBuilder: result,
    } as UnsignedTx;
  }

  return {
    id: "dummy",
    version: "0.1.0",
    blueprint: config.blueprint,

    init(context) {
      ctx = context;
      networkId = ctx.client.chain.id;
      issueScript = buildScript(DUMMY_VALIDATORS.ISSUE);
      transferScript = buildScript(DUMMY_VALIDATORS.TRANSFER);
      requirePublishHandlers();
    },

    /**
     * Register a dummy token in the protocol registry, and mint its first
     * supply in the same transaction.
     *
     * Registration is a linked-list insertion. The registry is an ordered chain
     * of nodes keyed by token policy id; inserting means finding the COVERING
     * node (the one whose key < ours and whose next > ours), spending it to
     * repoint its `next` at us, and minting a new node NFT for our own entry.
     *
     * Mint and registration are one transaction because `issuance_mint`'s
     * MintingRegistryProof can name the registry node as an OUTPUT of this very
     * transaction (ctor 1, OutputIndex) rather than as a reference input — so
     * the token can be minted before its node exists anywhere else.
     */
    async register(params: RegisterParams): Promise<UnsignedTx> {
      const { feePayerAddress, assetName, quantity } = params;
      const recipient = params.recipientAddress ?? feePayerAddress;
      const client = ctx.client;

      // The token policy IS issuance_mint parameterised by our minting logic.
      const issuanceMint = ctx.standardScripts.buildIssuanceMint(issueScript.hash);
      const tokenPolicyId = issuanceMint.hash;
      const unit = tokenPolicyId + assetName;

      const registryMintPolicyId = ctx.standardScripts.registryMint.hash;
      const registrySpendAddr = scriptAddress(networkId, ctx.standardScripts.registrySpend.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registrySpendAddr));

      const covering = findCoveringNode(registryUtxos, tokenPolicyId);
      if (!covering) {
        throw new Error(
          `No covering registry node found for policy ${tokenPolicyId}. The registry origin ` +
            `node must exist (it is created by the protocol bootstrap) and no node with this ` +
            `key may already be present.`
        );
      }
      const coveringDatumData = getInlineDatum(covering);
      if (!coveringDatumData) {
        throw new Error("The covering registry node carries no inline datum");
      }
      const coveringNode = decodeRegistryNode(coveringDatumData);
      if (coveringNode.key === tokenPolicyId) {
        throw new Error(`Policy ${tokenPolicyId} is already registered`);
      }

      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipient);

      // Our node points where the covering node used to point; the covering
      // node now points at us. Ordinary singly-linked-list insertion, except a
      // mistake here is an unspendable token rather than a lost pointer.
      const newNodeDatum = registryNodeDatum({
        key: tokenPolicyId,
        next: coveringNode.next,
        mintingLogicScript: { type: "script", hash: issueScript.hash },
        transferLogicScript: { type: "script", hash: transferScript.hash },
        // dummy has no compliance and no unfracking concept, but these fields
        // are MANDATORY and must be well-formed 28-byte credentials — upstream
        // applies the same one-way-brick rule here as to the params datum.
        // Pointing them at dummy's own transfer logic keeps every path
        // satisfiable; it is a fixture choice, not a compliance design.
        thirdPartyTransferLogicScript: { type: "script", hash: transferScript.hash },
        unfrackingLogicScript: { type: "script", hash: transferScript.hash },
        globalStateCs: "",
      });
      const updatedCoveringDatum = registryNodeDatum({ ...coveringNode, next: tokenPolicyId });

      const registryNftUnit = registryMintPolicyId + tokenPolicyId;
      const coveringNftUnit = registryMintPolicyId + coveringNode.key;

      // Output order is the contract: the MintingRegistryProof below names our
      // registry node by OUTPUT INDEX, so moving these outputs silently changes
      // which output the validator inspects.
      const OUT_TOKEN = 0;
      const OUT_NEW_NODE = 1;
      const OUT_COVERING = 2;

      let tx = client.newTx();
      tx = tx.collectFrom({ inputs: [covering], redeemer: voidData() });

      // The minting-logic withdraw-0: dummy's `issue` validator, redeemer 100.
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(hexToBytes(issueScript.hash)),
        amount: 0n,
        redeemer: Data.int(100n),
      });

      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[unit, quantity]])),
        redeemer: mintingProofOutputIndex(OUT_NEW_NODE),
      });
      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[registryNftUnit, 1n]])),
        redeemer: registryInsertRedeemer(tokenPolicyId, { type: "script", hash: issueScript.hash }),
      });

      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(1_300_000n, new Map([[unit, quantity]])),
        datum: new InlineDatum.InlineDatum({ data: voidData() }),
      });
      // ⚠ min-UTxO, not a round number pulled from the old code.
      //
      // MEASURED: a 7-field RegistryNode datum plus the node NFT requires
      // 2,038,630 lovelace. The 2,000,000 this was inherited from is below that
      // — it was sized for the FIVE-field datum. Growing a datum raises the
      // minimum ADA of every output carrying it, and the ledger reports that as
      // "insufficient Ada" naming a number, never as "your datum grew".
      // Deliberately generous rather than exact: min-UTxO scales with
      // serialised size and with a protocol parameter that can rise.
      const REGISTRY_NODE_ADA = 3_000_000n;
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registrySpendAddr),
        assets: outputAssets(REGISTRY_NODE_ADA, new Map([[registryNftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: newNodeDatum }),
      });
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(registrySpendAddr),
        assets: outputAssets(REGISTRY_NODE_ADA, new Map([[coveringNftUnit, 1n]])),
        datum: new InlineDatum.InlineDatum({ data: updatedCoveringDatum }),
      });

      const paramsUtxo = await findParamsUtxo();
      const issuanceCborUtxo = await findIssuanceCborUtxo();
      tx = tx.readFrom({ referenceInputs: [paramsUtxo, issuanceCborUtxo] });
      tx = tx.attachScript({ script: buildEvoScript(issuanceMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.registryMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.registrySpend.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(issueScript.compiledCode) });

      return finish(tx, feePayerAddress, { tokenPolicyId, unit, outputIndices: { OUT_TOKEN, OUT_NEW_NODE, OUT_COVERING } });
    },

    /**
     * Mint more of an already-registered dummy token.
     *
     * Differs from `register` only in where the registry node is: it already
     * exists, so the proof names it as a REFERENCE input (ctor 0) rather than as
     * an output of this transaction.
     */
    async mint(params: MintParams): Promise<UnsignedTx> {
      const { feePayerAddress, tokenPolicyId, assetName, quantity } = params;
      const recipient = params.recipientAddress ?? feePayerAddress;
      const client = ctx.client;
      const unit = tokenPolicyId + assetName;

      const issuanceMint = ctx.standardScripts.buildIssuanceMint(issueScript.hash);
      if (issuanceMint.hash !== tokenPolicyId) {
        throw new Error(
          `Policy ${tokenPolicyId} is not a dummy token: issuance_mint parameterised by ` +
            `dummy's issue logic hashes to ${issuanceMint.hash}.`
        );
      }

      const registrySpendAddr = scriptAddress(networkId, ctx.standardScripts.registrySpend.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registrySpendAddr));
      const node = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!node) throw new Error(`Registry node not found for policy ${tokenPolicyId}`);

      const paramsUtxo = await findParamsUtxo();
      const refs = [paramsUtxo, node];
      const nodeIdx = referenceInputIndexOf(refs.map(utxoToTxInput), utxoToTxInput(node));

      const plbHash = ctx.standardScripts.programmableLogicBase.hash;
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipient);

      let tx = client.newTx();
      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(hexToBytes(issueScript.hash)),
        amount: 0n,
        redeemer: Data.int(100n),
      });
      tx = tx.mintAssets({
        assets: mintAssetsFromMap(new Map([[unit, quantity]])),
        redeemer: mintingProofRefInput(nodeIdx),
      });
      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(1_300_000n, new Map([[unit, quantity]])),
        datum: new InlineDatum.InlineDatum({ data: voidData() }),
      });
      tx = tx.readFrom({ referenceInputs: refs });
      tx = tx.attachScript({ script: buildEvoScript(issuanceMint.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(issueScript.compiledCode) });

      return finish(tx, feePayerAddress, { tokenPolicyId, unit });
    },

    async burn(_params: BurnParams): Promise<UnsignedTx> {
      throw new Error(
        "dummy.burn: not implemented. register/mint/transfer are implemented; burn was never " +
          "written and is not in scope for W-D (PLAN.md T-D08)."
      );
    },

    async transfer(params: TransferParams): Promise<UnsignedTx> {
      const { senderAddress, recipientAddress, tokenPolicyId, assetName, quantity } = params;
      const unit = tokenPolicyId + assetName;
      const client = ctx.client;

      const plbHash = ctx.standardScripts.programmableLogicBase.hash;

      // 1. Build PLB addresses
      const senderPlbAddr = baseAddress(networkId, plbHash, senderAddress);
      const recipientPlbAddr = baseAddress(networkId, plbHash, recipientAddress);

      // 2. Find sender's token UTxOs
      const allUtxos = await client.getUtxos(EvoAddress.fromBech32(senderPlbAddr));
      const tokenUtxos = allUtxos.filter(u => utxoUnitQty(u, unit) > 0n);

      if (tokenUtxos.length === 0) {
        throw new Error(`No token UTxOs found at ${senderPlbAddr} for ${unit}`);
      }

      // 3. Select enough UTxOs
      const { selected, totalTokenAmount } = selectUtxosForAmount(tokenUtxos, unit, quantity);
      const returningAmount = totalTokenAmount - quantity;

      // 4. Find registry node reference input
      const registrySpendAddr = scriptAddress(networkId, ctx.standardScripts.registrySpend.hash);
      const registryUtxos = await client.getUtxos(EvoAddress.fromBech32(registrySpendAddr));
      const registryUtxo = findRegistryNode(registryUtxos, tokenPolicyId);
      if (!registryUtxo) {
        throw new Error(`Registry node not found for policy ${tokenPolicyId}`);
      }

      // 5. Get the coordination (protocol params) UTxO
      const protocolParamsUtxo = await findParamsUtxo();

      // 6. Reference-input indices, in the ledger's own order.
      //
      // Both indices below are POSITIONS the validator will resolve. Neither has
      // a type that can be wrong, and neither fails until the chain runs the
      // script — see src/core/ledger-order.ts.
      const refUtxos = [protocolParamsUtxo, registryUtxo];
      const refInputs = refUtxos.map(utxoToTxInput);
      const paramsIdx = referenceInputIndexOf(refInputs, utxoToTxInput(protocolParamsUtxo));
      const registryIdx = referenceInputIndexOf(refInputs, utxoToTxInput(registryUtxo));

      // 7. Withdrawal ordering. The set must be COMPLETE — every withdrawal the
      // final transaction carries occupies a slot, and script credentials sort
      // before key credentials regardless of hash.
      const coreTransferKey: WithdrawalKey = {
        hash: ctx.standardScripts.transfer.hash,
        isScript: true,
      };
      const allWithdrawals: WithdrawalKey[] = [
        { hash: transferScript.hash, isScript: true },
        coreTransferKey,
      ];
      const transferWdrlIdx = withdrawalIndexOf(allWithdrawals, coreTransferKey);

      const coreTransferRedeemer = transferRedeemer(paramsIdx, [
        { type: "exists", nodeIdx: registryIdx },
      ]);
      const dummyTransferRedeemer = Data.int(200n);
      // programmable_logic_base no longer takes an untyped redeemer: it dispatches
      // on the constructor, and witnesses WHERE its delegate's withdrawal sits.
      const spendRdmr = baseSpendRedeemer("TRANSFER", paramsIdx, transferWdrlIdx);
      const tokenDatum = voidData();

      // 8. Get sender's staking credential
      const senderStakingHash = stakingCredentialHash(senderAddress);

      // 9. Get sender's wallet UTxOs
      const senderWalletUtxos = await client.getUtxos(EvoAddress.fromBech32(senderAddress));

      // 10. Build transaction
      let tx = client.newTx();

      tx = tx.collectFrom({ inputs: senderWalletUtxos.slice(0, 2) });
      tx = tx.collectFrom({ inputs: selected, redeemer: spendRdmr });

      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(transferScript.hash, "hex"))),
        amount: 0n,
        redeemer: dummyTransferRedeemer,
      });

      tx = tx.withdraw({
        stakeCredential: Credential.makeScriptHash(new Uint8Array(Buffer.from(ctx.standardScripts.transfer.hash, "hex"))),
        amount: 0n,
        redeemer: coreTransferRedeemer,
      });

      if (returningAmount > 0n) {
        tx = tx.payToAddress({
          address: EvoAddress.fromBech32(senderPlbAddr),
          assets: outputAssets(1_300_000n, new Map([[unit, returningAmount]])),
          datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
        });
      }

      tx = tx.payToAddress({
        address: EvoAddress.fromBech32(recipientPlbAddr),
        assets: outputAssets(1_300_000n, new Map([[unit, quantity]])),
        datum: new InlineDatum.InlineDatum({ data: tokenDatum }),
      });

      tx = tx.readFrom({ referenceInputs: [protocolParamsUtxo, registryUtxo] });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.transfer.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(transferScript.compiledCode) });
      tx = tx.attachScript({ script: buildEvoScript(ctx.standardScripts.programmableLogicBase.compiledCode) });

      tx = tx.addSigner({ keyHash: KeyHash.fromHex(senderStakingHash) });

      // Build
      const result = await (tx as any).build({
        changeAddress: EvoAddress.fromBech32(senderAddress),
        availableUtxos: senderWalletUtxos,
      });

      const txObj = await result.toTransaction();
      const cbor = Transaction.toCBORHex(txObj);

      let txHash = "";
      if (typeof result.chainResult === "function") {
        txHash = result.chainResult().txHash;
      }

      // `_signBuilder` is internal but load-bearing: it is how seed-phrase
      // callers sign and submit, and register/mint already return it. Omitting
      // it here made transfer the only operation whose result could not be
      // submitted — surfacing as "Cannot read properties of undefined
      // (reading 'signAndSubmit')" at the CALL SITE, which reads as a caller
      // mistake rather than a missing field on the value it was handed.
      return { cbor, txHash, _signBuilder: result } as UnsignedTx;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectUtxosForAmount(
  utxos: EvoUTxO.UTxO[],
  unit: string,
  requiredAmount: bigint
): { selected: EvoUTxO.UTxO[]; totalTokenAmount: bigint } {
  const selected: EvoUTxO.UTxO[] = [];
  let total = 0n;

  for (const utxo of utxos) {
    const amount = utxoUnitQty(utxo, unit);
    if (amount <= 0n) continue;
    selected.push(utxo);
    total += amount;
    if (total >= requiredAmount) break;
  }

  if (total < requiredAmount) {
    throw new Error(`Insufficient token balance: have ${total}, need ${requiredAmount}`);
  }

  return { selected, totalTokenAmount: total };
}
