/**
 * The named refusal for "this token is not in the directory I am reading" —
 * ONE message, every site that looks a token up in the registry.
 *
 * ⛔ WHAT THIS EXISTS TO SAY, AND WHY THE OLD MESSAGE COULD NOT SAY IT. Seven
 * call sites threw `Registry node not found for <policyId>`. That sentence is
 * TRUE and names only the symptom, so it reads as "your token does not exist"
 * — and the far more likely cause on a protocol that has been re-bootstrapped
 * is that the token exists perfectly well IN A DIFFERENT DEPLOYMENT'S
 * DIRECTORY.
 *
 * ⛔ WHY THAT HAPPENS AND WHY NOTHING WARNS YOU. A programmable token's policy
 * id IS the hash of `issuance_mint` parameterised by the deployment it was
 * minted under. The token is therefore DEPLOYMENT-BOUND: its registry node
 * lives in that deployment's directory, and freeze-and-seize's `transfer`
 * credential derives from that deployment's `programmable_logic_base` hash.
 * Stand up a new protocol instance and the new directory does not contain it —
 * not because anything is broken, but because it is a different directory.
 * There is no repointing.
 *
 * ⚠ HOW THIS PRESENTS IN THE FIELD (observed 2026-09-30, CIP-113 on preprod): a
 * backend served exactly one deployment record, a re-bootstrap REPLACED it, and
 * every token minted under the previous record became absent from the served
 * directory. Both an SDK caller and an independent Java caller then failed on
 * the same token for the same reason, which looks like two defects and is one
 * configuration fact.
 *
 * ⚠ AND WHAT THIS MESSAGE MUST NOT CLAIM: an absent node is ALSO what indexer
 * lag looks like, and what a genuinely unregistered token looks like. All three
 * readings are stated; none is asserted. The SDK cannot tell them apart from a
 * single directory read, and a message that picked one would be wrong a third
 * of the time with total confidence.
 */

import type { HexString } from "../types.js";

/**
 * The token's own node is missing — the lookup every operation but `register`
 * performs.
 *
 * @param operation       e.g. `"freeze-and-seize.transfer"`
 * @param tokenPolicyId   the policy the caller asked to operate
 * @param registryAddress the directory address actually read
 * @param nodesRead       how many nodes that read returned — an EMPTY directory
 *                        and a directory that merely lacks this token are
 *                        different diagnoses, and the count is what separates
 *                        them
 */
export function registryNodeMissingError(params: {
  operation: string;
  tokenPolicyId: HexString;
  registryAddress: string;
  nodesRead: number;
}): Error {
  const { operation, tokenPolicyId, registryAddress, nodesRead } = params;
  const emptiness =
    nodesRead === 0
      ? `That directory read returned NO NODES AT ALL, not even an origin node — so either ` +
        `this deployment was never bootstrapped, or the address above belongs to a different ` +
        `deployment, or the read itself is stale.`
      : `That directory holds ${nodesRead} node(s), so it is populated and this token is ` +
        `simply not among them.`;

  return new Error(
    `${operation}: token policy ${tokenPolicyId} has NO REGISTRY NODE in the directory this ` +
      `deployment serves at ${registryAddress}. ${emptiness}\n` +
      `THREE READINGS, and this SDK cannot tell them apart from one directory read:\n` +
      `  1. The token was never registered under this deployment — call register first.\n` +
      `  2. The token belongs to a DIFFERENT DEPLOYMENT. A programmable token's policy id is ` +
      `the hash of issuance_mint parameterised by its deployment's protocol params, so the ` +
      `token is deployment-bound: re-bootstrapping the protocol produces a new directory that ` +
      `does not contain it, and there is no repointing. Operate it under the DeploymentParams ` +
      `it was minted under, or mint a fresh token under this one — ADA locked in the old ` +
      `token's outputs stays there.\n` +
      `  3. The directory read is behind the chain. Re-read before concluding anything.\n` +
      `⚠ Reading (2) is invisible to every other check: the token exists, its outputs exist, ` +
      `and every credential this transaction derives is correct FOR THE OTHER DEPLOYMENT.`
  );
}

/**
 * `register`'s lookup is different and so is its diagnosis: it needs the node
 * that BRACKETS the new policy id, and in a bootstrapped directory the origin
 * node brackets everything. So an absent covering node never means "this token
 * is missing" — it means the directory is not one this deployment bootstrapped.
 */
export function coveringRegistryNodeMissingError(params: {
  operation: string;
  tokenPolicyId: HexString;
  registryAddress: string;
  nodesRead: number;
}): Error {
  const { operation, tokenPolicyId, registryAddress, nodesRead } = params;
  return new Error(
    `${operation}: no registry node BRACKETS the new token policy ${tokenPolicyId} in the ` +
      `directory at ${registryAddress} (${nodesRead} node(s) read). Insertion needs a node with ` +
      `key < policyId < next, and a bootstrapped directory always has one, because its origin ` +
      `node spans the whole range.\n` +
      `So this is NOT a fact about your token. Either this deployment's protocol bootstrap never ` +
      `completed — the registry origin node is minted by it — or the address above is derived ` +
      `from a different deployment's registry script hash, or the read is stale.\n` +
      `${nodesRead === 0 ? "The read returned NO nodes, which is consistent with all three." : "The read returned nodes, so check their (key, next) bounds for a gap spanning this policy id."}`
  );
}
