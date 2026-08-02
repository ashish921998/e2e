import { expect, test } from "@playwright/test";
import { summarizeInput } from "../src/agent/loop";

test("fill step summaries never expose the entered value", () => {
  const password = ["correct", "-horse", "-battery", "-staple"].join("");
  const summary = summarizeInput("fill", {
    role: "textbox",
    name: "Password",
    value: password,
  });

  expect(summary).toBe("role=textbox name=Password value=[REDACTED]");
  expect(summary).not.toContain(password);
});

test("bash step summaries redact credentials while preserving the command", () => {
  const password = ["secret", " pass"].join("");
  const summary = summarizeInput("bash", {
    command: `curl -u "user:${password}" https://api.example.com`,
  });

  expect(summary).not.toContain(password);
  expect(summary).toContain("command=curl");
  expect(summary).toContain("user:[REDACTED]");
});
