/**
 * Assemble the CIP-171 record for a deployment, from the parameterisation that
 * actually happened.
 *
 * DERIVED, NOT TRANSCRIBED. The events come from `createStandardScripts`'s
 * recorder, so the unapplied hashes and the application-order parameters are
 * the ones the deployment really used. A hand-written second list would agree
 * until it didn't, and the disagreement surfaces only as a hash that verifies
 * to nothing.
 *
 * ⚠ compilerVersion comes from the blueprint's OWN `preamble.compiler`, never
 * from `aiken --version`. Aiken is machine-global here and the artefacts
 * genuinely differ: this machine runs v1.1.9, the standard blueprint was built
 * with v1.1.23+8949565, the dummy blueprint with v1.1.21+42babe5. A record
 * naming the machine's compiler is a FALSE PROVENANCE CLAIM — the version is an
 * INPUT to the verifier's rebuild, so a wrong one yields a hash mismatch
 * attributed to us.
 */
import { readFileSync } from "node:fs";
import { Data } from "@evolution-sdk/evolution";
import { cip171Param, CompilerType } from "../../dist/index.js";
import type { ParameterizationEvent } from "../../dist/standard/scripts.js";

export interface Cip171Source {
  /** Directory of the blueprint being described, e.g. blueprints/standard/v0.5.0-alpha.2 */
  blueprintDir: string;
}

/** Read sourceUrl/commitHash/compilerVersion from the artefacts themselves. */
export function readProvenance(blueprintDir: string) {
  const pin = JSON.parse(readFileSync(`${blueprintDir}/UPSTREAM_PIN.json`, "utf8"));
  const bp = JSON.parse(readFileSync(`${blueprintDir}/plutus.json`, "utf8"));

  if (pin.provenance !== "VERIFIED") {
    throw new Error(
      `CIP-171 REFUSED for ${blueprintDir}: provenance is ${pin.provenance}, not VERIFIED.\n` +
        `A record is a permanent public claim that these scripts came from a named commit. ` +
        `Emitting one for an unverifiable blueprint is a false provenance claim, and unlike a ` +
        `file a metadatum cannot be deleted. Establish provenance first.`
    );
  }
  const compilerVersion = bp?.preamble?.compiler?.version;
  if (!compilerVersion) {
    throw new Error(`${blueprintDir}/plutus.json has no preamble.compiler.version`);
  }
  return {
    sourceUrl: pin.upstream.repo as string,
    commitHash: pin.upstream.commit as string,
    sourcePath: (pin.upstream.path as string) ?? "",
    compilerVersion: compilerVersion as string,
    env: (pin.upstream.env as string) ?? "",
  };
}

/**
 * Turn recorded parameterisations into CIP-171 script entries.
 *
 * `only` restricts the record to the validators actually deployed — the
 * recorder fires for every parameterisation, including ones built for
 * inspection and never put on chain.
 */
export function scriptEntriesFrom(
  events: ParameterizationEvent[],
  only?: string[]
): Array<{ rawScriptHash: string; params: string[] }> {
  const wanted = only ? events.filter((e) => only.includes(e.title)) : events;

  // Each raw script may appear at most once in the map (a CIP-171 limitation,
  // not ours). Two parameterisations of the same validator cannot both be
  // recorded — surface that rather than silently keeping one.
  const byHash = new Map<string, ParameterizationEvent[]>();
  for (const e of wanted) {
    const k = e.rawScriptHash.toLowerCase();
    byHash.set(k, [...(byHash.get(k) ?? []), e]);
  }
  const conflicts = [...byHash.entries()].filter(([, es]) => {
    if (es.length < 2) return false;
    const first = JSON.stringify(es[0]!.params.map(cip171Param));
    return es.some((e) => JSON.stringify(e.params.map(cip171Param)) !== first);
  });
  if (conflicts.length > 0) {
    throw new Error(
      `CIP-171: ${conflicts.length} raw script(s) parameterised more than once with DIFFERENT ` +
        `arguments — the format keys by unapplied hash, so only one can be recorded:\n` +
        conflicts
          .map(([h, es]) => `  ${h}: ${es.map((e) => e.title).join(", ")} (${es.length} instances)`)
          .join("\n") +
        `\nDecide which instance the record describes; do not let it be picked by iteration order.`
    );
  }

  return [...byHash.entries()].map(([rawScriptHash, es]) => ({
    rawScriptHash,
    params: es[0]!.params.map((p: Data.Data) => cip171Param(p)),
  }));
}

export function buildDeploymentRecord(
  blueprintDir: string,
  events: ParameterizationEvent[],
  only?: string[]
) {
  const p = readProvenance(blueprintDir);
  return {
    compilerType: CompilerType.AIKEN,
    sourceUrl: p.sourceUrl,
    commitHash: p.commitHash,
    sourcePath: p.sourcePath,
    compilerVersion: p.compilerVersion,
    env: p.env,
    scripts: scriptEntriesFrom(events, only),
  };
}
