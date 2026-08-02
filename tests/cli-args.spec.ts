import { expect, test } from "@playwright/test";
import { parseArgs } from "../bin/args";

test("parseArgs maps every documented flag", () => {
  const parsed = parseArgs([
    "--url", "http://x",
    "--goal", "g",
    "--diff", "d.diff",
    "--out", "o",
    "--target-id", "t",
    "--max-steps", "7",
    "--model", "m",
    "--provider", "anthropic",
    "--no-replay",
  ]);
  expect(parsed).toEqual({
    url: "http://x",
    goal: "g",
    diff: "d.diff",
    out: "o",
    targetId: "t",
    maxSteps: "7",
    model: "m",
    provider: "anthropic",
    noReplay: true,
  });
});

test("parseArgs recognises both help forms", () => {
  expect(parseArgs(["-h"]).help).toBe(true);
  expect(parseArgs(["--help"]).help).toBe(true);
});

test("parseArgs rejects an unknown provider", () => {
  expect(parseArgs(["--provider", "gemini"]).provider).toBeUndefined();
});

test("parseArgs never eats the next flag as a value", () => {
  const parsed = parseArgs(["--goal", "--no-replay", "--url", "http://x"]);
  expect(parsed.goal).toBeUndefined();
  expect(parsed.noReplay).toBe(true);
  expect(parsed.url).toBe("http://x");
});

test("parseArgs ignores unknown flags without derailing the rest", () => {
  expect(parseArgs(["--nope", "x", "--url", "http://x"]).url).toBe("http://x");
});
