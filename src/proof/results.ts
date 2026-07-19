import {
  PROOF_BUNDLE_VERSION,
  type ProofArtifact,
  type ProofBundle,
  type ProofPlan,
  type ProofResult,
  type ProofStatus,
  type ProofTarget,
} from "./types";
import { renderPlaywrightTest } from "./render";

export interface RunnerOutcome {
  exitCode: number;
  startedAt: string;
  completedAt: string;
  stdout?: string;
  stderr?: string;
  failedStepIndex?: number;
  phase?: "compile" | "runner" | "test";
}

export function classifyRunnerOutcome(outcome: RunnerOutcome): ProofResult {
  const startedAt = asDate(outcome.startedAt);
  const completedAt = asDate(outcome.completedAt);
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  // The list reporter writes the failure block to stdout and Node warnings to
  // stderr; combine both so the reviewer shows the real assertion error.
  const error = cleanError([outcome.stderr, outcome.stdout].filter(Boolean).join("\n"));
  let status: ProofStatus = "passed";
  if (outcome.exitCode !== 0) {
    status = outcome.phase === "compile" ? "compile_error" : outcome.phase === "runner" ? "runner_error" : "failed";
  }

  return {
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    message: status === "passed" ? "Independent replay passed." : messageFor(status),
    ...(status === "failed" && outcome.failedStepIndex !== undefined ? { failedStepIndex: outcome.failedStepIndex } : {}),
    ...(error ? { error } : {}),
  };
}

export function createProofBundle(input: {
  id: string;
  plan: ProofPlan;
  target: ProofTarget;
  outcome: RunnerOutcome;
  artifacts?: ProofArtifact[];
}): ProofBundle {
  return {
    version: PROOF_BUNDLE_VERSION,
    id: input.id,
    plan: input.plan,
    target: input.target,
    result: classifyRunnerOutcome(input.outcome),
    artifacts: input.artifacts ?? [],
    generatedTest: renderPlaywrightTest(input.plan),
  };
}

function asDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid runner timestamp: ${value}`);
  return date;
}
function cleanError(value: string | undefined): string | undefined {
  const cleaned = value
    ?.split("\n")
    // Strip Node's warning scaffolding so the reviewer shows the actual
    // assertion error, not the "Use --trace-warnings" hint that precedes it.
    .filter((line) => !/^\(node:\d+\).*Warning|NO_COLOR.*is ignored|Use `node --trace-warnings|Trace-warnings/i.test(line))
    .join("\n")
    .trim();
  return cleaned ? cleaned.slice(0, 4_000) : undefined;
}
function messageFor(status: Exclude<ProofStatus, "passed" | "incomplete">): string {
  switch (status) {
    case "failed": return "Independent replay failed an assertion.";
    case "compile_error": return "The generated proof could not be compiled.";
    case "runner_error": return "The proof runner could not complete.";
  }
}
