import { expect, test } from "@playwright/test";
import { decideVerdict } from "../src/proof/verdict";
import type { ProofPlan } from "../src/proof/types";

// Minimal valid plans. The verdict gate only inspects step kinds, so a tiny
// shape is enough to drive each branch of decideVerdict.
function plan(steps: ProofPlan["steps"]): ProofPlan {
  return {
    version: 1 as const,
    name: "t",
    intent: "t",
    sourceSessionId: "s",
    steps,
  };
}

const navOnly = plan([{ kind: "goto", path: "/" }]);
const withAssertion = plan([
  { kind: "goto", path: "/" },
  { kind: "expectText", text: "Only 3 left" },
]);

const agentPass = { verdict: "pass" as const, reason: "ok" };
const agentFail = { verdict: "fail" as const, reason: "missing" };

test("decideVerdict: a nav-only plan with green replay and agent pass does NOT pass", () => {
  const d = decideVerdict({ plan: navOnly, agentVerdict: agentPass, replayStatus: "passed" });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("incomplete");
  expect(d.signals.hasAssertion).toBe(false);
});

test("decideVerdict: agent fail with green replay and an assertion does NOT pass", () => {
  const d = decideVerdict({ plan: withAssertion, agentVerdict: agentFail, replayStatus: "passed" });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("incomplete");
});

test("decideVerdict: agent never finished (no verdict) with green replay does NOT pass", () => {
  const d = decideVerdict({ plan: withAssertion, agentVerdict: undefined, replayStatus: "passed" });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("incomplete");
});

test("decideVerdict: assertion + agent pass + green replay PASSES", () => {
  const d = decideVerdict({ plan: withAssertion, agentVerdict: agentPass, replayStatus: "passed" });
  expect(d.passed).toBe(true);
  expect(d.status).toBe("passed");
  expect(d.signals).toEqual({ hasAssertion: true, agentVerdict: agentPass, replayStatus: "passed" });
});

test("decideVerdict: assertion + agent pass but replay failed is NOT passed", () => {
  const d = decideVerdict({ plan: withAssertion, agentVerdict: agentPass, replayStatus: "failed" });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("failed");
});

test("decideVerdict: skipped replay (undefined status) never passes even with assertion + agent pass", () => {
  const d = decideVerdict({ plan: withAssertion, agentVerdict: agentPass, replayStatus: undefined });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("incomplete");
});

test("decideVerdict: no valid plan is incomplete", () => {
  const d = decideVerdict({ plan: null, agentVerdict: agentPass, replayStatus: "passed" });
  expect(d.passed).toBe(false);
  expect(d.status).toBe("incomplete");
});
