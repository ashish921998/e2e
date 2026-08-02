/**
 * Remove credentials from terminal output, model feedback, and live logs.
 *
 * This is the single definition of "secret" for the whole engine; call it
 * everywhere evidence or error text may reach disk or a model provider.
 */
export function redact(value: string): string {
  const assignmentsRedacted = value
    // Preserve the value's quote delimiter while consuming escaped characters
    // and newlines. Unterminated values fail closed at the end of the input.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(")(?:(?:\\[\s\S])|[^"\\])*(?:"|$)/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(')[^']*(?:'|$)/gi,
      "$1$2[REDACTED]$2",
    )
    // Also consume quotes wrapped around only a Bearer/Basic credential.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(?:bearer|basic)\s*"(?:\\[\s\S]|[^"\\])*(?:"|$)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(?:bearer|basic)\s*'[^']*(?:'|$)/gi,
      "$1[REDACTED]",
    )
    // Unquoted values stop at delimiters so adjacent fields survive. Skip
    // quoted values and replacements produced by the preceding passes.
    .replace(
      /("?(?:api[_-]?key|authorization|token|password)"?\s*[:=]\s*)(?!["']|\[REDACTED\])(?:(?:bearer|basic)\s+)?[^\s"',;&]+/gi,
      "$1[REDACTED]",
    );

  return redactCommandBasicAuth(assignmentsRedacted)
    // Bare provider/runner keys. The boundary prevents benign compound
    // identifiers such as feat-sk-release from being mangled.
    .replace(/(?<![A-Za-z0-9_-])(?:sk-|e2b_)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, "[REDACTED]");
}

/** Redact curl/wget user credentials, with or without a password separator. */
function redactCommandBasicAuth(value: string): string {
  // Match a real curl/wget command token, not a path ending in /curl or a word
  // such as uncurl. This still finds commands after sudo and common prompts.
  return value.replace(
    /((?<![\w./-])(?:curl|wget)\b[^\n;&|]*?(?<!\S)(?:-u(?:[ =]+|(?=\S))|--user[ =]+))("(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s"';&|]+)/gi,
    (_match, prefix: string, argument: string) => {
      const quote = argument[0] === '"' || argument[0] === "'" ? argument[0] : "";
      const hasClosingQuote = quote !== "" && argument.length > 1 && argument.endsWith(quote);
      const credential = quote ? argument.slice(1, hasClosingQuote ? -1 : undefined) : argument;
      const colon = credential.indexOf(":");
      const replacement = colon >= 0 ? `${credential.slice(0, colon)}:[REDACTED]` : "[REDACTED]";
      return `${prefix}${quote}${replacement}${quote}`;
    },
  );
}
