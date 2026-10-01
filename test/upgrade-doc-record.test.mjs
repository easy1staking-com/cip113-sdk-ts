/**
 * The upgrade-lifecycle doc is a claim about a public chain, so its facts are
 * pinned to the record they came from.
 *
 * ⛔ WHY THIS FILE EXISTS, AND IT IS NOT HYPOTHETICAL. The first draft of
 * `docs/upgrade-lifecycle.md` stated a `protocol_params` policy id that was
 * INVENTED — a plausible 56-hex string that belonged to nothing. It was caught
 * by diffing the doc against the campaign record, not by reading it: a wrong
 * hash looks exactly like a right one. A document whose whole value is "every
 * claim is a hash you can look up" fails completely the moment one hash is
 * wrong, and nothing about reading it would reveal which.
 *
 * ⚠ WHAT THIS DOES AND DOES NOT PROVE. It proves the doc AGREES WITH THE
 * RECORD. It does not prove either is true of the chain — that is what the
 * transaction hashes are for, and a reader checking them is the only thing that
 * establishes it. This is a consistency check between two artefacts in this
 * repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { scriptAddress } from "../dist/core/evo-utils.js";

const DOC = readFileSync(new URL("../docs/upgrade-lifecycle.md", import.meta.url), "utf8");
const RECORD = JSON.parse(
  readFileSync(new URL("../deployments/preview/upgrade-lifecycle-record.json", import.meta.url), "utf8"),
);
const DEPLOYMENT = JSON.parse(
  readFileSync(new URL("../deployments/preview/upgrade-lifecycle.json", import.meta.url), "utf8"),
);
const PIN = JSON.parse(
  readFileSync(new URL("../blueprints/standard/v0.0.1/UPSTREAM_PIN.json", import.meta.url), "utf8"),
);

test("every transaction in the campaign record appears in the doc", () => {
  const missing = RECORD.transactions.filter((t) => !DOC.includes(t.txHash));
  assert.deepEqual(
    missing.map((t) => `${t.n}. ${t.step}`),
    [],
    "a transaction the campaign submitted but the doc does not cite is a gap in the evidence",
  );
  assert.equal(RECORD.transactions.length, 12, "the campaign is twelve transactions");
});

test("every 56+-hex string in the doc is traceable to the record, the deployment, or the pin", () => {
  // ⛔ THE CHECK THAT CAUGHT THE FABRICATED POLICY ID. Any long hex in the doc
  // must come from an artefact, not from prose.
  const haystack = (JSON.stringify(RECORD) + JSON.stringify(DEPLOYMENT) + JSON.stringify(PIN)).toLowerCase();
  const inDoc = [...new Set(DOC.match(/\b[0-9a-f]{56,64}\b/g) ?? [])];
  assert.ok(inDoc.length > 15, `sanity: the doc should cite many hashes; found ${inDoc.length}`);
  const orphans = inDoc.filter((h) => !haystack.includes(h));
  assert.deepEqual(orphans, [], "a hash in the doc that no artefact contains is unverifiable, and may be invented");
});

test("the addresses in the doc ARE the script hashes it cites — the claim the doc makes about them", () => {
  // One hash, two roles: the NFT policy id and the address's payment credential
  // are the same value by the validators' construction. The doc tells a reader
  // they can check the addresses without trusting any mapping; this is that
  // check, run.
  const pairs = [
    [DEPLOYMENT.protocolParams.policyId, RECORD.protocolParamsAddress],
    [RECORD.upgradeMultisigAtBootstrap, RECORD.upgradeMultisigAddress],
    [RECORD.nomineeAuthority.scriptHash, RECORD.nomineeAuthority.address],
  ];
  for (const [hash, address] of pairs) {
    assert.equal(scriptAddress(0, hash), address, `${hash} must derive ${address}`);
    assert.ok(DOC.includes(address), "and the doc must cite that address");
    assert.ok(DOC.includes(hash), "and the hash beside it");
  }
});

test("the doc does NOT claim the refusals are verifiable on chain", () => {
  // ⛔ THE HONESTY RAIL. A refused transaction has no hash and no trace, so a
  // doc presenting refusals as verified would be the "proportionate
  // scepticism" failure this repo's own constitution warns about.
  assert.match(DOC, /A refused transaction leaves no trace on chain/);
  assert.match(DOC, /not.*claimed here as independently verifiable/i);
});

test("the doc states CIP-171 is a claim, not the provenance proof", () => {
  // The most valuable correction gate 3 produced: a CIP-171 record is metadata
  // the submitter writes. If the doc leans on it, its strongest-sounding claim
  // is its weakest.
  assert.match(DOC, /CIP-171 is not the answer/);
  assert.match(DOC, /metadata the\s+\*\*submitter writes\*\*/);
  assert.ok(DOC.includes(PIN.sha256), "and cites the reproducible-build hash that IS the proof");
  assert.ok(DOC.includes(PIN.upstream.commit), "pinned to the commit, not the tag");
});

test("the round trip the doc claims is the one the record recorded", () => {
  assert.equal(RECORD.roundTripByteExact, true, "the restored datum equalled genesis");
  assert.match(DOC, /byte-for-byte\s+identical to the genesis datum/);
});

test("the doc does not claim the instance is beyond anyone's control", () => {
  // ⚠ An earlier draft of the epic did claim that, and it was false: every
  // signer is derived from the funding wallet's own mnemonic.
  assert.match(
    DOC,
    /accounts of the\s+wallet that funded the instance/,
    "the doc must say whose keys these are",
  );
  assert.match(DOC, /makes no claim that the instance is beyond anyone's control/);
});
