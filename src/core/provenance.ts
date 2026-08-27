/**
 * Assemble a CIP-171 record from a bundled blueprint's provenance pin.
 *
 * WHY THIS EXISTS. A record needs three things a consumer usually cannot get:
 * the source repo, the exact commit, and the compiler that built the artefact.
 * Those live in the `UPSTREAM_PIN.json` shipped beside each blueprint in this
 * package — and a backend that serves a blueprint over an API typically strips
 * the `preamble`, so the compiler is gone by the time the caller sees it.
 *
 * ⛔ THE ALTERNATIVE IS WORSE THAN IT LOOKS. Copying the repo/commit/compiler
 * triple into a consumer is not a shortcut, it is a SECOND COPY THAT DRIFTS
 * SILENTLY: the day this package ships a new blueprint, the copied triple still
 * encodes, still publishes, and still VERIFIES — against the wrong source. A
 * provenance record that is wrong and verifies is the worst artefact in this
 * whole area, because nothing downstream can detect it.
 *
 * ⇒ So the encoding lives where the knowledge lives.
 *
 * Browser-safe: reads no files, takes both inputs as arguments. Import the pin
 * as JSON via the `./blueprints/*` export path.
 */
import type { HexString, PlutusBlueprint } from "../types.js";
import type { Cip171Record } from "./cip171.js";
import { CompilerType, cip171Param } from "./cip171.js";
import { computeScriptHash } from "./evo-utils.js";
import type { Data } from "@evolution-sdk/evolution";

/** The shape of an `UPSTREAM_PIN.json` shipped beside a blueprint. */
export interface UpstreamPin {
  sha256: string;
  provenance: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  upstream: { repo: string; commit?: string | null; path?: string; env?: string };
  declares?: { title?: string; compiler?: string; validators?: number };
}

/** One parameterisation, as recorded by a script factory's `onParameterize`. */
export interface ParameterizedScript {
  rawScriptHash: HexString;
  params: Data.Data[];
}

/**
 * Provenance fields for a blueprint, GATED on the pin actually describing it.
 *
 * ⚠ THE GATE IS THE POINT. A pin and a blueprint that have drifted apart
 * produce a record that is well-formed, verifiable, and about the wrong
 * artefact. These checks are cheap, synchronous and need no network:
 *
 *   - the pin must be `VERIFIED` — a permanent public claim should not be made
 *     from a source nobody can reproduce
 *   - it must name a full 40-character commit — an abbreviation is one more
 *     thing that can drift, and a missing one names nothing fetchable
 *   - the blueprint's OWN `preamble.compiler` must match what the pin declares
 *   - the blueprint's title and validator count must match too
 *
 * ⛔ What this CANNOT check, stated rather than implied: that the commit is
 * still REACHABLE upstream. That needs the network, and a `provenance` field is
 * a claim while reachability is a fact. Assert it separately before publishing
 * — a squash-merge can orphan a commit that was reachable when the pin was
 * written, and the registry will fail with `reference is not a tree`.
 */
export function provenanceFromPin(
  blueprint: PlutusBlueprint,
  pin: UpstreamPin
): { sourceUrl: string; commitHash: HexString; sourcePath: string; compilerVersion: string; env: string } {
  const where = pin.upstream?.path ? `${pin.upstream.repo}/${pin.upstream.path}` : pin.upstream?.repo;

  if (pin.provenance !== "VERIFIED") {
    throw new Error(
      `CIP-171 REFUSED: ${where} is pinned "${pin.provenance}", not VERIFIED. A record is a ` +
        `permanent, public claim that these scripts came from a named commit; unlike a file, a ` +
        `metadatum cannot be deleted.`
    );
  }
  const commit = pin.upstream?.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(
      `CIP-171 REFUSED: ${where} pins commit ${JSON.stringify(commit)}, not a full 40-character ` +
        `sha. An abbreviation can drift; a missing commit names nothing a verifier can fetch.`
    );
  }

  const declared = pin.declares ?? {};
  const actualCompiler = blueprint?.preamble?.compiler;
  const actualCompilerStr = actualCompiler
    ? `${actualCompiler.name} ${actualCompiler.version}`
    : undefined;

  if (declared.compiler && actualCompilerStr && declared.compiler !== actualCompilerStr) {
    throw new Error(
      `CIP-171 REFUSED: this blueprint was built by "${actualCompilerStr}" but the pin describes ` +
        `"${declared.compiler}". The pin and the artefact have drifted — a record built from ` +
        `them would be well-formed, would verify, and would describe the wrong source.`
    );
  }
  if (declared.title && blueprint?.preamble?.title && declared.title !== blueprint.preamble.title) {
    throw new Error(
      `CIP-171 REFUSED: blueprint title "${blueprint.preamble.title}" does not match the pin's ` +
        `"${declared.title}". Wrong pin for this blueprint.`
    );
  }
  const n = blueprint?.validators?.length;
  if (typeof declared.validators === "number" && typeof n === "number" && declared.validators !== n) {
    throw new Error(
      `CIP-171 REFUSED: blueprint has ${n} validator entries, the pin describes ` +
        `${declared.validators}. The pin and the artefact have drifted.`
    );
  }
  if (!actualCompiler?.version) {
    throw new Error(
      `CIP-171 REFUSED: this blueprint has no preamble.compiler.version. Take the compiler from ` +
        `the ARTEFACT — never from the locally installed toolchain, which is frequently a ` +
        `different version and would make the record a false provenance claim.`
    );
  }

  return {
    sourceUrl: pin.upstream.repo,
    commitHash: commit.toLowerCase(),
    sourcePath: pin.upstream.path ?? "",
    // From the artefact, never from the environment.
    compilerVersion: actualCompiler.version,
    env: pin.upstream.env ?? "",
  };
}

/**
 * Build a complete CIP-171 record from a blueprint, its pin, and the
 * parameterisations that produced its deployed scripts.
 *
 * Feed `scripts` from a script factory's `onParameterize` recorder so the
 * record is DERIVED from the calls that actually parameterised, rather than
 * transcribed beside them — the map is keyed by the UNAPPLIED hash and its
 * values are in APPLICATION order, and both are properties of those calls.
 *
 * ⚠ Only scripts THIS deployment uses belong here. A validator the deployment
 * has no value for is legitimately absent; the registry reports it `PARTIAL`
 * because it enumerates every validator in the repo, not because you erred.
 */
export function buildCip171RecordFromPin(
  blueprint: PlutusBlueprint,
  pin: UpstreamPin,
  scripts: readonly ParameterizedScript[]
): Cip171Record {
  const p = provenanceFromPin(blueprint, pin);

  // ⛔ CONTENT GATE: every recorded script must EXIST IN THE BLUEPRINT THIS PIN
  // DESCRIBES.
  //
  // The identity checks above compare title, compiler and validator count —
  // enough to catch a wrong pin, NOT enough to catch a blueprint that shares a
  // preamble and differs in its compiled code. That case is the dangerous one:
  // the record would name the caller's real script hashes alongside OUR commit,
  // and it would verify against source that never produced them.
  //
  // ⇒ Pass the blueprint BUNDLED WITH THIS PACKAGE (import it via the
  // "./blueprints/*" path). Then a script parameterised from any other artefact
  // fails to appear here and is refused. Comparing file bytes is not an option:
  // an API that serves a blueprint typically strips the preamble, so the
  // original bytes cannot be reconstructed by the caller even in principle.
  const known = new Set<string>();
  for (const v of blueprint?.validators ?? []) {
    if (v?.compiledCode) known.add(computeScriptHash(v.compiledCode).toLowerCase());
  }
  const foreign = scripts
    .map((s) => s.rawScriptHash.toLowerCase())
    .filter((h) => !known.has(h));
  if (foreign.length > 0) {
    throw new Error(
      `CIP-171 REFUSED: ${foreign.length} recorded script(s) are NOT in the blueprint this pin ` +
        `describes — ${foreign.slice(0, 3).join(", ")}. They were parameterised from a different ` +
        `artefact, so a record naming this commit would verify against source that never ` +
        `produced them. Pass the blueprint bundled with this package.`
    );
  }

  return {
    compilerType: CompilerType.AIKEN,
    ...p,
    scripts: scripts.map((s) => ({
      rawScriptHash: s.rawScriptHash,
      // Bytestring-wrapped, NOT inline PlutusData. Inline is not rejected — the
      // registry reads `.bytes`, gets nothing, and stores a record whose
      // parameters have silently vanished while it still verifies.
      params: s.params.map((d) => cip171Param(d)),
    })),
  };
}
