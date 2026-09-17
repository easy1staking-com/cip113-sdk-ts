/**
 * The named refusal for address parameters — ONE guard, every site that decides
 * which address a transaction targets.
 *
 * ⛔ WHAT THIS EXISTS TO STOP. Several substandard params types make an address
 * OPTIONAL (`recipientAddress`, `holderAddress`). Every call site handled an
 * ABSENT value correctly and a PRESENT-BUT-EMPTY one wrongly, in one of three
 * ways, and `""` is the only value that separates them:
 *
 *   - `value || fallback`  — `""` is falsy, so the fallback silently wins and a
 *     VALID transaction is built against the WRONG address. Nothing throws.
 *   - `if (value) { ... }` — `""` is falsy, so the branch is silently skipped
 *     and the address is dropped from the set being searched.
 *   - `value ?? fallback`  — `""` survives and reaches bech32 decoding, where it
 *     throws a `ParseError: AddressStructure.FromBech32` three frames deep in
 *     `core/evo-utils`, naming neither the parameter nor the operation.
 *
 * `""` arrives from exactly the places nobody checks: an unset config field, an
 * unfilled form, a `.env` that parsed to empty. So the refusal is by NAME —
 * never a `??`/`||` guess. This repo's own standing rule, recorded in
 * `test/provenance-artefact.test.mjs`: *refused by a NAMED assertion, never a
 * `??`/`||` guess*.
 *
 * ⚠ WHAT DOES NOT CHANGE. An ABSENT parameter still resolves to its documented
 * default, and a VALID one is still used unchanged. The only behaviour this
 * changes is `""` and other non-string junk: from silent-or-misdiagnosed to a
 * named refusal.
 */

import type { Address } from "../types.js";

// ---------------------------------------------------------------------------
// The core check — written once, used by all three call shapes below
// ---------------------------------------------------------------------------

/**
 * A value is usable as an address only if it is a non-empty string containing NO
 * WHITESPACE ANYWHERE.
 *
 * ⛔ THIS USED TO COMPUTE `value.trim()` TO DECIDE EMPTINESS AND THEN THROW THE
 * TRIM AWAY. `"   "` was a named refusal while `<valid> + "\n"` fell straight
 * through to the unnamed bech32 `ParseError` — and **a trailing newline is what
 * you get reading an address out of a file**, which is the `.env` route this
 * whole guard exists for. The argument that justified refusing whitespace at all
 * ("bech32 admits no whitespace, so no valid address is excluded") covers ANY
 * whitespace-containing string; the implementation took it halfway.
 *
 * ⚠ REFUSED, NEVER TRIMMED. Accepting `" addr1..."` by silently repairing it
 * would hide the bug that produced the padding — the same silent-substitution
 * anti-pattern this module was written to delete.
 */
function isUsableAddress(value: unknown): value is Address {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

/** Describe what arrived without letting a large object into the message. */
function describeReceived(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length === 0) return '"" (the empty string)';
    // Three distinguishable failures, because the caller's next move differs:
    // an empty field was never filled in, a whitespace-only one was filled with
    // nothing, and a padded one holds a real address that arrived dirty.
    if (value.trim().length === 0) return `${JSON.stringify(value)} (whitespace only)`;
    if (/\s/.test(value)) return `${JSON.stringify(value)} (contains whitespace)`;
    return JSON.stringify(value);
  }
  if (typeof value === "object") return `a ${Array.isArray(value) ? "array" : "object"}`;
  return `${typeof value} ${String(value)}`;
}

/**
 * Whitespace inside an otherwise plausible address gets its own sentence: the
 * caller holds a real address that arrived dirty, and the fix is at the source
 * that dirtied it, not here.
 */
const WHITESPACE_NOTE =
  " Whitespace is never part of a bech32 address, and a leading or trailing space or newline is " +
  "exactly what reading one out of a file or a `.env` produces. It is REFUSED rather than trimmed: " +
  "repairing a caller's data silently hides whatever produced the padding.";

/**
 * `null` gets its own sentence too. It is the JSON spelling of a CLEARED field —
 * what `JSON.stringify` emits for one, and what most config loaders and ORMs
 * produce — and defaulting it is how an HTTP caller silently pays the wrong
 * address. Only `undefined` means absent.
 */
const NULL_NOTE =
  " `null` is the JSON spelling of a CLEARED field, not of an absent one: only omitting the " +
  "parameter (or passing `undefined`) selects the documented default. Defaulting `null` would send " +
  "the transaction somewhere the caller never named.";

/**
 * The single refusal. Names the OPERATION, the PARAMETER and what was RECEIVED,
 * then says what the caller should do instead — the habit this repo keeps for
 * every error: say what was actually available.
 */
function refuseAddress(operation: string, parameter: string, value: unknown, remedy: string): never {
  const note =
    value === null
      ? NULL_NOTE
      : typeof value === "string" && /\s/.test(value)
        ? WHITESPACE_NOTE
        : "";
  throw new Error(
    `${operation}: ${parameter} is not a usable address — received ${describeReceived(value)}. ${remedy}${note}`
  );
}

// ---------------------------------------------------------------------------
// The three call shapes
// ---------------------------------------------------------------------------

/**
 * An OPTIONAL address with a documented default.
 *
 * absent (`undefined`) ⇒ `fallback`, which is the existing, documented behaviour
 * and must not change. Present but unusable ⇒ refused by name.
 *
 * ⛔ `null` IS PRESENT, NOT ABSENT, AND IS REFUSED. It used to default, so an
 * HTTP/JSON caller sending `{"recipientAddress": null}` — what `JSON.stringify`
 * emits for a cleared field — minted to the fee payer in silence. The declared
 * type is `Address | undefined`, so `null` was never a typed input: refusing it
 * breaks no typed caller and converts a silent wrong-address into a named
 * refusal for every untyped one.
 */
export function resolveOptionalAddress(
  value: unknown,
  fallback: Address,
  operation: string,
  parameter: string,
  fallbackParameter: string
): Address {
  if (value === undefined) return fallback;
  if (!isUsableAddress(value)) {
    refuseAddress(
      operation,
      parameter,
      value,
      `Omit ${parameter} entirely to use the documented default (${fallbackParameter}), or pass a ` +
        `bech32 address. It is refused rather than silently replaced: falling back to ` +
        `${fallbackParameter} here builds a VALID transaction against the WRONG address.`
    );
  }
  return value;
}

/**
 * An OPTIONAL address whose absence is not a fallback but a different plan —
 * `seize`'s `holderAddress`, where absent legitimately means "search only the
 * fee payer and the destination".
 *
 * absent (`undefined`) ⇒ `undefined`, and the caller's own conditional decides.
 * Present but unusable ⇒ refused by name rather than silently dropped. `null` is
 * PRESENT — see `resolveOptionalAddress`.
 */
export function optionalAddressOrAbsent(
  value: unknown,
  operation: string,
  parameter: string,
  absentMeans: string
): Address | undefined {
  if (value === undefined) return undefined;
  if (!isUsableAddress(value)) {
    refuseAddress(
      operation,
      parameter,
      value,
      `Omit ${parameter} entirely if you mean ${absentMeans}, or pass a bech32 address. It is ` +
        `refused rather than silently dropped: a dropped holder aims the operation at the wrong ` +
        `set of addresses without any error.`
    );
  }
  return value;
}

/**
 * A REQUIRED address. There is no default to fall back to, so absent and
 * unusable are the same refusal — and `""` stops producing an unnamed
 * `ParseError` from inside bech32 decoding.
 */
export function requiredAddress(value: unknown, operation: string, parameter: string): Address {
  if (!isUsableAddress(value)) {
    refuseAddress(
      operation,
      parameter,
      value,
      `${parameter} is REQUIRED and must be a bech32 address string.`
    );
  }
  return value;
}
