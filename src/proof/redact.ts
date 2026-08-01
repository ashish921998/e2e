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
    // fully redacted and an adjacent field stays intact. The close is `(?:"|$)`
    // so a malformed/truncated `token="secret` (no closing quote) still redacts,
    // terminating at end of line (`m` flag) instead of leaking the value. The
    // value class excludes newlines so an unterminated value stops at the line.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*")(?:\\.|[^"\\\n])*(?:"|$)/gim,
      '$1[REDACTED]"',
    )
    // Single-quoted value: shell `password='hun ter2'` — no escape processing
    // inside single quotes, so consume everything (spaces included) up to the
    // closing `'` OR end of line (`m` flag), so a malformed/unterminated
    // `password='hun ter2` still redacts the whole value instead of leaving the
    // tail for the unquoted branch to expose word-by-word.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*')[^'\n]*(?:'|$)/gim,
      "$1[REDACTED]'",
    )
    // Unquoted value: stop at the first delimiter (incl. `&`) so a following
    // field — e.g. a query-string `&status=ok` — survives. A lone opening quote
    // after `Bearer` (`Bearer "token"`) is consumed so the token can't hide
    // behind it. The key quotes are optional too (`"password"=secret` — a
    // double-quoted key with an unquoted value must still redact).
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(?:bearer\s+)?["']?[^\s",;&]+/gi,
      "$1[REDACTED]",
    )
    // curl/wget HTTP basic auth: `-u user:pass` / `--user user:pass`. Keep the
    // username, redact the password after the colon. Case-sensitive and the
    // colon is required, so `sort -u file`, `psql -U name` etc. are untouched.
    .replace(/((?:-u|--user)[ =]+[^\s:"']+:)[^\s"']+/g, "$1[REDACTED]")
    // Bare provider/runner keys. The boundary excludes `-`/`_` too, so a
    // compound identifier like `feat-sk-release` or `task-e2b_smoke` is not a
    // false positive; only a standalone key (after whitespace/quote/start) matches.
    // Dots are spanned only between key chars so a full OpenAI key
    // (`sk-proj-<id>.<id>.<id>`) is stripped as one unit, without eating a
    // trailing sentence period.
    .replace(/(?<![A-Za-z0-9_-])(?:sk-|e2b_)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED]");
}
