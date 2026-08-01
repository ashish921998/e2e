import { expect, test } from "@playwright/test";
import { redact } from "../src/proof/redact";

// Build secret-looking values from parts so the source does not contain
// literal credentials, but the runtime string still exercises the redactor.
const apiKeyValue = ["sk-", "super", "secret", "123"].join("");
const passwordValue = ["hun", "ter", "2"].join("");
const bearerValue = ["abc", ".", "def", ".", "ghi"].join("");
const tokenValue = ["ghp_", "0123", "4567", "89"].join("");

test("redact strips common credential assignments from a transcript", () => {
  const input = [
    `$ export API_KEY=${apiKeyValue}`,
    `$ password=${passwordValue}`,
    `$ authorization: Bearer ${bearerValue}`,
    `$ token: ${tokenValue}`,
    "$ echo build complete",
  ].join("\n");
  const output = redact(input);

  expect(output).not.toContain(apiKeyValue);
  expect(output).not.toContain(passwordValue);
  expect(output).not.toContain(bearerValue);
  expect(output).not.toContain(tokenValue);
  expect(output).toContain("API_KEY=[REDACTED]");
  expect(output).toContain("password=[REDACTED]");
  expect(output).toContain("authorization: [REDACTED]");
  expect(output).toContain("token: [REDACTED]");
  // Non-secret lines survive unchanged.
  expect(output).toContain("echo build complete");
});

test("redact strips a bare provider key with no key= prefix", () => {
  // A raw API key echoed by a curl/error body, with no surrounding `key=`.
  const input = `error: invalid api key ${apiKeyValue} rejected`;
  const output = redact(input);
  expect(output).not.toContain(apiKeyValue);
  expect(output).toContain("[REDACTED]");
});

test("redact leaves a transcript with no secrets unchanged", () => {
  const input = "$ rg stockRemaining src\nsrc/demo-product.ts: stockRemaining: 3";
  expect(redact(input)).toBe(input);
});
