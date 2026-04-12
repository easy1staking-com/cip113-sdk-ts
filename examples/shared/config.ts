import "dotenv/config";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  evoClient,
  preprodChain,
  previewChain,
  mainnetChain,
  paymentCredentialHash,
  EvoAddress,
  type PlutusBlueprint,
} from "@easy1staking/cip113-sdk-ts";
import type { DeploymentParams } from "@easy1staking/cip113-sdk-ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function getEnv(key: string, required = true): string {
  const val = process.env[key];
  if (!val && required) {
    console.error(`Missing required env var: ${key}`);
    console.error("Copy .env.example to .env and fill in your values.");
    process.exit(1);
  }
  return val ?? "";
}

export function getNetwork() {
  return (getEnv("NETWORK", false) || "preprod") as "preprod" | "preview" | "mainnet";
}

function getChain() {
  const n = getNetwork();
  if (n === "preview") return previewChain;
  if (n === "mainnet") return mainnetChain;
  return preprodChain;
}

// ---------------------------------------------------------------------------
// Evolution SDK Client
// ---------------------------------------------------------------------------

export function createSigningClient(mnemonic?: string) {
  const chain = getChain();
  const network = getNetwork();
  const projectId = getEnv("BLOCKFROST_PROJECT_ID");
  const baseUrl =
    getEnv("BLOCKFROST_URL", false) ||
    `https://cardano-${network}.blockfrost.io/api/v0`;

  const seed = mnemonic || getEnv("WALLET_MNEMONIC");

  return evoClient(chain)
    .withBlockfrost({ projectId, baseUrl })
    .withSeed({ mnemonic: seed });
}

export function createSecondClient() {
  const second = getEnv("SECOND_WALLET_MNEMONIC", false);
  if (!second) return null;
  return createSigningClient(second);
}

export async function getWalletAddress(client: ReturnType<typeof createSigningClient>): Promise<string> {
  const addr = await client.address();
  return EvoAddress.toBech32(addr);
}

export function getAdminPkh(address: string): string {
  return paymentCredentialHash(address);
}

// ---------------------------------------------------------------------------
// Blueprints
// ---------------------------------------------------------------------------

function loadJson(relativePath: string): PlutusBlueprint {
  const fullPath = resolve(__dirname, "..", "..", relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

export function loadStandardBlueprint(): PlutusBlueprint {
  return loadJson("blueprints/standard/v0.3.0/plutus.json");
}

export function loadFESBlueprint(): PlutusBlueprint {
  return loadJson("blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json");
}

export function loadDummyBlueprint(): PlutusBlueprint {
  return loadJson("blueprints/substandards/dummy/v0.1.0/plutus.json");
}

// ---------------------------------------------------------------------------
// Deployment Params
// ---------------------------------------------------------------------------

export { PREPROD_DEPLOYMENT } from "./deployment-preprod.js";

export function getTokenName(): string {
  const custom = getEnv("TOKEN_NAME", false);
  if (custom) return custom;
  // Generate a unique name per run so repeated runs don't collide
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `DEMO-${ts}`;
}

/**
 * Check if a stake address is registered on-chain via Blockfrost.
 * Used as `checkStakeRegistration` callback for CIP113.init().
 */
export async function checkStakeRegistration(stakeAddress: string): Promise<boolean> {
  const projectId = getEnv("BLOCKFROST_PROJECT_ID");
  const network = getNetwork();
  const baseUrl =
    getEnv("BLOCKFROST_URL", false) ||
    `https://cardano-${network}.blockfrost.io/api/v0`;

  try {
    const res = await fetch(`${baseUrl}/accounts/${stakeAddress}`, {
      headers: { project_id: projectId },
    });
    return res.ok; // 200 = registered, 404 = not registered
  } catch {
    return false;
  }
}
