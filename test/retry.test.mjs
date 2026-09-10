/**
 * T-D19 — `retryTransient`'s predicate, offline.
 *
 * ⛔ WHY THIS FILE EXISTS AT THE TEST ROOT AND NOT UNDER test/devnet/.
 * These assertions are pure logic: no chain, no client, no network. Round 1
 * put them in `test/devnet/upgrade.test.ts` behind `before(requireDevnet)`,
 * so the invariant "no ledger verdict is ever retried" was defended ONLY on a
 * machine with a live devnet — and CI deliberately does not run test:devnet.
 * A defect in exactly that gap is what round 1 shipped. `npm test` globs
 * `test/*.test.mjs`, so a `.mjs` file here runs in CI on every push;
 * `typecheck:harness` globs `test/harness/*.ts test/devnet/*.ts`, so this file
 * adds nothing to the harness error count.
 *
 * ⛔ AND WHY EVERY FIXTURE MESSAGE HERE IS THE REAL SHAPE. Round 1's test
 * asserted the no-retry property with the ledger code written INLINE in the
 * message. That is the one shape in which a message-only predicate can see a
 * verdict, and it is a shape the real `build()` path never produces —
 * Evolution's Kupmios wrapper puts the OPERATION NAME in `message` and the
 * ledger's reason in `cause`. The test was green because the fixture's shape
 * held, not because the code was right. Fixtures below use the wrapper's own
 * output.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { retryTransient } from "./harness/yaci.mjs";

/** Run `fn` under retryTransient with the console captured; never leaks the patch. */
async function withCapturedLog(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

/** How many times was the thunk actually invoked, and did it reject? */
async function attemptsUntilGiveUp(thrown, opts = {}) {
  let calls = 0;
  const thunk = async () => {
    calls++;
    throw typeof thrown === "function" ? thrown() : thrown;
  };
  let rejected = false;
  const original = console.error;
  console.error = () => {};
  try {
    await retryTransient(thunk, { attempts: 3, delayMs: 1, label: "probe", ...opts });
  } catch {
    rejected = true;
  } finally {
    console.error = original;
  }
  return { calls, rejected };
}

// ---------------------------------------------------------------------------
// F-1 — the defect round 1 shipped
// ---------------------------------------------------------------------------

/**
 * ⛔ THE REGRESSION. `"Provider evaluation failed: Kupmios evaluateTx failed"`
 * is what a SCRIPT REFUSAL during `build()` actually looks like: it matched
 * round 1's `Kupmios .*failed` wildcard, could not match LEDGER_VERDICT (no
 * code is present anywhere in the message), and was retried three times.
 * MEASURED against round 1's unmodified code: calls === 3.
 *
 * M-G's target (revert TRANSIENT_SIGNATURE to `Kupmios .*failed`).
 */
test("F-1: a script refusal during build() — the REAL wrapper message — fails on attempt 1", async () => {
  const { calls, rejected } = await attemptsUntilGiveUp(
    new Error("Provider evaluation failed: Kupmios evaluateTx failed")
  );
  assert.ok(rejected, "the refusal must propagate");
  assert.equal(
    calls,
    1,
    "evaluateTx is the ONE wrapped operation that can carry a ledger verdict; it must never be retried"
  );
});

/**
 * The other side of the same fix: `submitTx` is not wrapped by `wrapError` and
 * interpolates its own reason, so its message is likewise not on the allowlist.
 */
test("F-1: a submit failure is not on the allowlist either — fails on attempt 1", async () => {
  const { calls } = await attemptsUntilGiveUp(
    new Error("Kupmios submitTx failed: ledger refused the transaction")
  );
  assert.equal(calls, 1, "submitTx carries the ledger's own answer; retrying it would hide a real defect");
});

/**
 * ⛔ FAIL CLOSED. An operation Evolution has not shipped yet — the exact case a
 * negative lookahead (`Kupmios (?!evaluateTx|submitTx).*failed`) would fail
 * OPEN on. The positive nine-operation allowlist refuses it.
 *
 * M-G's target too: a wildcard would retry this.
 */
test("F-1: an UNKNOWN Kupmios operation is not retried — the allowlist fails closed", async () => {
  const { calls } = await attemptsUntilGiveUp(
    new Error("Kupmios someFutureOperation failed")
  );
  assert.equal(calls, 1, "an operation not on the enumerated allowlist must fail on the first attempt");
});

/**
 * ⛔ THE CAUSE-CHAIN BACKSTOP. The message is a perfectly transient shape — an
 * allowlisted read-only operation — and the ledger's verdict is where
 * Evolution actually puts it: in `cause`. A message-only predicate retries
 * this. M-H's target (remove the cause walk).
 */
test("F-1b: a verdict nested in `cause` fails on attempt 1, even under a transient-looking message", async () => {
  const err = new Error("Kupmios getUtxos failed", {
    cause: new Error("ScriptExecutionFailure: code 3012, the script evaluated to false"),
  });
  const { calls } = await attemptsUntilGiveUp(err);
  assert.equal(calls, 1, "LEDGER_VERDICT must be tested against the cause chain, not only the message");
});

/**
 * Ogmios reports the verdict as a NUMERIC `code` field beside the prose, so
 * the number appears in no message anywhere in the chain. Two levels deep, to
 * pin that the walk is a walk and not a single `err.cause` peek.
 */
test("F-1b: a numeric `code` two causes deep is still seen as a verdict", async () => {
  const inner = { code: 3117, data: { reason: "unknown UTxO references as inputs" } };
  const mid = new Error("Ogmios rejected the transaction", { cause: inner });
  const err = new Error("Kupmios getProtocolParameters failed", { cause: mid });
  const { calls } = await attemptsUntilGiveUp(err);
  assert.equal(calls, 1, "a verdict carried as a field, not as prose, must still stop the retry");
});

/** A cyclic `cause` must terminate the walk, not hang or throw. */
test("F-1b: a cyclic cause chain terminates and does not crash the predicate", async () => {
  const a = new Error("Kupmios getUtxos failed");
  const b = new Error("inner transport wobble");
  a.cause = b;
  b.cause = a;
  const { calls, rejected } = await attemptsUntilGiveUp(a);
  assert.ok(rejected, "it must still end in a rejection rather than looping");
  assert.equal(calls, 3, "no verdict anywhere in the cycle, and the message is allowlisted — so it retries");
});

// ---------------------------------------------------------------------------
// The MEASURED transient must STILL be retried — the way an over-tight fix fails
// ---------------------------------------------------------------------------

/**
 * ⛔ M-I's target, and the reason M-I exists: narrowing the allowlist too far
 * silently stops the one transient this slice was written for from being
 * retried. Nothing looks wrong; the suite just goes back to being flaky months
 * later. `"Kupmios getProtocolParameters failed"` is the exact string MEASURED
 * on 2026-09-10 13:01:18Z, raised inside Evolution's own Stake.ts:64.
 */
test("the MEASURED transient is still retried — succeeds on attempt 2", async () => {
  let calls = 0;
  const failsOnceThenSucceeds = async () => {
    calls++;
    if (calls === 1) throw new Error("Kupmios getProtocolParameters failed");
    return "ok";
  };
  const { result } = await withCapturedLog(() =>
    retryTransient(failsOnceThenSucceeds, { attempts: 3, delayMs: 1, label: "measured-transient" })
  );
  assert.equal(result, "ok", "the operation must succeed once the transient clears");
  assert.equal(calls, 2, "attempt 1 failed on the MEASURED signature, attempt 2 succeeded");
});

/** The same shape as the harness sees it in the wild, with Evolution's own prefix. */
test("the MEASURED transient is still retried when wrapped by Evolution's builder prose", async () => {
  let calls = 0;
  const thunk = async () => {
    calls++;
    if (calls < 3) throw new Error("Failed to fetch protocol parameters: Kupmios getProtocolParameters failed");
    return "ok";
  };
  const { result } = await withCapturedLog(() =>
    retryTransient(thunk, { attempts: 3, delayMs: 1, label: "measured-transient-wrapped" })
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "two transient failures, then success on the last permitted attempt");
});

/** The rest of the read-only allowlist, and the transport shapes, all still retry. */
test("every allowlisted read-only operation and transport shape is still retried", async () => {
  const shapes = [
    "Kupmios getProtocolParameters failed",
    "Kupmios getUtxos failed",
    "Kupmios getUtxosWithUnit failed",
    "Kupmios getUtxoByUnit failed",
    "Kupmios getUtxosByOutRef failed",
    "Kupmios getDatum failed",
    "Kupmios retrieveDatum failed",
    "Kupmios getScript failed",
    "Kupmios getDelegation failed",
    "connect ECONNREFUSED 127.0.0.1:1442",
    "read ECONNRESET",
    "connect ETIMEDOUT",
    "getaddrinfo EAI_AGAIN kupo",
    "TypeError: fetch failed",
    "socket hang up",
  ];
  for (const shape of shapes) {
    const { calls } = await attemptsUntilGiveUp(new Error(shape));
    assert.equal(calls, 3, `"${shape}" must still be retried to exhaustion`);
  }
});

// ---------------------------------------------------------------------------
// The too-broad direction — no ledger verdict is ever retried
// ---------------------------------------------------------------------------

/**
 * M-A's target (base contract): widen the predicate to match a verdict and
 * this goes red. Every code in LEDGER_VERDICT, each inside an otherwise
 * allowlisted, transient-looking message.
 */
test("each of the seven ledger verdicts fails on attempt 1, inside a transient-looking message", async () => {
  for (const code of [3010, 3011, 3012, 3117, 3125, 3145, 3150]) {
    const { calls } = await attemptsUntilGiveUp(
      new Error(`Kupmios getProtocolParameters failed (ledger said ${code}, incidentally)`)
    );
    assert.equal(calls, 1, `code ${code} must fail on the FIRST attempt, exactly as with no retry at all`);
  }
});

/**
 * Moved verbatim in substance from `test/devnet/upgrade.test.ts` (round 1),
 * where it ran only with a live devnet. The verdict wins over the transient
 * match rather than the two merely not colliding by luck.
 */
test("retryTransient: a ledger verdict (e.g. 3012) fails on the first attempt, never retried", async () => {
  let calls = 0;
  const alwaysRefused = async () => {
    calls++;
    throw new Error(
      "code 3012, validationError: script refused (Kupmios getProtocolParameters failed, incidentally)"
    );
  };
  await assert.rejects(
    () => retryTransient(alwaysRefused, { attempts: 3, delayMs: 1, label: "test-ledger-verdict" }),
    /3012/,
    "the ledger verdict must propagate, not be swallowed by a retry"
  );
  assert.equal(calls, 1, "a ledger verdict must fail on the FIRST attempt, exactly as with no retry at all");
});

// ---------------------------------------------------------------------------
// Boundaries — \b anchoring, and inputs that are not Errors at all
// ---------------------------------------------------------------------------

test("a longer number CONTAINING a verdict code is not a verdict", async () => {
  for (const noise of ["13012", "3145000", "0x3010", "31173117"]) {
    const { calls } = await attemptsUntilGiveUp(
      new Error(`Kupmios getUtxos failed (lovelace ${noise})`)
    );
    assert.equal(
      calls,
      3,
      `"${noise}" must NOT read as a ledger verdict — \\b anchoring is what keeps the transient retryable`
    );
  }
});

test("a bare-string throw and a null throw do not crash the predicate", async () => {
  const bare = await attemptsUntilGiveUp("something went sideways");
  assert.ok(bare.rejected, "a bare string must still propagate");
  assert.equal(bare.calls, 1, "an unrecognised string is not on the allowlist — first attempt only");

  const nul = await attemptsUntilGiveUp(null);
  assert.ok(nul.rejected, "a null throw must still propagate");
  assert.equal(nul.calls, 1, "null is not on the allowlist — first attempt only");

  const bareTransient = await attemptsUntilGiveUp("connect ECONNREFUSED 127.0.0.1:1442");
  assert.equal(bareTransient.calls, 3, "a bare STRING carrying a transport shape is still retried");
});

// ---------------------------------------------------------------------------
// Visibility — M-C's target
// ---------------------------------------------------------------------------

/**
 * ⛔ THE DISCRIMINATOR. An auditor must be able to tell "succeeded on attempt
 * 1" from "succeeded on attempt 2" FROM THE LOG ALONE. Both halves are
 * asserted: silence when nothing retried, and both lines when something did.
 * Moved from `test/devnet/upgrade.test.ts` (round 1) and extended with the
 * attempt-1 half, which is the half that makes the signal a discriminator
 * rather than just a message.
 */
test("visibility: attempt-1 success emits ZERO [retry] lines; attempt-2 success emits failure AND success", async () => {
  const clean = await withCapturedLog(() =>
    retryTransient(async () => "ok", { attempts: 3, delayMs: 1, label: "test-clean" })
  );
  assert.equal(clean.result, "ok");
  assert.deepEqual(
    clean.lines.filter((l) => l.includes("[retry]")),
    [],
    "a run that never retried must be SILENT — otherwise the log cannot discriminate"
  );

  let calls = 0;
  const failsOnce = async () => {
    calls++;
    if (calls === 1) throw new Error("Kupmios getProtocolParameters failed");
    return "ok";
  };
  const retried = await withCapturedLog(() =>
    retryTransient(failsOnce, { attempts: 3, delayMs: 1, label: "test-transient" })
  );
  assert.equal(retried.result, "ok");
  assert.equal(calls, 2, "attempt 1 failed, attempt 2 succeeded");

  const lines = retried.lines.filter((l) => l.includes("[retry]") && l.includes("test-transient"));
  const failureLine = lines.find((l) => l.includes("failed on transient signature"));
  const successLine = lines.find((l) => l.includes("succeeded on attempt"));
  assert.ok(failureLine, "a retry that fires must log a [retry] line naming the label");
  assert.match(failureLine, /attempt 1\/3/, "the log must name WHICH attempt failed");
  assert.match(failureLine, /getProtocolParameters failed|Kupmios/, "the log must name the matched signature");
  assert.ok(successLine, "and the eventual success must say which attempt carried it");
  assert.match(successLine, /attempt 2\/3/, "so attempt-2 success is distinguishable from attempt-1 success");
});
