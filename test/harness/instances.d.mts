/**
 * Types for `instances.mjs`.
 *
 * The module is `.mjs` on purpose — `npm test` globs only `test/*.test.mjs` and
 * the harness is never compiled to `dist`, so a `.ts` module here would be
 * untestable, and a test file the runner does not match is INVISIBLE rather
 * than skipped.
 *
 * ⚠ The cost of that choice is that `.ts` callers get no types from a bare
 * `.mjs` import — which is exactly the pre-existing `yaci.mjs` gap this repo
 * already carries. This file pays that cost for `instances.mjs` rather than
 * enlarging the gap: `npm run typecheck:harness` surfaced two new errors of the
 * yaci.mjs class the moment the instrument existed, and they were mine.
 */

export type InstanceNetwork = "preview" | "devnet";

/** Path of one named instance's record. Throws on a name that is not filename-safe. */
export declare function instancePath(network: InstanceNetwork, name: string): string;

/** Names of every recorded instance on a network, sorted. */
export declare function listInstances(network: InstanceNetwork): string[];

/** Load one instance's DeploymentParams. Throws naming what IS available. */
export declare function loadInstance(network: InstanceNetwork, name: string): unknown;

/**
 * Write one instance's DeploymentParams.
 *
 * Refuses to clobber unless `overwrite` is set — a deployment record cannot be
 * regenerated, because its bootstrap seed UTxOs are one-shot and already spent.
 */
export declare function saveInstance(
  network: InstanceNetwork,
  name: string,
  deployment: unknown,
  opts?: { overwrite?: boolean },
): string;

/**
 * Resolve the instance from `--instance <name>` or `CIP113_INSTANCE`.
 *
 * Throws if neither is given. There is deliberately no default: a default is
 * how a second deployment silently overwrote the first.
 */
export declare function requireInstanceName(
  network: InstanceNetwork,
  argv?: string[],
): string;
