import type { Chain } from "@evolution-sdk/evolution";

const DEFAULT_ADMIN_URL = "http://localhost:10000";

function adminBaseUrl(): string {
  return process.env.YACI_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

interface ShelleyGenesis {
  systemStart: string;
  slotLength: number;
  epochLength: number;
  networkMagic: number;
  networkId?: "Testnet" | "Mainnet";
}

let cachedChain: Chain | null = null;

export async function getYaciChain(): Promise<Chain> {
  if (cachedChain) return cachedChain;

  const url = `${adminBaseUrl()}/local-cluster/api/admin/devnet/genesis/shelley`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Yaci shelley genesis from ${url}: ${resp.status} ${resp.statusText}. Is yaci-devkit running? (YACI_ADMIN_URL=${adminBaseUrl()})`,
    );
  }
  const genesis = (await resp.json()) as ShelleyGenesis;

  const zeroTime = BigInt(Date.parse(genesis.systemStart));
  const slotLength = Math.round(genesis.slotLength * 1000);

  cachedChain = {
    id: genesis.networkId === "Mainnet" ? 1 : 0,
    name: "Yaci DevKit",
    networkMagic: genesis.networkMagic,
    epochLength: genesis.epochLength,
    slotConfig: { zeroTime, zeroSlot: 0n, slotLength },
  };
  return cachedChain;
}

export async function topupAddress(address: string, lovelace: bigint): Promise<void> {
  const adaAmount = Number(lovelace / 1_000_000n);
  const url = `${adminBaseUrl()}/local-cluster/api/addresses/topup`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, adaAmount }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Topup failed for ${address} (${adaAmount} ADA) via ${url}: ${resp.status} ${resp.statusText} ${body}`,
    );
  }
}

export async function resetDevnet(): Promise<void> {
  const url = `${adminBaseUrl()}/local-cluster/api/admin/devnet/reset`;
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`Reset failed via ${url}: ${resp.status} ${resp.statusText}`);
  }
  cachedChain = null;
}
