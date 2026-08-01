/**
 * Redact common credential assignments from a terminal transcript before it
 * is persisted as evidence. The transcript is never an assertion source, but
 * it still must not leak secrets to disk.
 *
 * The replacement uses a real capture group so the secret value is actually
 * stripped. (A previous implementation evaluated the replacement against the
 * literal string "$&" and returned the input unchanged.)
 *
 * Two shapes are covered:
 *   1. Key/value assignments — `api-key: …`, `token=…`, and the quoted JSON
 *      form `{"authorization":"Bearer …"}` (the closing/opening quotes around
 *      the key and value are optional in the pattern).
 *   2. Bare provider/runner keys — `sk-…` (model providers) and `e2b_…` (the
 *      sandbox runner's required credential) that appear with no surrounding
 *      key name, e.g. echoed raw in a curl or an error body. A token boundary
 *      is required before the prefix so a benign substring like `ask-me` is not
 *      mistaken for a key.
 *
 * This is the single definition of "secret" for the whole engine; call it
 * everywhere evidence or error text may reach disk or a model provider.
 */
export function redact(value: string): string {
  return value
    // Quoted value: consume the whole string up to the real closing quote,
    // including spaces and escaped quotes (`\"`), so `{"token":"a\"b c"}` is
    // fully redacted and an adjacent field stays intact.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*")(?:\\.|[^"\\])*"/gi,
      '$1[REDACTED]"',
    )
    // Unquoted value: stop at the first delimiter so a following field survives.
    .replace(
      /((?:api[_-]?key|authorization|token|password)\s*[:=]\s*)(?:bearer\s+)?[^\s",;]+/gi,
      "$1[REDACTED]",
    )
    // Bare provider/runner keys. The boundary excludes `-`/`_` too, so a
    // compound identifier like `feat-sk-release` or `task-e2b_smoke` is not a
    // false positive; only a standalone key (after whitespace/quote/start) matches.
    .replace(/(?<![A-Za-z0-9_-])(?:sk-|e2b_)[A-Za-z0-9_-]+/g, "[REDACTED]");
}
