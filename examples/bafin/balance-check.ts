import "dotenv/config";
import { evoClient, previewChain, EvoAddress, EvoAssets } from "@easy1staking/cip113-sdk-ts";

const c = evoClient(previewChain)
  .withBlockfrost({
    projectId: process.env.BLOCKFROST_PROJECT_ID!,
    baseUrl: "https://cardano-preview.blockfrost.io/api/v0",
  })
  .withSeed({ mnemonic: process.env.WALLET_MNEMONIC! });

const addr = await c.address();
console.log("addr :", EvoAddress.toBech32(addr));
const utxos = await c.getUtxos(addr);
const lovelace = utxos.reduce((s: bigint, u: any) => s + EvoAssets.lovelaceOf(u.assets), 0n);
console.log("utxos:", utxos.length);
console.log("ada  :", Number(lovelace) / 1e6);
