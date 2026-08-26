import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function dummyBlueprintPath(): string {
  return resolve(ROOT, "blueprints/substandards/dummy/v0.2.0/plutus.json");
}

export function fesBlueprintPath(): string {
  return resolve(ROOT, "blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json");
}

/** The FES blueprint's DIRECTORY — provenance lives beside plutus.json in UPSTREAM_PIN.json. */
export function fesBlueprintDir(): string {
  return resolve(ROOT, "blueprints/substandards/freeze-and-seize/v0.1.0");
}
