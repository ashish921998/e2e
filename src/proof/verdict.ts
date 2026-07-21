/**
 * The verdict gate for e2e-prove. Pure: given the three independent signals
 * (the recorded plan, the agent's self-reported verdict, and the deterministic
 * replay's result), it decides whether the proof `passed`.
 *
 * A `passed` verdict requires ALL THREE:
 *   1. The plan contains at least one assertion step (expectRole / expectText).
 *      An all-navigation run only proves the URL loaded — it asserts nothing,
 *      so it is `incomplete`.
 *   2. The agent finished with verdict "pass". If the agent said "fail" or never
 *      called finish, the run is not a pass even if the replay is green.
 *   3. The independent replay's status is "passed".
 *
 * This keeps the engine's core guarantee — the proof is the independent replay,
 * never just the model's word — while closing two gaps: a nav-only session
 * replays green and would otherwise "prove" only that a page loaded, and an
 * agent `fail` was previously ignored whenever an earlier replay went green.
 */
import type { ProofPlan, ProofStatus } from "./types";

/** Whether a plan step is a real assertion (vs. navigation/interaction). */
export function isAssertionStep(step: ProofPlan["steps"][number]): boolean {
  return step.kind === "expectRole" || step.kind === "expectText";
}

export interface AgentVerdictSignal {
  verdict: "pass" | "fail";
  reason: string;
}

export interface VerdictSignals {
  /** The deterministic plan recorded from the agent's session. Null when the session could not be turned into a valid plan. */
  plan: ProofPlan | null;
  /** The agent's finish() verdict. Undefined when the agent hit the step cap or returned no tool calls. */
  agentVerdict: AgentVerdictSignal | undefined;
  /** The independent replay's status. Undefined when the replay was skipped or never ran. */
  replayStatus: ProofStatus | undefined;
}

export interface VerdictDecision {
  status: ProofStatus;
  passed: boolean;
  /** Why the decision was reached, for summary.json transparency. */
  reason: string;
  /** The three input signals, echoed back for the record. */
  signals: {
    hasAssertion: boolean;
    agentVerdict: AgentVerdictSignal | undefined;
    replayStatus: ProofStatus | undefined;
  };
}

/**
 * Decide the proof verdict from the three signals. `passed` only when the plan
 * has an assertion AND the agent passed AND the replay passed; otherwise the
 * most informative non-pass status is returned.
 */
export function decideVerdict(signals: VerdictSignals): VerdictDecision {
  const hasAssertion = signals.plan?.steps.some(isAssertionStep) ?? false;
  const echoed = {
    hasAssertion,
    agentVerdict: signals.agentVerdict,
    replayStatus: signals.replayStatus,
  };

  // No valid plan → the session could not be replayed at all.
  if (!signals.plan) {
    return { status: "incomplete", passed: false, reason: "recorded session could not be turned into a replayable plan", signals: echoed };
  }

  // Nav-only plan: replays green but proves nothing.
  if (!hasAssertion) {
    return { status: "incomplete", passed: false, reason: "plan has no assertion step (expectRole/expectText) — an all-navigation run proves nothing", signals: echoed };
  }

  // Agent never finished or reported fail.
  if (!signals.agentVerdict || signals.agentVerdict.verdict !== "pass") {
    const why = signals.agentVerdict
      ? `agent verdict was ${signals.agentVerdict.verdict}: ${signals.agentVerdict.reason}`
      : "agent did not call finish with a verdict";
    return { status: "incomplete", passed: false, reason: why, signals: echoed };
  }

  // Replay was skipped or never produced a status.
  if (!signals.replayStatus) {
    return { status: "incomplete", passed: false, reason: "deterministic replay did not run", signals: echoed };
  }

  // All three signals present: gate on the replay result.
  if (signals.replayStatus === "passed") {
    return { status: "passed", passed: true, reason: "plan has an assertion, agent passed, and the independent replay passed", signals: echoed };
  }
  return { status: signals.replayStatus, passed: false, reason: `independent replay status was ${signals.replayStatus}`, signals: echoed };
}
