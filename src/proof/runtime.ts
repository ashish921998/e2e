import type { ProofArtifact as EngineArtifact, ProofBundle as EngineBundle } from "./types";
import type { ProofBundle as ReviewBundle } from "../components/proof";

export type RuntimeProofBundle = EngineBundle & {
  interpreter?: "model" | "deterministic-fallback";
  terminalTranscript?: string;
  runUrl?: string;
};

const interpreterLabels: Record<NonNullable<RuntimeProofBundle["interpreter"]>, string> = {
  model: "GPT-5.6",
  "deterministic-fallback": "Deterministic fallback",
};

export function toReviewBundle(bundle: RuntimeProofBundle): ReviewBundle {
  const artifact = (kind: EngineArtifact["kind"]) => bundle.artifacts.find((item) => item.kind === kind);
  const failure = bundle.result.status === "passed" ? undefined : {
    message: bundle.result.error ?? bundle.result.message,
    location: bundle.result.failedStepIndex === undefined ? undefined : `Step ${bundle.result.failedStepIndex + 1}`,
  };
  return {
    id: bundle.id,
    title: bundle.plan.name,
    verdict: bundle.result.status === "passed" ? "passed" : bundle.result.status === "failed" ? "failed" : bundle.result.status === "compile_error" ? "compile_error" : "runner_error",
    target: { name: bundle.target.label, baseUrl: bundle.target.baseUrl },
    startedAt: bundle.result.startedAt,
    durationMs: bundle.result.durationMs,
    generatedTest: { filename: "generated.proof.spec.ts", source: bundle.generatedTest },
    steps: bundle.plan.steps.map((step, index) => ({
      id: `${index}-${step.kind}`,
      label: step.label ?? step.kind,
      detail: step.kind === "goto" ? step.path : step.kind === "expectText" ? step.text : "User-visible browser step",
      status: stepStatusFor(bundle.result.status, bundle.result.failedStepIndex, index),
    })),
    video: artifact("video") ? { src: artifact("video")!.path, label: "Fresh Playwright recording" } : undefined,
    screenshots: bundle.artifacts.filter((item) => item.kind === "screenshot").map((item, index) => ({
      id: `screenshot-${index}`,
      label: item.label,
      src: item.path,
    })),
    trace: artifact("trace") ? { label: "Download Playwright trace", href: artifact("trace")!.path } : undefined,
    terminal: bundle.terminalTranscript ?? undefined,
    interpretedBy: bundle.interpreter ? interpreterLabels[bundle.interpreter] : undefined,
    failure,
  };
}

/**
 * Only mark a step passed when an independent replay actually executed and
 * passed it. On a failed run, steps after the failing assertion never ran, so
 * they are skipped; if we could not identify the failing step, no step is
 * certified. Runner/compile errors certify nothing.
 */
function stepStatusFor(status: ReviewBundle["verdict"], failedStepIndex: number | undefined, index: number): "passed" | "failed" | "skipped" {
  if (status === "passed") return "passed";
  if (status === "failed") {
    if (failedStepIndex === undefined) return "skipped";
    if (index === failedStepIndex) return "failed";
    return index < failedStepIndex ? "passed" : "skipped";
  }
  return "skipped";
}
