/**
 * Devnet connectivity — the foundation every other devnet test stands on.
 *
 * Proves the harness can reach a real chain, derive a wallet, fund it, and
 * observe the funding land. If this fails, nothing downstream is meaningful.
 *
 * There is deliberately no skip path: see test/harness/yaci.mjs for why.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { Address as EvoAddress } from "@evolution-sdk/evolution";
import {
  requireDevnet,
  getYaciChain,
  topupAddress,
  latestBlock,
  makeClient,
  waitFor,
} from "../harness/yaci.mjs";

before(async () => {
  // Fails the whole file loudly rather than skipping it.
  await requireDevnet();
});

test("admin API and store are both live", async () => {
  const block = await latestBlock();
  assert.ok(Number(block.height) > 0, "chain should have produced blocks");
  assert.ok(Number(block.slot) >= 0);
});

test("chain config is derived from the devnet's own genesis", async () => {
  const chain = await getYaciChain();

  assert.equal(chain.id, 0, "devnet must be a testnet");
  assert.ok(chain.networkMagic > 0, "networkMagic should be set");
  assert.ok(chain.epochLength > 0, "epochLength should be set");
  assert.ok(chain.slotConfig.zeroTime > 0n, "zeroTime must come from systemStart");
  assert.ok(chain.slotConfig.slotLength > 0, "slotLength must be milliseconds");

  // Hardcoding these would be the bug this function exists to avoid: a reset
  // changes systemStart, so a stale zeroTime silently corrupts every TTL.
  const before = chain.slotConfig.zeroTime;
  const again = await getYaciChain();
  assert.equal(again.slotConfig.zeroTime, before, "genesis read must be stable within a run");
});

test("a wallet can be derived, funded, and the funding observed on-chain", async () => {
  const client = await makeClient();

  // getUtxos must be given the Address OBJECT, not a bech32 string. Kupmios
  // checks `instanceof Address` and otherwise reads `.hash`, so a string
  // silently produces the URL /matches/undefined/*?unspent and the whole call
  // fails as an opaque "Kupmios getUtxos failed". Keep the object.
  const addressObj = await client.address();
  const address = EvoAddress.toBech32(addressObj);

  assert.ok(
    address.startsWith("addr_test"),
    `expected a testnet address, got ${address.slice(0, 20)}...`
  );

  // Deliberately NOT wrapped in .catch(() => []). An earlier draft swallowed
  // provider errors here and the test failed as a 90s timeout with "Last: null",
  // hiding the real cause. A provider that errors must fail loudly, not read
  // as "no UTxOs yet".
  const beforeCount = (await client.getUtxos(addressObj)).length;

  await topupAddress(address, 10_000);

  const after = await waitFor(
    async () => {
      const utxos = await client.getUtxos(addressObj);
      return utxos.length > beforeCount ? utxos : null;
    },
    { timeoutMs: 90_000, what: "topup to appear in the wallet's UTxO set" }
  );

  assert.ok(after.length > beforeCount, "topup should have produced a new UTxO");

  const total = after.reduce((sum, u) => {
    const lovelace = u.assets?.lovelace ?? 0n;
    return sum + BigInt(lovelace);
  }, 0n);
  assert.ok(total > 0n, "funded wallet should hold a positive lovelace balance");
});
