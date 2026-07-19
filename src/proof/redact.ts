/**
 * Redact common credential assignments from a terminal transcript before it
 * is persisted as evidence. The transcript is never an assertion source, but
 * it still must not leak secrets to disk.
 *
 * The replacement uses a real capture group so the secret value is actually
 * stripped. (A previous implementation evaluated the replacement against the
 * literal string "$&" and returned the input unchanged.)
 */
export function redact(value: string): string {
  return value.replace(
    /((?:api[_-]?key|authorization|token|password)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
    "$1[REDACTED]",
  );
}
