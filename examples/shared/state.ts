import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, "..", ".state.json");

export interface ExampleState {
  // From 00-setup
  adminAddress?: string;
  adminPkh?: string;

  // From 01-init-compliance
  blacklistNodePolicyId?: string;
  blacklistInitTxInput?: { txHash: string; outputIndex: number };
  initComplianceTxHash?: string;

  // From 02-register
  tokenPolicyId?: string;
  assetName?: string;
  assetNameHex?: string;
  registerTxHash?: string;

  // From 06-freeze
  frozenAddress?: string;

  // General
  [key: string]: unknown;
}

export function loadState(): ExampleState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveState(state: ExampleState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(patch: Partial<ExampleState>): void {
  const current = loadState();
  saveState({ ...current, ...patch });
}

export function requireState<K extends keyof ExampleState>(
  state: ExampleState,
  ...keys: K[]
): void {
  const missing = keys.filter((k) => !state[k]);
  if (missing.length > 0) {
    console.error(`Missing state fields: ${missing.join(", ")}`);
    console.error("Run the prerequisite scripts first (see README).");
    process.exit(1);
  }
}
