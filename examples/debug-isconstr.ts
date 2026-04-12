import "dotenv/config";
import { evoClient, preprodChain, EvoAddress, EvoData, scriptAddress } from "@easy1staking/cip113-sdk-ts";
import * as Data from "@evolution-sdk/evolution/Data";
import * as Bytes from "@evolution-sdk/evolution/Bytes";

async function main() {
  const client = evoClient(preprodChain).withBlockfrost({
    projectId: process.env.BLOCKFROST_PROJECT_ID!,
    baseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
  }).withSeed({ mnemonic: process.env.WALLET_MNEMONIC! });

  const regAddr = scriptAddress(0, "116a5de7080ea7428a04aac13fa7e1c4d55544c019386b1dd91bfdef");
  const utxos = await client.getUtxos(EvoAddress.fromBech32(regAddr));

  // Take the last UTxO (our token a3a682...)
  const u = utxos[utxos.length - 1] as any;
  const datum = u.datumOption?.data;

  console.log("Data.isConstr(datum):", Data.isConstr(datum));
  console.log("Data.isBytes(datum.fields[0]):", Data.isBytes(datum.fields[0]));
  console.log("Bytes.toHex(datum.fields[0]):", Bytes.toHex(datum.fields[0]));

  // Now test extractConstrBytesField logic manually
  if (Data.isConstr(datum)) {
    const constr = datum as unknown as { index: bigint; fields: readonly any[] };
    const field = constr.fields[0];
    if (Data.isBytes(field)) {
      const hex = Bytes.toHex(field as unknown as Uint8Array);
      console.log("\nextractConstrBytesField result:", hex);
      console.log("Matches a3a682...?", hex === "a3a682c10bb783f5826c7d5d2f76362cd98a3f43211b0f66359e330b");
    }
  }
}

main().catch(console.error);
