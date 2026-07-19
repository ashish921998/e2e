import { deterministicPlanFromSession, validateProofPlan } from "./plan";
import type { PlanInterpretation, ProofPlan, RecordedSession } from "./types";

export interface SessionInterpreter {
  interpret(session: RecordedSession): Promise<PlanInterpretation>;
}

export interface ModelProofClient {
  /** Return JSON matching the constrained ProofPlan data contract. */
  createProofPlan(input: { session: RecordedSession; instructions: string }): Promise<unknown>;
}

export class GptSessionInterpreter implements SessionInterpreter {
  constructor(private readonly client: ModelProofClient) {}

  async interpret(session: RecordedSession): Promise<PlanInterpretation> {
    try {
      const response = await this.client.createProofPlan({ session, instructions: proofPlanInstructions() });
      const validated = validateProofPlan(response);
      if (validated.ok) return { ...validated, source: "model" };
    } catch {
      // The local deterministic fallback makes the demo replayable even if a
      // model request is unavailable. We intentionally do not expose secrets.
    }
    return deterministicPlanFromSession(session);
  }
}

/** Useful for local demos, tests and offline rehearsal. */
export class DeterministicSessionInterpreter implements SessionInterpreter {
  async interpret(session: RecordedSession): Promise<PlanInterpretation> {
    return deterministicPlanFromSession(session);
  }
}

export function proofPlanInstructions(): string {
  return [
    "Convert the recorded successful browser session to a ProofPlan JSON object.",
    "Do not return markdown, code, explanations, selectors, URLs, or extra keys.",
    "Use only goto, clickRole, fillRole, expectText, and expectRole steps.",
    "The first step must be goto with a relative path.",
    "Only use visible user-facing text and accessible roles/names from the session.",
    "Do not invent actions or assertions.",
  ].join(" ");
}

/** A convenient adapter for callers that already have a valid plan fixture. */
export function fixtureInterpreter(plan: ProofPlan): SessionInterpreter {
  return { async interpret() { return { ok: true, source: "deterministic-fallback", plan }; } };
}
