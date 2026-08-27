/**
 * Get the actual reason out of an Effect-wrapped provider error.
 *
 * ⚠ WHY A HELPER IS NEEDED: the reason IS in the error and we were not reading
 * it. Evolution's providers wrap the HTTP failure as
 * `ResponseError{ description: "non 2xx status code : <BODY>" }`, then
 * `ProviderError{ message: "Blockfrost evaluateTx failed", cause }`. Effect
 * then throws a FiberFailure that stores its cause under a SYMBOL key — so a
 * walker using Object.values()/Object.entries() sees nothing and reports the
 * useless outer message.
 *
 * MEASURED: four preview deployments failed with "Blockfrost evaluateTx
 * failed" / "submitTx failed" and no detail, producing four different
 * non-diagnoses. The oracle was answering; nobody was listening.
 */
export function explainError(err: unknown, maxLen = 4000): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (o: unknown, depth = 0): void => {
    if (o == null || depth > 10 || seen.has(o)) return;
    if (typeof o === "string") {
      if (o.length > 8) parts.push(o);
      return;
    }
    if (typeof o !== "object") return;
    seen.add(o);

    // Non-enumerable string keys (message, stack, description live here).
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === "stack") continue;
      // ⛔ A DIAGNOSTIC THAT DUMPS EVERYTHING DUMPS CREDENTIALS TOO.
      // MEASURED: this helper printed a live Blockfrost `project_id` into a log
      // file on its first real use, because provider errors carry the request
      // headers. Redact by key name — the value is unguessable, so only the
      // name can be filtered.
      if (/^(project_id|authorization|api[-_]?key|cookie|set-cookie|token|secret)$/i.test(k)) {
        parts.push(`${k}: [REDACTED]`);
        continue;
      }
      try {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length > 8) parts.push(`${k}: ${v}`);
        else visit(v, depth + 1);
      } catch { /* getters may throw */ }
    }
    // ⇒ THE PART EVERYONE MISSES: Effect hangs the Cause off a SYMBOL.
    for (const s of Object.getOwnPropertySymbols(o)) {
      try { visit((o as Record<symbol, unknown>)[s], depth + 1); } catch { /* ignore */ }
    }
  };

  visit(err);
  const uniq = [...new Set(parts)].filter(
    (p) => !/^(name|_tag|_id|constructor):/.test(p)
  );
  const out = uniq.join("\n  | ");
  return out.length > maxLen ? out.slice(0, maxLen) + " …[truncated]" : out || String(err);
}
