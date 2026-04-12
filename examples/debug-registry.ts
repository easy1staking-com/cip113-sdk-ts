import "dotenv/config";
import { evoClient, preprodChain, EvoAddress, scriptAddress } from "@easy1staking/cip113-sdk-ts";

async function main() {
  const client = evoClient(preprodChain).withBlockfrost({
    projectId: process.env.BLOCKFROST_PROJECT_ID!,
    baseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
  }).withSeed({ mnemonic: process.env.WALLET_MNEMONIC! });

  const regAddr = scriptAddress(0, "116a5de7080ea7428a04aac13fa7e1c4d55544c019386b1dd91bfdef");
  console.log("Registry address:", regAddr);

  const utxos = await client.getUtxos(EvoAddress.fromBech32(regAddr));
  console.log("UTxOs found:", utxos.length);

  for (const u of utxos) {
    const raw = u as any;
    const datumOpt = raw.datumOption;
    console.log("\n--- UTxO ---");
    console.log("  datumOption:", datumOpt ? `_tag=${datumOpt._tag}` : "undefined");

    if (datumOpt?._tag === "InlineDatum") {
      const data = datumOpt.data;
      console.log("  data type:", typeof data);
      console.log("  data constructor:", data?.constructor?.name);
      console.log("  data._tag:", data?._tag);

      // Check if it's a Constr
      if (data?._tag === "Constr" || data?.constructor?.name === "Constr") {
        console.log("  data.index:", data.index);
        console.log("  data.fields length:", data.fields?.length);
        if (data.fields?.[0]) {
          const f0 = data.fields[0];
          console.log("  field[0] type:", typeof f0, f0?.constructor?.name);
          console.log("  field[0]._tag:", f0?._tag);
          // Try to get hex from it
          if (f0 instanceof Uint8Array) {
            console.log("  field[0] hex:", Buffer.from(f0).toString("hex"));
          } else if (typeof f0 === "object") {
            console.log("  field[0] keys:", Object.keys(f0));
            console.log("  field[0] JSON:", JSON.stringify(f0, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v).slice(0, 200));
          }
        }
      } else {
        // Not a Constr — log raw structure
        console.log("  data keys:", data ? Object.keys(data) : "N/A");
        console.log("  data JSON:", JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v).slice(0, 300));
      }
    }
  }
}

main().catch(console.error);
