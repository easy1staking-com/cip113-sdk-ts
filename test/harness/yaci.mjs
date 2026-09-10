/**
 * Yaci DevKit harness — devnet lifecycle and client wiring.
 *
 * Salvaged and reworked from the abandoned bafin branch (examples/shared/yaci.ts).
 *
 * DESIGN NOTE — why devnet tests live in test/devnet/ and are NOT part of `npm test`:
 * the previous holder of this machine's devnet had a 5-test suite that silently
 * SKIPPED for weeks because the store hung, and a skipped suite reads like a
 * passing one at a glance. So there is no skip path here. `npm test` runs
 * offline unit tests only; `npm run test:devnet` requires a devnet and fails
 * loudly when there isn't one. A run either happened or it errored — never
 * "quietly did nothing".
 *
 * Ports are DevKit defaults and are not configurable (cluster-info.json is
 * regenerated on every `up`): 10000 admin, 8080 store, 3001 node, 1337 ogmios,
 * 8090 submit. Note this is the inverse of some documentation, which has admin
 * and store swapped — verified on this machine: yaci-cli serves admin on 10000.
 */

import { Client } from "@evolution-sdk/evolution";

export const ADMIN_URL = process.env.YACI_ADMIN_URL ?? "http://localhost:10000";
export const STORE_URL = process.env.YACI_STORE_URL ?? "http://localhost:8080/api/v1";
export const OGMIOS_URL = process.env.OGMIOS_URL ?? "http://localhost:1337";
export const KUPO_URL = process.env.KUPO_URL ?? "http://localhost:1442";

const ADMIN = `${ADMIN_URL}/local-cluster/api`;

/**
 * A fixed BIP39 test phrase. Valid, canonical, and worthless — the all-"abandon"
 * vector every wallet library ships in its own tests. Devnet only; never reuse.
 */
export const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

async function fetchJson(url, init, timeoutMs = 15_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal });
    if (!resp.ok) {
      // Include the BODY. Yaci's admin API returns a 500 with an empty
      // statusText and puts the only useful information — e.g. {"status":false,
      // "message":"Topup failed"} — in the body. Without this the error reads
      // as "the API is broken" when it actually means "your request was
      // rejected", and the two lead to completely different investigations.
      let body = "";
      try {
        body = (await resp.text()).slice(0, 500);
      } catch {
        body = "(body unreadable)";
      }
      throw new Error(
        `${init?.method ?? "GET"} ${url} -> ${resp.status} ${resp.statusText}` +
          (body ? `\n  body: ${body}` : "")
      );
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Assert a usable devnet is present. Checks BOTH the admin API and the store,
 * because they fail independently: this machine's inherited cluster answered
 * admin normally on :10000 while the store on :8080 hung indefinitely. A green
 * admin API is proof of nothing on its own.
 */
export async function requireDevnet() {
  const problems = [];

  try {
    await fetchJson(`${ADMIN}/admin/devnet/genesis/shelley`, undefined, 8_000);
  } catch (e) {
    problems.push(`admin API (${ADMIN_URL}): ${e.message}`);
  }

  try {
    await fetchJson(`${STORE_URL}/blocks/latest`, undefined, 8_000);
  } catch (e) {
    problems.push(`store (${STORE_URL}): ${e.message}`);
  }

  // Kupo and Ogmios are what the SDK client actually talks to, so a devnet
  // without them is unusable here even when admin and store look fine.
  try {
    // /health serves Prometheus metrics, not JSON — status is the signal.
    const resp = await fetch(`${KUPO_URL}/health`, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  } catch (e) {
    problems.push(`kupo (${KUPO_URL}): ${e.message} — start it with local-clusters/default/kupo.sh`);
  }

  try {
    const resp = await fetch(OGMIOS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip", id: null }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  } catch (e) {
    problems.push(`ogmios (${OGMIOS_URL}): ${e.message}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `No usable Yaci devnet.\n  ${problems.join("\n  ")}\n\n` +
      `Start one with:  npx --yes @bloxbean/yaci-devkit up --enable-yaci-store\n` +
      `If it is running but the store hangs, reset the cluster — that is a known\n` +
      `failure mode and a reset fixes it:\n` +
      `  curl -X POST ${ADMIN}/admin/devnet/reset`
    );
  }
}

/** Build an Evolution SDK Chain from the devnet's own Shelley genesis. */
export async function getYaciChain() {
  const g = await fetchJson(`${ADMIN}/admin/devnet/genesis/shelley`);
  return {
    id: g.networkId === "Mainnet" ? 1 : 0,
    name: "Yaci DevKit",
    networkMagic: g.networkMagic,
    epochLength: g.epochLength,
    slotConfig: {
      zeroTime: BigInt(Date.parse(g.systemStart)),
      zeroSlot: 0n,
      slotLength: Math.round(g.slotLength * 1000),
    },
  };
}

/** Fund an address. Amount in ADA, not lovelace — the admin API takes ADA. */
export async function topupAddress(address, ada) {
  await fetchJson(`${ADMIN}/addresses/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, adaAmount: Number(ada) }),
  });
}

/** Wipe the cluster back to genesis. Destructive; the machine has exactly one. */
export async function resetDevnet() {
  await fetchJson(`${ADMIN}/admin/devnet/reset`, { method: "POST" }, 90_000);
}

/** Latest block as the store sees it. */
export async function latestBlock() {
  return fetchJson(`${STORE_URL}/blocks/latest`);
}

/**
 * A signing client pointed at the devnet, via Kupmios (Kupo + Ogmios).
 *
 * NOT Blockfrost, despite Yaci Store exposing a Blockfrost-compatible REST API
 * on :8080. That path does not work with this SDK: Evolution's BlockfrostUTxO
 * schema requires `tx_index` and `block`, and Yaci Store returns neither (it
 * sends `epoch`/`block_number`/`block_time` instead), so every getUtxos fails
 * schema validation and surfaces only as "Blockfrost getUtxos failed".
 * Evolution exposes no custom-provider hook — Blockfrost, Koios, Kupmios and
 * Maestro are the whole set — so Kupmios is the only workable devnet wiring.
 *
 * Kupo is NOT started by `--enable-kupomios`; see docs/devnet.md.
 */
export async function makeClient(mnemonic = TEST_MNEMONIC) {
  const chain = await getYaciChain();
  return Client.make(chain)
    .withKupmios({ kupoUrl: KUPO_URL, ogmiosUrl: OGMIOS_URL })
    .withSeed({ mnemonic });
}

/** Poll until `fn()` returns truthy, or throw. For waiting on chain state. */
export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 1_000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}. Last: ${JSON.stringify(last)}`);
}

/**
 * Wait until the provider's view of a wallet stops changing.
 *
 * Kupo and yaci-store trail the node, so immediately after a confirmed
 * transaction `getUtxos` still reports inputs the node knows are spent — and the
 * NEXT transaction built from that view is rejected with code 3117, "unknown
 * UTxO references as inputs". That error names a UTxO and reads as a malformed
 * transaction; the builder faithfully used what it was told.
 *
 * Two consecutive IDENTICAL reads is the cheap proxy for "settled": a single
 * read cannot distinguish a settled view from a stale one.
 *
 * ⚠ Call this after EVERY submit that a later transaction depends on. The
 * bootstrap does it internally at entry and exit; anything chaining operations
 * in a test has to do it between them.
 */
export async function settleWallet(client, addressObj, { attempts = 20, intervalMs = 1000 } = {}) {
  const fingerprint = async () => {
    const utxos = await client.getUtxos(addressObj);
    return utxos
      .map((u) => `${u.transactionId?.hash ? "" : ""}${JSON.stringify(u.transactionId)}#${u.index}`)
      .sort()
      .join(",");
  };
  let previous = await fingerprint();
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const current = await fingerprint();
    if (current === previous) return;
    previous = current;
  }
}

/**
 * A provider/transport failure text worth retrying. POSITIVE allowlist, not a
 * ledger-code exclusion list: an error must match one of THESE shapes to be
 * retried at all, so an error this repo has never seen fails on the first
 * attempt by default, same as today.
 *
 * MEASURED (T-D19, PLAN.md 2026-09-10 13:01:18Z): a devnet run went 5/6 red on
 * bytes byte-identical to a green run — `Kupmios getProtocolParameters
 * failed`, raised inside Evolution's OWN `Stake.ts:64` while building a
 * bootstrap's stake registration/delegation (`registerAndDelegateTo` /
 * `delegateToDRep`), i.e. outside this repo's code entirely. Kupo's own log
 * for that window carries zero Error/Warning severities, so the hiccup is
 * Ogmios-side or transport (`queryLedgerState/protocolParameters` is an
 * Ogmios method) — hence "Kupmios" and "getProtocolParameters failed" as the
 * two named shapes, plus the generic connection/timeout shapes a transient
 * network read can surface as.
 */
const TRANSIENT_SIGNATURE =
  /getProtocolParameters failed|Kupmios .*failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i;

/**
 * Ledger verdicts a transient retry must NEVER catch — checked FIRST and wins
 * over TRANSIENT_SIGNATURE even if a verdict's text incidentally brushes a
 * transient-looking phrase. A script refusal (3010/3012), a missing witness
 * (3011), a stale-UTxO-view rejection (3117), insufficient Ada (3125), an
 * already-registered credential (3145 — bootstrap.ts tolerates this one on
 * purpose, elsewhere) and an undelegated-credential withdrawal (3150) are the
 * ledger's own answer, not a provider hiccup; retrying one would hide a real
 * defect behind a false "it just needed a retry".
 */
const LEDGER_VERDICT = /\b(3010|3011|3012|3117|3125|3145|3150)\b/;

/**
 * Retry `fn` a bounded number of times, but ONLY on a provider/transport
 * signature — see TRANSIENT_SIGNATURE/LEDGER_VERDICT above for the exact
 * predicate and why each excluded code is excluded. Exists to wrap the
 * OPERATION that actually failed in the MEASURED transient (a stake op's
 * `build()`), not our explicit `getProtocolParameters()` call sites — those
 * are not on that path (see PLAN.md T-D19).
 *
 * VISIBILITY: every retry that fires logs one line naming the attempt and the
 * matched signature, so a run that succeeded on attempt 2 is distinguishable
 * from one that succeeded on attempt 1 from the log alone. A silent retry is
 * an instrument that hides its own activity.
 *
 * ⚠ UNMEASURED whether this actually intercepts the real transient: it has
 * occurred 3 times in ~80 devnet runs today and not once in the last 21. This
 * slice cannot prove it works against the live transient — only that it does
 * not retry what it must never retry (a ledger verdict).
 */
export async function retryTransient(fn, { attempts = 3, delayMs = 1500, label = "operation" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.error(`  [retry] ${label}: succeeded on attempt ${attempt}/${attempts}`);
      }
      return result;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (LEDGER_VERDICT.test(msg) || !TRANSIENT_SIGNATURE.test(msg)) throw err;
      lastErr = err;
      if (attempt === attempts) {
        console.error(
          `  [retry] ${label}: exhausted ${attempts} attempts on transient signature — giving up`
        );
        throw err;
      }
      const matched = TRANSIENT_SIGNATURE.exec(msg)?.[0] ?? "?";
      console.error(
        `  [retry] ${label}: attempt ${attempt}/${attempts} failed on transient signature ` +
          `"${matched}" — retrying in ${delayMs}ms`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
