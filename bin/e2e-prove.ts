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
import { runProof } from "../src/proof/execute";
import type { ProofStatus, ProofTarget } from "../src/proof/types";

interface ParsedArgs {
  url?: string;
  goal?: string;
  diff?: string;
  out?: string;
  targetId?: string;
  maxSteps?: string;
  model?: string;
  noReplay?: boolean;
  help?: boolean;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  process.stdout.write(usage());
  process.exit(args.help ? 0 : 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[e2e-prove] error: ${message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")}\n`);
  process.exit(2);
});

async function main(): Promise<void> {
const baseUrl = normaliseBaseUrl(args.url);
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
  if (!interpretation.ok) {
    log(`deterministic plan invalid: ${interpretation.error}`);
    await writeSummary(outDir, { status: "incomplete", agentVerdict: loop.agentVerdict, error: interpretation.error });
    exitCode = 2;
  } else {
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
      log(`replay verdict: ${bundle.result.status}`);
      await writeSummary(outDir, {
        status: bundle.result.status,
        agentVerdict: loop.agentVerdict,
        interpreter: interpretation.source,
        replayDir: "replay",
        ...(videoResult.ok ? { explorationVideo: "agent-exploration.mp4" } : {}),
      });
      // CI gate: 0 only when the independent replay passed.
      exitCode = bundle.result.status === "passed" ? 0 : 1;
    } else {
      // Exploration-only: the agent's verdict is informational and is NEVER the
      // gate. Only an independent replay can produce a `passed` verdict, so a
      // skipped replay is `incomplete` and always exits non-zero. This keeps the
      // core guarantee (loop.ts: "the proof is the independent replay, never just
      // the model's word") even when --no-replay is used.
      await writeSummary(outDir, {
        status: "incomplete",
        agentVerdict: loop.agentVerdict,
        interpreter: interpretation.source,
        replaySkipped: true,
        ...(videoResult.ok ? { explorationVideo: "agent-exploration.mp4" } : {}),
      });
      exitCode = 2;
    }
  }
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
}

async function writeSummary(outDir: string, summary: Summary): Promise<void> {
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify({ format: "e2e-prove/v1", generatedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
    "utf8",
  );
}

function usage(): string {
  return [
    "e2e-prove — agentic web proof on E2B",
    "",
    "Usage: e2e-prove --url <baseURL> [options]",
    "",
    "Options:",
    "  --url <url>        Base URL of the app to verify (required).",
    "  --goal <text>      What to verify (default: a generic smoke check).",
    "  --diff <file>      Path to a unified diff / PR description to ground the agent.",
    "  --out <dir>        Output directory (default: ./proof-out).",
    "  --target-id <id>   Target id recorded in the bundle (default: 'preview').",
    "  --max-steps <n>    Agent step cap (default: 25).",
    "  --model <id>       Override the model id.",
    "  --no-replay        Skip the deterministic replay (exploration only; exits non-zero — never a pass gate).",
    "  -h, --help         Show this help.",
    "",
    "Environment: E2B_API_KEY (required) + ANTHROPIC_API_KEY | OPENAI_API_KEY (one required).",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (key === "no-replay") {
        out.noReplay = true;
        continue;
      }
      if (next === undefined || next.startsWith("--")) continue;
      switch (key) {
        case "url": out.url = next; break;
        case "goal": out.goal = next; break;
        case "diff": out.diff = next; break;
        case "out": out.out = next; break;
        case "target-id": out.targetId = next; break;
        case "max-steps": out.maxSteps = next; break;
        case "model": out.model = next; break;
      }
      i++;
    }
  }
  return out;
}
