/**
 * e2e-prove — the CLI anyone runs. (Real entry; run via tsx.)
 *
 *   e2e-prove --url <baseURL> [--goal "..."] [--diff <file>] [--out <dir>]
 *
 * Flow: start an E2B sandbox (Chrome + terminal) → run the agent loop against
 * --url → RecordedSession → deterministicPlanFromSession → runProof() (the
 * engine replays it in a fresh browser with video:"on") → emit bundle.json, the
 * agent-exploration video (from per-step screenshots) and the deterministic
 * replay video (from the engine), and the generated test into --out.
 *
 * Exit code = the verdict (0 passed / non-zero otherwise) so CI gates on it.
 * A `passed` verdict requires all three: the recorded plan has an assertion
 * step, the agent finished with verdict "pass", and the independent replay
 * passed. See src/proof/verdict.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startSandbox } from "../src/agent/sandbox";
import { TOOL_DESCRIPTORS } from "../src/agent/tools";
import { pickClient } from "../src/agent/model";
import { runAgentLoop } from "../src/agent/loop";
import { buildAgentVideo } from "../src/agent/video";
import { deterministicPlanFromSession, normaliseBaseUrl } from "../src/proof/index";
import { redact } from "../src/proof/redact";
import { runProof } from "../src/proof/execute";
import { decideVerdict } from "../src/proof/verdict";
import type { ProofPlan, ProofStatus, ProofTarget } from "../src/proof/types";
import { parseArgs, usage } from "./args";

// First output ASAP: the .mjs launcher's cold-start watchdog disarms on the
// child's first stderr byte. This line is what tells it the tsx loader came up.
process.stderr.write("[e2e-prove] cli loaded\n");

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  process.stdout.write(usage());
  process.exit(args.help ? 0 : 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[e2e-prove] error: ${redact(message)}\n`);
  process.exit(2);
});

async function main(): Promise<void> {
// The module-level guard above already exited when --url was missing.
const baseUrl = normaliseBaseUrl(args.url!);
const outDir = resolve(args.out ?? "./proof-out");
await mkdir(outDir, { recursive: true });

const goal = args.goal ?? "Verify the app loads and the primary user flow works.";
const diff = args.diff ? readFileSync(resolve(args.diff), "utf8") : undefined;
const targetId = args.targetId ?? "preview";

const log = (message: string): void => {
  process.stderr.write(`[e2e-prove] ${message}\n`);
};

// 1. Boot the sandbox.
const sandbox = await startSandbox();
log(`sandbox ready; live view: ${sandbox.streamUrl()}`);

// exitCode is set inside the try, then process.exit runs AFTER the finally so
// the async sandbox.close() teardown actually completes. Calling process.exit
// inside the try would halt the loop first and leak the E2B sandbox each run.
let exitCode = 0;
try {
// 2. Run the agent loop to produce a RecordedSession.
  const model = pickClient(process.env, {
    tools: TOOL_DESCRIPTORS,
    ...(args.model ? { model: args.model } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
  });
  const loop = await runAgentLoop({
    sandbox,
    model,
    baseUrl,
    targetId,
    goal: { goal, diff, context: process.env.E2E_PROVE_CONTEXT },
    maxSteps: args.maxSteps ? Number(args.maxSteps) : undefined,
    log,
  });
  log(`agent ${loop.stoppedReason}; verdict=${loop.agentVerdict?.verdict ?? "n/a"} (${loop.agentVerdict?.reason ?? ""})`);

  await writeFile(join(outDir, "agent-session.json"), `${JSON.stringify(loop.session, null, 2)}\n`, "utf8");

  // 3. Agent-exploration video from screenshots (best-effort; needs ffmpeg).
  const explorationVideo = join(outDir, "agent-exploration.mp4");
  const videoResult = await buildAgentVideo({ screenshots: loop.screenshots, output: explorationVideo, log });
  if (videoResult.ok) log(`agent-exploration video: ${explorationVideo}`);
  else log(`no agent-exploration video (${videoResult.reason})`);

  // 4. Deterministic replay: the session → plan → runProof (fresh browser, video:on).
  const planDir = join(outDir, "replay");
  await mkdir(planDir, { recursive: true });
  const interpretation = deterministicPlanFromSession(loop.session);
  let replayStatus: ProofStatus | undefined;
  let plan: ProofPlan | null = null;
  let interpreterSource: string | undefined;
  if (!interpretation.ok) {
    log(`deterministic plan invalid: ${interpretation.error}`);
  } else {
    plan = interpretation.plan;
    interpreterSource = interpretation.source;
    await writeFile(
      join(planDir, "plan.json"),
      `${JSON.stringify({ plan: interpretation.plan, source: interpretation.source }, null, 2)}\n`,
      "utf8",
    );

    if (args.noReplay !== true) {
      const target: ProofTarget = { id: targetId, label: `Preview (${targetId})`, kind: "preview", baseUrl };
      log("running deterministic replay in a fresh browser (video:on)…");
      const { bundle } = await runProof({ plan: interpretation.plan, target, runDir: planDir });
      await writeFile(join(planDir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      replayStatus = bundle.result.status;
      log(`replay verdict: ${replayStatus}`);
    } else {
      log("deterministic replay skipped (--no-replay)");
    }
  }

  // 5. Gate on ALL THREE signals: plan has an assertion, agent passed, replay
  // passed. The replay alone is not enough — a nav-only session replays green
  // and proves nothing, and an agent `fail` is not overridden by a green replay.
  const decision = decideVerdict({ plan, agentVerdict: loop.agentVerdict, replayStatus });
  log(`verdict: ${decision.status} — ${decision.reason}`);
  await writeSummary(outDir, {
    status: decision.status,
    agentVerdict: loop.agentVerdict,
    interpreter: interpreterSource,
    replayDir: args.noReplay ? undefined : "replay",
    replaySkipped: args.noReplay ? true : undefined,
    decision: { reason: decision.reason, signals: decision.signals },
    ...(videoResult.ok ? { explorationVideo: "agent-exploration.mp4" } : {}),
    ...(!interpretation.ok ? { error: interpretation.error } : {}),
  });
  exitCode = decision.passed ? 0 : decision.status === "incomplete" ? 2 : 1;
} finally {
  await sandbox.close().catch((error: unknown) => {
    log(`sandbox close failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
process.exit(exitCode);
}

interface Summary {
  status: ProofStatus;
  agentVerdict?: { verdict: "pass" | "fail"; reason: string };
  interpreter?: string;
  replayDir?: string;
  replaySkipped?: boolean;
  explorationVideo?: string;
  error?: string;
  /** Why the verdict was decided, plus the three signals it was based on. */
  decision?: {
    reason: string;
    signals: {
      hasAssertion: boolean;
      agentVerdict?: { verdict: "pass" | "fail"; reason: string };
      replayStatus?: ProofStatus;
    };
  };
}

async function writeSummary(outDir: string, summary: Summary): Promise<void> {
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify({ format: "e2e-prove/v1", generatedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
    "utf8",
  );
}
