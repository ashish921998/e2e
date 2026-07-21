/**
 * The portable, dependency-free contract between the recorder, the model
 * interpreter, the test runner and the e2e UI.
 */

export const PROOF_PLAN_VERSION = 1 as const;
export const PROOF_BUNDLE_VERSION = 1 as const;

export type ProofStatus =
  | "passed"
  | "failed"
  | "compile_error"
  | "runner_error"
  | "incomplete";

export type TargetKind = "local" | "production" | "preview" | "custom";

export interface ProofTarget {
  id: string;
  label: string;
  kind: TargetKind;
  baseUrl: string;
  /** Environment variables are deliberately not stored in proof bundles. */
  description?: string;
}

export interface BrowserNavigationEvent {
  type: "navigate";
  at: string;
  path: string;
  label?: string;
}

export interface BrowserObservationEvent {
  type: "observe";
  at: string;
  text: string;
  role?: string;
  accessibleName?: string;
  label?: string;
}

export interface BrowserInteractionEvent {
  type: "click" | "fill" | "select";
  at: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  value?: string;
  label?: string;
}

export type RecordedBrowserEvent =
  | BrowserNavigationEvent
  | BrowserObservationEvent
  | BrowserInteractionEvent;

export interface RecordedSession {
  id: string;
  title: string;
  startedAt: string;
  completedAt?: string;
  targetId: string;
  events: RecordedBrowserEvent[];
  /** A terminal transcript may be linked in artifacts, never treated as proof. */
  terminalTranscript?: string;
}

export interface GotoStep {
  kind: "goto";
  path: string;
  label?: string;
}

export interface ClickRoleStep {
  kind: "clickRole";
  role: string;
  name: string;
  label?: string;
}

export interface FillRoleStep {
  kind: "fillRole";
  role: string;
  name: string;
  value: string;
  label?: string;
}

export interface ExpectTextStep {
  kind: "expectText";
  text: string;
  label?: string;
}

export interface ExpectRoleStep {
  kind: "expectRole";
  role: string;
  name: string;
  label?: string;
}

export type ProofStep =
  | GotoStep
  | ClickRoleStep
  | FillRoleStep
  | ExpectTextStep
  | ExpectRoleStep;

/**
 * This is intentionally a constrained data format, rather than arbitrary
 * executable model output. The renderer is the only component that emits JS.
 */
export interface ProofPlan {
  version: typeof PROOF_PLAN_VERSION;
  name: string;
  intent: string;
  sourceSessionId: string;
  steps: ProofStep[];
}

export interface ProofArtifact {
  kind: "video" | "screenshot" | "trace" | "terminal" | "diff" | "test";
  label: string;
  path: string;
  mimeType?: string;
}

export interface ProofResult {
  status: ProofStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  message: string;
  failedStepIndex?: number;
  error?: string;
}

export interface ProofBundle {
  version: typeof PROOF_BUNDLE_VERSION;
  id: string;
  plan: ProofPlan;
  target: ProofTarget;
  result: ProofResult;
  artifacts: ProofArtifact[];
  generatedTest: string;
}

export type PlanInterpretation =
  | { ok: true; plan: ProofPlan; source: "model" | "deterministic-fallback" }
  | { ok: false; error: string };
