import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function dummyBlueprintPath(): string {
  return resolve(ROOT, "blueprints/substandards/dummy/v0.1.0/plutus.json");
}
