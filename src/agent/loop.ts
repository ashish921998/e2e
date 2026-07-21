/**
 * The agent tool-use loop.
 *
 * Seed: system prompt + goal + PR diff + initial screenshot → model → execute
 * the returned tool calls in the E2B sandbox → feed back results + a fresh
 * screenshot → repeat until the model calls `finish` or the step cap is hit.
 *
 * Every browser tool appends a RecordedBrowserEvent to the session, so when the
 * loop ends the session renders straight into a replayable Playwright test via
 * deterministicPlanFromSession. The agent's *exploration* is the journey; the
 * *proof* is the independent replay of the recorded steps — never just the
 * model's word.
 */
import { randomUUID } from "node:crypto";
import type { RecordedSession } from "../proof/types";
import { redact } from "../proof/redact";
import { executeTool } from "./tools";
import type { ProofSandbox } from "./sandbox";
import type { ModelClient, ToolResultInput, UserBlock } from "./model";

export interface AgentGoal {
  /** What the agent must verify, in plain language. */
  goal: string;
  /** Optional unified diff or PR description to ground the agent on the change. */
  diff?: string;
  /** Optional additional context (PR title, commit message, etc.). */
  context?: string;
}

export interface LoopResult {
  session: RecordedSession;
  terminalTranscript: string;
  /** The agent's self-reported verdict (pass/fail) from the finish tool. */
  agentVerdict: { verdict: "pass" | "fail"; reason: string } | undefined;
  /** Why the loop terminated. */
  stoppedReason: "finish" | "step_cap" | "no_tool_calls";
  /** Per-step screenshots collected for the exploration video (label -> png). */
  screenshots: Map<string, Buffer>;
}

export interface LoopOptions {
  sandbox: ProofSandbox;
  model: ModelClient;
  baseUrl: string;
  targetId: string;
  goal: AgentGoal;
  maxSteps?: number;
  /** A live log sink for progress. */
  log?: (message: string) => void;
}

const DEFAULT_MAX_STEPS = 25;
const MAX_TRANSCRIPT_CHARS = 20_000;

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { sandbox, model, baseUrl, targetId } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const log = options.log ?? (() => {});

  const sessionId = `agent_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const session: RecordedSession = {
    id: sessionId,
    title: options.goal.goal.slice(0, 80) || "Agent verification",
    startedAt: new Date().toISOString(),
    targetId,
    events: [],
  };
  const terminal: string[] = [];
  const screenshots = new Map<string, Buffer>();

  const system = systemPrompt();
  const startBlocks = await initialUserBlocks(options.goal, baseUrl, sandbox);
  log(`model=${model.name} starting agent loop (max ${maxSteps} steps)`);

  let turn = await model.start(system, startBlocks);
  let step = 0;
  let agentVerdict: LoopResult["agentVerdict"] | undefined;
  let stoppedReason: LoopResult["stoppedReason"] = "no_tool_calls";

  while (step < maxSteps) {
    if (turn.text) log(`assistant: ${truncate(turn.text)}`);

    if (turn.toolCalls.length === 0) {
      // No tool calls and not finishing → nothing more to do.
      stoppedReason = "no_tool_calls";
      break;
    }

    const toolResults: ToolResultInput[] = [];
    for (const call of turn.toolCalls) {
      step += 1;
      log(`step ${step}: ${call.name} ${summarizeInput(call.name, call.input)}`);
      if (call.name === "finish") {
        agentVerdict = readFinish(call.input);
        return finalize({ session, terminal, screenshots, agentVerdict, stoppedReason: "finish" });
      }
      const executed = await executeTool(call, {
        sandbox,
        baseUrl,
        session,
        terminal,
        onScreenshot: (label, png) => {
          screenshots.set(`${step.toString().padStart(2, "0")}-${label}`, png);
        },
      });
      toolResults.push({
        callId: call.id,
        content: formatToolResult(call, executed),
        isError: !executed.result.ok,
      });
      if (!executed.result.ok) log(`  ✗ ${executed.result.error ?? executed.result.summary}`);
      else log(`  ✓ ${executed.result.summary}`);
    }

    if (step >= maxSteps) {
      stoppedReason = "step_cap";
      break;
    }

    // Fresh vision each turn so the model sees the current page.
    const screenshot = await safeScreenshot(sandbox);
    turn = await model.continue(toolResults, screenshot);
  }

  return finalize({ session, terminal, screenshots, agentVerdict, stoppedReason });
}

function finalize(input: {
  session: RecordedSession;
  terminal: string[];
  screenshots: Map<string, Buffer>;
  agentVerdict: LoopResult["agentVerdict"] | undefined;
  stoppedReason: LoopResult["stoppedReason"];
}): LoopResult {
  const terminalTranscript = redact(input.terminal.join("\n\n")).slice(0, MAX_TRANSCRIPT_CHARS);
  return {
    session: { ...input.session, completedAt: new Date().toISOString(), terminalTranscript },
    terminalTranscript,
    agentVerdict: input.agentVerdict,
    stoppedReason: input.stoppedReason,
    screenshots: input.screenshots,
  };
}

function systemPrompt(): string {
  return [
    "You are an autonomous web QA agent verifying a pull request against a live preview.",
    "You drive a real browser (via accessible role/name tools) and a shell, in an isolated sandbox.",
    "Use the provided tools only. Do not invent selectors, classes, or coordinates.",
    "Be efficient: navigate, interact, then assert the user-visible outcome.",
    "Call observe_role or observe_text to assert the feature works — the assertion becomes part of the replayable proof. A run with no assertion proves nothing and cannot pass, so always assert the user-visible outcome before finishing.",
    "Call bash for terminal checks (curl, logs) but remember bash output is evidence, not proof.",
    "When done, call finish with verdict 'pass' or 'fail' and a one-sentence reason.",
    "If a feature is missing or an assertion fails, call finish with verdict 'fail'.",
  ].join(" ");
}

async function initialUserBlocks(goal: AgentGoal, baseUrl: string, sandbox: ProofSandbox): Promise<UserBlock[]> {
  const parts: string[] = [
    `Base URL of the app under test: ${baseUrl}`,
    `Verification goal: ${goal.goal}`,
  ];
  if (goal.context) parts.push(`Context:\n${goal.context}`);
  if (goal.diff) {
    // Keep the diff small so it fits the context budget; it grounds the agent
    // on what changed but is never executed.
    const trimmed = goal.diff.length > 4_000 ? `${goal.diff.slice(0, 4_000)}\n…(diff truncated)` : goal.diff;
    parts.push(`Pull request diff:\n${trimmed}`);
  }
  parts.push("Begin: navigate to the relevant page and verify the goal.");
  const blocks: UserBlock[] = [{ type: "text", text: parts.join("\n\n") }];
  return blocks;
}

function formatToolResult(
  call: { name: string; input: Record<string, unknown> },
  executed: { result: { ok: boolean; summary: string; error?: string }; observation?: string },
): string {
  const lines = [executed.result.summary];
  if (executed.result.error) lines.push(`error: ${executed.result.error}`);
  if (executed.observation) lines.push(`page:\n${executed.observation}`);
  return lines.join("\n");
}

function readFinish(input: Record<string, unknown>): LoopResult["agentVerdict"] {
  const verdict = input.verdict === "pass" || input.verdict === "fail" ? input.verdict : "fail";
  const reason = typeof input.reason === "string" ? input.reason : "no reason given";
  return { verdict, reason };
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => (typeof input[k] === "string" ? `${k}=${String(input[k])}` : null)).filter(Boolean).join(" ");
  if (name === "goto") return pick("path");
  if (name === "click" || name === "observe_role") return pick("role", "name");
  if (name === "fill") return pick("role", "name", "value");
  if (name === "observe_text") return pick("text");
  if (name === "bash") return pick("command");
  if (name === "finish") return pick("verdict");
  return "";
}

function truncate(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

async function safeScreenshot(sandbox: ProofSandbox): Promise<Buffer | undefined> {
  try {
    return await sandbox.screenshot();
  } catch {
    return undefined;
  }
}
