import {
  PROOF_PLAN_VERSION,
  createProofBundle,
  defineTargets,
  deterministicPlanFromSession,
  renderPlaywrightTest,
  type ProofBundle as EngineProofBundle,
  type ProofTarget,
  type RecordedSession,
} from "./index";
import type { ProofBundle as ReviewBundle } from "../components/proof";

const runStartedAt = "2026-07-19T09:41:12.000Z";

export const demoTargets = defineTargets([
  {
    id: "local",
    label: "Local / updated branch",
    kind: "local",
    baseUrl: "http://127.0.0.1:4173",
    description: "Current working tree with the low-stock warning.",
  },
  {
    id: "production",
    label: "Production / previous release",
    kind: "production",
    baseUrl: "http://127.0.0.1:4174",
    description: "Controlled older build without the low-stock warning.",
  },
]);

const recordedSession: RecordedSession = {
  id: "session_low_stock_3",
  title: "shows a warning when stock is low",
  startedAt: runStartedAt,
  completedAt: "2026-07-19T09:41:21.000Z",
  targetId: "local",
  terminalTranscript: [
    "$ rg \"stockRemaining\" src",
    "src/demo-product.ts: stockRemaining: 3",
    "$ npm run dev:local",
    "✓ Vintage Camera loaded in Chrome",
  ].join("\n"),
  events: [
    { type: "navigate", at: runStartedAt, path: "/", label: "Open the Vintage Camera page" },
    { type: "observe", at: "2026-07-19T09:41:19.000Z", role: "heading", accessibleName: "Vintage Camera", text: "Vintage Camera", label: "Confirm the product loaded" },
    // The status element has no accessible name; the recorder captures text
    // only for role="status", so the deterministic plan emits expectText.
    { type: "observe", at: "2026-07-19T09:41:21.000Z", role: "status", text: "Only 3 left", label: "Confirm the low-stock warning" },
  ],
};

const diff = `diff --git a/src/main.tsx b/src/main.tsx
@@
+ <p className="low-stock" role="status" aria-live="polite">
+   Only {demoProduct.stockRemaining} left
+ </p>`;

function buildEngineBundle(target: ProofTarget, shouldPass: boolean, session: RecordedSession = recordedSession): EngineProofBundle {
  const interpretation = deterministicPlanFromSession(session);
  if (!interpretation.ok) throw new Error(interpretation.error);
  return createProofBundle({
    id: shouldPass ? "proof_8f2a91" : "proof_8f2a91_prod",
    plan: interpretation.plan,
    target,
    outcome: {
      exitCode: shouldPass ? 0 : 1,
      phase: "test",
      failedStepIndex: shouldPass ? undefined : 2,
      startedAt: runStartedAt,
      completedAt: shouldPass ? "2026-07-19T09:41:25.482Z" : "2026-07-19T09:41:25.913Z",
      stderr: shouldPass ? undefined : "Expected visible status \"Only 3 left\". Received no matching element.",
    },
    artifacts: [
      { kind: "test", label: "Generated test", path: "proofs/proof_8f2a91.spec.ts" },
      { kind: "diff", label: "Implementation diff", path: "proofs/proof_8f2a91.diff" },
      { kind: "terminal", label: "Terminal transcript", path: "proofs/terminal.cast" },
      { kind: "trace", label: "Playwright trace", path: "proofs/trace.zip" },
    ],
  });
}

export function makeDemoReviewBundle(targetId: "local" | "production"): ReviewBundle {
  const target = demoTargets[targetId];
  const isLocal = targetId === "local";
  const bundle = buildEngineBundle(target, isLocal);
  return {
    id: bundle.id,
    title: bundle.plan.name,
    verdict: bundle.result.status === "passed" ? "passed" : "failed",
    target: {
      name: target.label,
      baseUrl: target.baseUrl,
      revision: isLocal ? "working tree · 6bb1f4e" : "release · v0.0.0",
    },
    startedAt: bundle.result.startedAt,
    durationMs: bundle.result.durationMs,
    generatedTest: { filename: "low-stock.proof.spec.ts", source: bundle.generatedTest },
    diff,
    terminal: recordedSession.terminalTranscript,
    steps: [
      { id: "open", label: "Open the Vintage Camera page", detail: "GET /", status: "passed", timestamp: "09:41:22" },
      { id: "heading", label: "Confirm the product loaded", detail: "heading: Vintage Camera", status: "passed", timestamp: "09:41:23" },
      { id: "warning", label: "Confirm the low-stock warning", detail: "status: Only 3 left", status: isLocal ? "passed" : "failed", timestamp: "09:41:25" },
    ],
    trace: { label: "Playwright trace", href: "#trace" },
    ...(isLocal
      ? {}
      : {
          video: {
            src: "/test-results/low-stock-shows-a-warning-when-stock-is-low-chromium/video.webm",
            label: "Fresh Playwright recording",
          },
          screenshots: [
            {
              id: "assertion-failure",
              label: "Failure state — warning absent",
              src: "/test-results/low-stock-shows-a-warning-when-stock-is-low-chromium/test-failed-1.png",
              timestamp: "09:41:25",
            },
          ],
        }),
    failure: isLocal ? undefined : { message: bundle.result.error ?? "The low-stock warning was absent on this target.", location: "expectText('Only 3 left')" },
    interpretedBy: "Deterministic fallback",
  };
}

/**
 * Build the pre-run reviewer state for a browser session captured on this
 * device. No replay has happened yet, so this is intentionally not a verdict:
 * the generated test is a preview, every step is skipped, and there is no
 * duration, revision, diff, video, or failure. The honest verdict only
 * appears after `Run fresh replay` posts the session to /api/proof-runs.
 */
export function makeReviewBundleFromSession(session: RecordedSession, targetId: "local" | "production"): ReviewBundle {
  const target = demoTargets[targetId];
  const interpretation = deterministicPlanFromSession(session);
  if (!interpretation.ok) throw new Error(interpretation.error);
  return {
    id: `proof_${session.id.slice(-10)}`,
    title: interpretation.plan.name,
    verdict: "incomplete",
    target: { name: target.label, baseUrl: target.baseUrl },
    generatedTest: { filename: "generated.proof.spec.ts", source: renderPlaywrightTest(interpretation.plan) },
    steps: interpretation.plan.steps.map((step, index) => ({
      id: `${index}-${step.kind}`,
      label: step.label ?? step.kind,
      detail: step.kind === "goto" ? step.path : step.kind === "expectText" ? step.text : "User-visible browser step",
      status: "skipped",
    })),
    terminal: session.terminalTranscript,
  };
}

export const proofPlanVersion = PROOF_PLAN_VERSION;
