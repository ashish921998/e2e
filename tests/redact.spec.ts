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

test("redact strips a bare E2B runner credential", () => {
  const e2bValue = ["e2b_", "abcdef", "012345"].join("");
  const output = redact(`E2B sandbox rejected: ${e2bValue}`);
  expect(output).not.toContain(e2bValue);
  expect(output).toContain("[REDACTED]");
});

test("redact strips credentials inside quoted JSON, even non-sk tokens", () => {
  const jwt = ["eyJ", "header", ".", "payload", ".", "sig"].join("");
  const output = redact(`response: {"authorization":"Bearer ${jwt}","ok":true}`);
  expect(output).not.toContain(jwt);
  expect(output).toContain("ok"); // non-secret fields survive
});

test("redact leaves a benign substring containing 'sk-' alone", () => {
  const input = "please ask-questions before you commit";
  expect(redact(input)).toBe(input);
});

test("redact does not mangle compound identifiers with an sk-/e2b_ segment", () => {
  const input = "branch feat-sk-release file task-e2b_smoke.ts flag use-sk-demo";
  expect(redact(input)).toBe(input);
});

test("redact consumes a full quoted value with spaces and an escaped quote", () => {
  // Literal value is: foo \"bar baz  (a space and a backslash-escaped quote).
  const secret = 'foo \\"bar baz';
  const output = redact(`{"password":"${secret}","keep":"me"}`);
  expect(output).not.toContain("bar baz");
  expect(output).toContain('"keep":"me"'); // adjacent field intact
});

test("redact stops an unquoted value at the delimiter, sparing the next field", () => {
  const output = redact("token=ghp_secretvalue,other=keep");
  expect(output).not.toContain("ghp_secretvalue");
  expect(output).toContain("other=keep");
});

test("redact stops an unquoted value at a query-string `&`, sparing the next param", () => {
  const output = redact("token=ghp_secretvalue&status=ok");
  expect(output).not.toContain("ghp_secretvalue");
  expect(output).toContain("status=ok");
});

test("redact strips a malformed/unterminated quoted credential (no closing quote)", () => {
  // A truncated log line: the quoted value never closes. Use a `ghp_` token so
  // the bare-provider-key rule (sk-/e2b_ only) cannot mask a broken quoted path.
  const leaked = ["ghp_", "trunc", "atedsecret"].join("");
  const output = redact(`log: {"token":"${leaked}`);
  expect(output).not.toContain(leaked);
  expect(output).toContain("[REDACTED]");
});

test("redact strips a single-quoted shell value with spaces (no word-boundary leak)", () => {
  const secret = ["hun", " ", "ter", " ", "2"].join("");
  const output = redact(`$ password='${secret}' && echo done`);
  expect(output).not.toContain(secret);
  expect(output).not.toContain("ter 2"); // nothing after the first word leaks
  expect(output).toContain("[REDACTED]");
  expect(output).toContain("echo done"); // trailing command survives
});

test("redact strips an unterminated single-quoted value (no closing quote)", () => {
  const secret = ["hun", " ", "ter", "2"].join("");
  const output = redact(`$ password='${secret}`);
  expect(output).not.toContain(secret);
  expect(output).not.toContain("ter2"); // tail does not leak to the unquoted branch
  expect(output).toContain("[REDACTED]");
});

test("redact strips a double-quoted bearer token after the word Bearer", () => {
  const jwt = ["eyJ", "abc", ".", "def", ".", "ghi"].join("");
  const output = redact(`curl -H 'authorization: Bearer "${jwt}"'`);
  expect(output).not.toContain(jwt);
  expect(output).toContain("[REDACTED]");
});

test("redact strips a double-quoted key with an unquoted value", () => {
  const secret = ["ghp_", "rawvalue", "0123"].join("");
  const output = redact(`set "token"=${secret}`);
  expect(output).not.toContain(secret);
  expect(output).toContain("[REDACTED]");
});

test("redact strips a dotted provider key (sk-proj-...) as one unit", () => {
  const key = ["sk-proj-", "aaa", ".", "bbb", ".", "ccc"].join("");
  const output = redact(`error: invalid api key ${key} rejected`);
  expect(output).not.toContain(key);
  expect(output).not.toContain("bbb"); // middle segment does not survive
  expect(output).not.toContain("ccc"); // trailing segment does not survive
  expect(output).toContain("[REDACTED]");
  expect(output).toContain("rejected"); // following word intact
});

test("redact strips a curl basic-auth password after -u, keeping the username", () => {
  const pass = ["s3", "cr3", "tpw"].join("");
  const output = redact(`curl -u admin:${pass} https://api.example.com`);
  expect(output).not.toContain(pass);
  expect(output).toContain("admin:[REDACTED]"); // username preserved
  expect(output).toContain("https://api.example.com"); // URL survives
});

test("redact leaves a `sort -u file` flag untouched (no colon, not basic auth)", () => {
  const input = "$ sort -u names.txt && echo ok";
  expect(redact(input)).toBe(input);
});

test("redact leaves a transcript with no secrets unchanged", () => {
  const input = "$ rg stockRemaining src\nsrc/demo-product.ts: stockRemaining: 3";
  expect(redact(input)).toBe(input);
});
