export type ProofVerdict = "passed" | "failed" | "compile_error" | "runner_error" | "running" | "incomplete";

export interface ProofStep {
  id: string;
  label: string;
  detail?: string;
  status: "passed" | "failed" | "skipped" | "running";
  timestamp?: string;
}

export interface ProofScreenshot {
  id: string;
  label: string;
  src: string;
  timestamp?: string;
}

export interface ProofArtifact {
  label: string;
  href: string;
}

/**
 * The stable UI contract for a completed (or currently running) proof.
 * Keep this deliberately transport-friendly: the runner can serialize it as JSON.
 */
export interface ProofBundle {
  id: string;
  title: string;
  verdict: ProofVerdict;
  target: {
    name: string;
    baseUrl?: string;
    revision?: string;
  };
  startedAt?: string;
  durationMs?: number;
  generatedTest?: {
    filename?: string;
    source: string;
  };
  diff?: string;
  steps: ProofStep[];
  video?: {
    src: string;
    poster?: string;
    label?: string;
  };
  screenshots?: ProofScreenshot[];
  trace?: ProofArtifact;
  terminal?: string;
  failure?: {
    message: string;
    location?: string;
  };
  /** Provenance for the proof plan: who translated the session into the constrained plan. */
  interpretedBy?: string;
}
