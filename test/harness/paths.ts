import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function dummyBlueprintPath(): string {
  return resolve(ROOT, "blueprints/substandards/dummy/v0.2.0/plutus.json");
}

/** standard/v0.3.0 — PERMANENTLY UNVERIFIED, so it is a durable negative fixture. */
export function standardV030Dir(): string {
  return resolve(ROOT, "blueprints/standard/v0.3.0");
}

/** The dummy blueprint's DIRECTORY. */
export function dummyBlueprintDir(): string {
  return resolve(ROOT, "blueprints/substandards/dummy/v0.2.0");
}

export function fesBlueprintPath(): string {
  return resolve(ROOT, "blueprints/substandards/freeze-and-seize/v0.1.0/plutus.json");
}

/** The FES blueprint's DIRECTORY — provenance lives beside plutus.json in UPSTREAM_PIN.json. */
export function fesBlueprintDir(): string {
  return resolve(ROOT, "blueprints/substandards/freeze-and-seize/v0.1.0");
}
