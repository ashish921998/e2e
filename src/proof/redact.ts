/**
 * Redact common credential assignments from a terminal transcript before it
 * is persisted as evidence. The transcript is never an assertion source, but
 * it still must not leak secrets to disk.
 *
 * The replacement uses a real capture group so the secret value is actually
 * stripped. (A previous implementation evaluated the replacement against the
 * literal string "$&" and returned the input unchanged.)
 *
 * Two shapes are covered: prefixed assignments (`api-key: …`, `token=…`) and
 * bare provider keys (`sk-…`) that appear with no surrounding key name — e.g. a
 * raw API key echoed in a curl or an error body. This is the single definition
 * of "secret" for the whole engine; call it everywhere evidence or error text
 * may reach disk or a model provider.
 */
export function redact(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|authorization|token|password)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
