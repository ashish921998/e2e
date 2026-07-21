import { expect, test } from "@playwright/test";
import {
  deterministicPlanFromSession,
  renderPlaywrightTest,
  type ProofPlan,
  type RecordedSession,
} from "../src/proof";

// The agent emits RecordedSession events shaped like a browser capture; the
// proof's determinism guarantee is that those events render into a spec that
// replays green independently. This test builds a session from the agent's tool
// vocabulary and asserts the round-trip without any network or model call.
const session: RecordedSession = {
  id: "session_agent_fixture",
  title: "agent verified the low-stock warning",
  startedAt: new Date().toISOString(),
  targetId: "preview",
  events: [
    { type: "navigate", at: new Date().toISOString(), path: "/", label: "agent goto" },
    { type: "observe", at: new Date().toISOString(), role: "heading", accessibleName: "Vintage Camera", text: "Vintage Camera", label: "agent observe_role" },
    { type: "observe", at: new Date().toISOString(), role: "status", text: "Only 3 left", label: "agent observe_text" },
  ],
};

test("an agent-produced session renders into a replayable Playwright spec", () => {
  const interpretation = deterministicPlanFromSession(session);
  expect(interpretation.ok).toBe(true);
  if (!interpretation.ok) return;

  const plan: ProofPlan = interpretation.plan;
  // The first step is always goto, and each agent observation became an assertion.
  expect(plan.steps[0]).toEqual({ kind: "goto", path: "/", label: "agent goto" });
  expect(plan.steps.map((s) => s.kind)).toEqual(["goto", "expectRole", "expectText"]);
  expect(plan.sourceSessionId).toBe(session.id);

  const source = renderPlaywrightTest(plan);
  // The rendered test uses only role/name and text assertions — no coordinates,
  // selectors, or model-supplied code — which is what keeps it deterministic.
  expect(source).toContain("page.goto(\"/\")");
  expect(source).toContain('getByRole("heading", { name: "Vintage Camera" })');
  expect(source).toContain('getByText("Only 3 left", { exact: true })');
  expect(source).not.toMatch(/page\.mouse|locator\(|querySelector/);
});

test("a session missing the assertion still produces a valid plan if it has a goto and a step", () => {
  const minimal: RecordedSession = {
    ...session,
    id: "session_minimal",
    events: [{ type: "navigate", at: new Date().toISOString(), path: "/products" }],
  };
  const interpretation = deterministicPlanFromSession(minimal);
  expect(interpretation.ok).toBe(true);
});
