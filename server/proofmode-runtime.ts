import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Plugin, ViteDevServer } from "vite";
import {
  GptSessionInterpreter,
  deterministicPlanFromSession,
  getTarget,
  defineTargets,
  createProofBundle,
  renderPlaywrightTest,
  type ModelProofClient,
  type ProofArtifact,
  type ProofBundle,
  type ProofPlan,
  type ProofTarget,
  type RecordedSession,
} from "../src/proof";
import { redact } from "../src/proof/redact";

const ROOT = resolve(process.cwd());
const RUNS_ROOT = join(ROOT, "proof-runs");
const MAX_BODY_BYTES = 512_000;
const MAX_TRANSCRIPT_CHARS = 20_000;

type RuntimeRequest = { session: RecordedSession; targetId: string; preferModel?: boolean };
type SerializedBundle = ProofBundle & {
  interpreter?: "model" | "deterministic-fallback";
  terminalTranscript?: string;
  runUrl?: string;
};

/**
 * Local-only Vite middleware. It intentionally accepts constrained session
 * data, creates the test through the existing proof compiler, and runs it in
 * a fresh Playwright process. It is not registered in production builds.
 */
export function proofModeRuntime(): Plugin {
  return {
    name: "proofmode-runtime",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname.startsWith("/proof-runs/")) {
          await serveArtifact(pathname, res);
          return;
        }
        if (pathname === "/api/proof-runs" && req.method === "POST") {
          await handleRun(req, res, server);
          return;
        }
        if (pathname === "/api/proof-runs" && req.method === "GET") {
          sendJson(res, 200, { endpoint: "POST /api/proof-runs", status: "ready" });
          return;
        }
        next();
      });
    },
  };
}

async function handleRun(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, server: ViteDevServer) {
  try {
    const body = await readJson(req);
    const request = validateRequest(body);
    if (!request.ok) return sendJson(res, 400, { error: request.error });

    const registry = targetsForRequest(req);
    let target: ProofTarget;
    try { target = getTarget(registry, request.value.targetId); }
    catch (error) { return sendJson(res, 400, { error: safeMessage(error) }); }

    const runId = `proof_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runDir = join(RUNS_ROOT, runId);
    await mkdir(join(runDir, "artifacts"), { recursive: true });

    const interpreter = request.value.preferModel && process.env.OPENAI_API_KEY
      ? new GptSessionInterpreter(new ResponsesProofClient(process.env.OPENAI_API_KEY))
      : null;
    const interpretation = interpreter
      ? await interpreter.interpret(request.value.session)
      : deterministicPlanFromSession(request.value.session);
    if (!interpretation.ok) return sendJson(res, 422, { error: interpretation.error });

    const testPath = join(runDir, "proof.spec.ts");
    const planPath = join(runDir, "plan.json");
    const testSource = renderPlaywrightTest(interpretation.plan);
    await writeFile(testPath, testSource, "utf8");
    await writeFile(planPath, JSON.stringify({ plan: interpretation.plan, source: interpretation.source }, null, 2), "utf8");
    const safeSession = redactSession(request.value.session);
    await writeFile(join(runDir, "session.json"), JSON.stringify(safeSession, null, 2), "utf8");

    const outcome = await executePlaywright(runDir, join(runDir, "artifacts"), target, interpretation.plan);
    const artifacts = await collectArtifacts(runDir);
    const bundle = createProofBundle({ id: runId, plan: interpretation.plan, target, outcome, artifacts });
    const serialized: SerializedBundle = {
      ...bundle,
      interpreter: interpretation.source,
      terminalTranscript: safeSession.terminalTranscript,
      runUrl: `/proof-runs/${runId}/`,
    };
    await writeFile(join(runDir, "result.json"), JSON.stringify(serialized, null, 2), "utf8");
    sendJson(res, 200, serialized);
  } catch (error) {
    sendJson(res, 500, { error: "Proof runner could not complete.", detail: safeMessage(error) });
  }
}

function targetsForRequest(req: import("node:http").IncomingMessage) {
  const host = req.headers.host ?? "127.0.0.1";
  const localBaseUrl = process.env.PROOFMODE_LOCAL_URL ?? `http://${host}`;
  const targets: ProofTarget[] = [{ id: "local", label: "Local development server", kind: "local", baseUrl: localBaseUrl }];
  // Deliberately opt-in: a browser request cannot choose an arbitrary host.
  if (process.env.PROOFMODE_PRODUCTION_URL) {
    targets.push({ id: "production", label: "Production", kind: "production", baseUrl: process.env.PROOFMODE_PRODUCTION_URL });
  }
  return defineTargets(targets);
}

async function executePlaywright(runDir: string, outputDir: string, target: ProofTarget, plan: ProofPlan) {
  const startedAt = new Date().toISOString();
  const configPath = join(runDir, "playwright.config.ts");
  await writeFile(configPath, `import { defineConfig, devices } from "@playwright/test";\nexport default defineConfig({ testDir: ".", fullyParallel: false, workers: 1, reporter: [["list"]], use: { baseURL: process.env.E2E_BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure", video: "on", ...devices["Desktop Chrome"] } });\n`, "utf8");
  const result = await command(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "test", "--config", configPath, "--output", outputDir], {
    E2E_BASE_URL: target.baseUrl,
  });
  const completedAt = new Date().toISOString();
  // Playwright's list reporter writes the failure block (including the
  // `proof.spec.ts:<line>:<col>` reference) to stdout, while stderr carries
  // only Node warnings — search both for the failing step.
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const failedStepIndex = result.exitCode === 0 ? undefined : findFailedStepIndex(combinedOutput, plan.steps.length);
  const phase = result.exitCode === 0 ? ("test" as const) : inferFailurePhase(result);
  return { ...result, stderr: result.exitCode === 0 ? "" : result.stderr, startedAt, completedAt, failedStepIndex, phase };
}

/**
 * The generated test renders one plan step per source line, with the first
 * step at line 5 (1-indexed): line 1 import, 2 blank, 3 test(), 4 intent
 * comment. Playwright's failure output references the failing assertion with
 * `proof.spec.ts:<line>:<col>`. Map that back to a step index so the reviewer
 * can mark the right step failed and later steps skipped.
 */
function findFailedStepIndex(stderr: string, stepCount: number): number | undefined {
  const lines = [...stderr.matchAll(/proof\.spec\.ts:(\d+):\d+/g)].map((match) => Number(match[1]));
  // Line 3 is the test() declaration header shown by the list reporter; ignore it.
  const stepLines = lines.filter((line) => line >= 5);
  if (stepLines.length === 0) return undefined;
  const failingLine = stepLines[stepLines.length - 1];
  const index = failingLine - 5;
  return index >= 0 && index < stepCount ? index : undefined;
}

/** A missing browser binary or a Playwright install failure is a runner problem, not a product failure. */
function inferFailurePhase(result: { stderr: string; stdout: string }): "compile" | "runner" | "test" {
  const text = combinedOutputFor(result);
  if (/executable doesn't exist|playwright.*not found|command not found|ENOTDIR|err_spawn|spawn npx/i.test(text)) return "runner";
  if (/SyntaxError|Could not transform|Transform failed|failed to import/i.test(text)) return "compile";
  return "test";
}

function combinedOutputFor(result: { stderr: string; stdout: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

class ResponsesProofClient implements ModelProofClient {
  constructor(private readonly apiKey: string) {}
  async createProofPlan(input: { session: RecordedSession; instructions: string }): Promise<unknown> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6", instructions: input.instructions, input: JSON.stringify(redactSession(input.session)), text: { format: { type: "json_object" } } }),
    });
    if (!response.ok) throw new Error(`Model interpretation unavailable (${response.status}).`);
    const payload = await response.json() as {
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    // The raw Responses REST payload returns an `output` array of message
    // items; `output_text` is an SDK convenience and is usually absent here.
    const text = payload.output_text ?? extractResponsesText(payload.output);
    if (!text) throw new Error("Model returned no proof plan.");
    return JSON.parse(text);
  }
}

function extractResponsesText(output: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined): string | undefined {
  for (const item of output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string" && part.text.trim()) return part.text;
    }
  }
  return undefined;
}

function validateRequest(value: unknown): { ok: true; value: RuntimeRequest } | { ok: false; error: string } {
  if (!isRecord(value) || !isRecord(value.session) || typeof value.targetId !== "string") return { ok: false, error: "Expected { session, targetId }." };
  const session = value.session as unknown as RecordedSession;
  if (!isNonEmpty(session.id) || !isNonEmpty(session.title) || !isNonEmpty(session.startedAt) || !isNonEmpty(session.targetId) || !Array.isArray(session.events) || session.events.length === 0 || session.events.length > 100) {
    return { ok: false, error: "Session must have id, title, startedAt, targetId, and 1-100 events." };
  }
  if (!session.events.every(validEvent)) return { ok: false, error: "Session contains an invalid browser event." };
  return { ok: true, value: { session, targetId: value.targetId, preferModel: value.preferModel === true } };
}

function validEvent(event: unknown): boolean {
  if (!isRecord(event) || !isNonEmpty(event.type) || !isNonEmpty(event.at)) return false;
  if (event.type === "navigate") return typeof event.path === "string" && /^\/(?!\/)/.test(event.path);
  if (event.type === "observe") return typeof event.text === "string" && event.text.length <= 2_000;
  return ["click", "fill", "select"].includes(event.type) && optionalString(event.role) && optionalString(event.accessibleName) && optionalString(event.value);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function collectArtifacts(runDir: string): Promise<ProofArtifact[]> {
  const entries = await filesBelow(runDir); const result: ProofArtifact[] = [];
  for (const path of entries) {
    const rel = relative(runDir, path).replaceAll("\\", "/");
    const kind = rel.endsWith(".webm") ? "video" : rel.endsWith(".png") ? "screenshot" : rel.endsWith(".zip") ? "trace" : rel.endsWith(".spec.ts") ? "test" : undefined;
    if (kind) result.push({ kind, label: rel, path: `/proof-runs/${relative(RUNS_ROOT, path).replaceAll("\\", "/")}`, mimeType: kind === "video" ? "video/webm" : kind === "screenshot" ? "image/png" : undefined });
  }
  return result;
}

async function filesBelow(path: string): Promise<string[]> {
  const children = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(children.map(async (entry) => entry.isDirectory() ? filesBelow(join(path, entry.name)) : [join(path, entry.name)]));
  return nested.flat();
}

async function serveArtifact(pathname: string, res: import("node:http").ServerResponse) {
  const requested = normalize(join(RUNS_ROOT, pathname.slice("/proof-runs/".length)));
  if (!requested.startsWith(`${RUNS_ROOT}/`) || !existsSync(requested) || (await stat(requested)).isDirectory()) { res.statusCode = 404; res.end("Not found"); return; }
  const mime = requested.endsWith(".webm") ? "video/webm" : requested.endsWith(".png") ? "image/png" : requested.endsWith(".zip") ? "application/zip" : requested.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" }); res.end(await readFile(requested));
}

function command(commandName: string, args: string[], extraEnv: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(commandName, args, { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveResult({ exitCode: 1, stdout, stderr: error.message }));
    child.on("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function redactSession(session: RecordedSession): RecordedSession {
  return { ...session, terminalTranscript: session.terminalTranscript ? redact(session.terminalTranscript).slice(0, MAX_TRANSCRIPT_CHARS) : undefined };
}
function sendJson(res: import("node:http").ServerResponse, status: number, value: unknown) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
function safeMessage(error: unknown) { return error instanceof Error ? error.message.replace(/sk-[\w-]+/g, "[REDACTED]") : "Unexpected error"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length < 2_000; }
function optionalString(value: unknown): boolean { return value === undefined || (typeof value === "string" && value.length < 2_000); }
