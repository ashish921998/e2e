/**
 * Remove credentials from terminal output, model feedback, and live logs.
 *
 * This is the single definition of "secret" for the whole engine; call it
 * everywhere evidence or error text may reach disk or a model provider.
 */
export function redact(value: string): string {
  const assignmentsRedacted = value
    // Consume double-quoted values through the matching quote, including
    // escaped characters and newlines. With no closing quote, fail closed by
    // consuming to the end of the transcript rather than leaking later lines.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*")(?:\\[\s\S]|[^"\\])*(?:"|$)/gi,
      '$1[REDACTED]"',
    )
    // Shell single quotes can contain newlines but not escaped single quotes.
    // As above, an unterminated value is redacted through end of input.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*')[^']*(?:'|$)/gi,
      "$1[REDACTED]'",
    )
    // Unquoted values stop at delimiters so adjacent fields survive. Bearer and
    // Basic are consumed with their credential instead of being redacted alone.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?["']?[^\s",;&]+/gi,
      "$1[REDACTED]",
    );

  return redactCommandBasicAuth(assignmentsRedacted)
    // Bare provider/runner keys. The boundary prevents benign compound
    // identifiers such as feat-sk-release from being mangled.
    .replace(/(?<![A-Za-z0-9_-])(?:sk-|e2b_)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED]");
}

/** Redact user:password only when it is an auth option on curl/wget. */
function redactCommandBasicAuth(value: string): string {
  // Start at a shell command boundary so unrelated flags such as
  // `docker run --user 1000:1000` remain valid evidence. The three credential
  // branches preserve the username while handling double-quoted, single-quoted,
  // and unquoted arguments (including attached `-uuser:pass`).
  return value.replace(
    /((?:^|\n|[;&|]\s*|\$\s*)(?:\S*\/)?(?:curl|wget)\b[^\n;&|]*?(?:-u|--user)(?:[ =]+|(?=\S)))(?:"([^":\n]+):((?:\\[\s\S]|[^"\\])*)(?:"|$)|'([^':\n]+):([^']*)(?:'|$)|([^\s:"']+):([^\s"';&|]+))/gi,
    (_match, prefix: string, doubleUser?: string, _doublePassword?: string, singleUser?: string, _singlePassword?: string, plainUser?: string) => {
      if (doubleUser !== undefined) return `${prefix}"${doubleUser}:[REDACTED]"`;
      if (singleUser !== undefined) return `${prefix}'${singleUser}:[REDACTED]'`;
      return `${prefix}${plainUser ?? ""}:[REDACTED]`;
    },
  );
}
