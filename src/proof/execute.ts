/**
 * The portable proof runner: plan + target URL → render → run Playwright in a
 * fresh browser (video:"on") → collect artifacts → ProofBundle.
 *
 * This is the pure core of a Proof Run, with no app coupling. The Vite runtime
 * (`server/proofmode-runtime.ts`) imports it for the local UI flow, and the
 * `e2e-prove` CLI / agent use it to produce the deterministic replay that is
 * the actual verdict.
 */
import { mkdir, writeFile, readdir, lstat, unlink, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative } from "node:path";
import { spawnCollect } from "./spawn";
import {
  createProofBundle,
  renderPlaywrightTest,
  type ProofArtifact,
  type ProofBundle,
  type ProofPlan,
  type ProofTarget,
  type RunnerOutcome,
} from "./index";

export interface RunProofInput {
  plan: ProofPlan;
  target: ProofTarget;
  /** Directory the run owns. It must already exist; artifacts go to <runDir>/artifacts. */
  runDir: string;
  /** Override the cwd for the spawned Playwright process. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra env for the spawned process (e.g. an existing PATH). E2E_BASE_URL is always set. */
  env?: Record<string, string>;
  /** Called with the outcome so callers can persist evidence before this returns. */
  onBundle?: (bundle: ProofBundle) => Promise<void> | void;
}

export interface RunProofResult {
  bundle: ProofBundle;
  outcome: RunnerOutcome;
}

/**
 * Render the plan to a Playwright spec, run it once in a fresh browser, and
 * return the classified bundle. The generated test is the only JS that runs;
 * the plan is a constrained data format, never model-supplied source.
 */
export async function runProof(input: RunProofInput): Promise<RunProofResult> {
  const artifactsDir = join(input.runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const testPath = join(input.runDir, "proof.spec.ts");
  const testSource = renderPlaywrightTest(input.plan);
  await writeFile(testPath, testSource, "utf8");

  const outcome = await executePlaywright({
    runDir: input.runDir,
    artifactsDir,
    target: input.target,
    plan: input.plan,
    cwd: input.cwd,
    env: input.env,
  });
  // Drop the resolution symlink now Playwright has exited: it must not be
  // walked by collectArtifacts (which would recurse the whole dependency tree)
  // nor reachable through the Vite artifact server, which serves any path under
  // the run dir and would otherwise traverse the link out of it.
  //
  // Remove it ONLY if it is actually a symlink — the one linkPackageModules
  // created. If a REAL node_modules already occupied that path (linkPackageModules
  // no-op'd on EEXIST), lstat reports a directory and we leave it untouched
  // rather than deleting the consumer's dependency tree. A failed unlink is
  // surfaced to stderr instead of silently leaving the link to be walked.
  const linkPath = join(input.runDir, "node_modules");
  const linkStat = await lstat(linkPath).catch(() => null);
  if (linkStat?.isSymbolicLink()) {
    await unlink(linkPath).catch((error) => {
      process.stderr.write(`[proof] warning: could not remove resolution symlink ${linkPath}: ${String(error)}\n`);
    });
  }
  const artifacts = await collectArtifacts(input.runDir);
  const bundle = createProofBundle({
    id: input.runDir.split("/").pop() ?? "proof",
    plan: input.plan,
    target: input.target,
    outcome,
    artifacts,
  });
  await input.onBundle?.(bundle);
  return { bundle, outcome };
}

interface ExecuteInput {
  runDir: string;
  artifactsDir: string;
  target: ProofTarget;
  plan: ProofPlan;
  cwd?: string;
  env?: Record<string, string>;
}

async function executePlaywright(input: ExecuteInput): Promise<RunnerOutcome> {
  const startedAt = new Date().toISOString();
  const configPath = join(input.runDir, "playwright.config.ts");
  await writeFile(
    configPath,
    `import { defineConfig, devices } from "@playwright/test";\nexport default defineConfig({ testDir: ".", fullyParallel: false, workers: 1, reporter: [["list"]], use: { baseURL: process.env.E2E_BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure", video: "on", ...devices["Desktop Chrome"] } });\n`,
    "utf8",
  );
  const playwright = playwrightCommand();
  if (!playwright.nodeModules) {
    // The packaged Playwright CLI was unresolvable; we fell back to `npx`, which
    // means no symlink/NODE_PATH resolution and possibly a different version.
    process.stderr.write("[proof] warning: packaged Playwright not resolvable; falling back to `npx playwright` (replay may use a different version).\n");
  }
  // The generated config + spec live in the run dir (a tool-owned dir under the
  // consumer's cwd, with no node_modules) yet import "@playwright/test". Point
  // their resolution back at OUR install two ways, since Playwright may load
  // them as either ESM (symlink) or CJS (NODE_PATH). See linkPackageModules.
  const nodeModules = await linkPackageModules(input.runDir);
  // A caller-supplied NODE_PATH (input.env) is appended, not allowed to replace ours.
  const nodePath = [nodeModules, process.env.NODE_PATH, input.env?.NODE_PATH]
    .filter(Boolean)
    .join(delimiter);
  // Computed values are authoritative: spread caller env first so E2E_BASE_URL
  // and NODE_PATH can't be silently clobbered by input.env.
  const result = await spawnCollect(
    playwright.command,
    [...playwright.args, "test", "--config", configPath, "--output", input.artifactsDir],
    {
      cwd: input.cwd ?? process.cwd(),
      env: { ...(input.env ?? {}), E2E_BASE_URL: input.target.baseUrl, ...(nodePath ? { NODE_PATH: nodePath } : {}) },
    },
  );
  const completedAt = new Date().toISOString();
  // Playwright's list reporter writes the failure block (including the
  // `proof.spec.ts:<line>:<col>` reference) to stdout, while stderr carries
  // only Node warnings — search both for the failing step.
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const failedStepIndex = result.exitCode === 0 ? undefined : findFailedStepIndex(combinedOutput, input.plan.steps.length);
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

/**
 * Resolve THIS package's Playwright CLI so the replay works from any cwd —
 * `npx playwright` in a consumer repo that doesn't depend on Playwright would
 * download an arbitrary version (or fail). Falls back to npx only if the
 * package's own install is somehow unresolvable.
 */
function playwrightCommand(): { command: string; args: string[]; nodeModules?: string } {
  try {
    const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
    // .../node_modules/@playwright/test/cli.js → .../node_modules
    return { command: process.execPath, args: [cli], nodeModules: dirname(dirname(dirname(cli))) };
  } catch {
    return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["playwright"] };
  }
}

/** Resolve THIS package's node_modules dir (where @playwright/test lives), or undefined. */
export function packageNodeModules(): string | undefined {
  return playwrightCommand().nodeModules;
}

/**
 * Link this package's node_modules into the run dir so the generated ESM
 * config/spec can resolve "@playwright/test" — Node ignores NODE_PATH for ESM
 * `import`, so a symlink it walks up from the run dir is the mechanism that
 * works. Returns the linked path so the caller can also mirror it onto
 * NODE_PATH for the CJS load path. Best-effort: a pre-existing node_modules or
 * an unsupported symlink is swallowed.
 */
export async function linkPackageModules(runDir: string): Promise<string | undefined> {
  const nodeModules = packageNodeModules();
  if (nodeModules) {
    await symlink(nodeModules, join(runDir, "node_modules"), "junction").catch(() => {});
  }
  return nodeModules;
}

/** A missing browser binary or a Playwright install failure is a runner problem, not a product failure. */
function inferFailurePhase(result: { stderr: string; stdout: string }): "compile" | "runner" | "test" {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/executable doesn't exist|playwright.*not found|command not found|ENOTDIR|err_spawn|spawn npx/i.test(text)) return "runner";
  if (/SyntaxError|Could not transform|Transform failed|failed to import/i.test(text)) return "compile";
  return "test";
}

async function collectArtifacts(runDir: string): Promise<ProofArtifact[]> {
  const entries = await filesBelow(runDir);
  const result: ProofArtifact[] = [];
  for (const path of entries) {
    const rel = relative(runDir, path).replaceAll("\\", "/");
    // Mirror the Vite runtime's artifact URLs so the reviewer can serve them,
    // while leaving the path relative for CLI callers that bundle raw files.
    const kind = artifactKind(rel);
    if (!kind) continue;
    result.push({
      kind,
      label: rel,
      path: rel,
      ...(kind === "video" ? { mimeType: "video/webm" } : {}),
      ...(kind === "screenshot" ? { mimeType: "image/png" } : {}),
      ...(kind === "trace" ? { mimeType: "application/zip" } : {}),
    });
  }
  return result;
}

export function artifactKind(rel: string): ProofArtifact["kind"] | undefined {
  if (rel.endsWith(".webm")) return "video";
  if (rel.endsWith(".png")) return "screenshot";
  if (rel.endsWith(".zip")) return "trace";
  if (rel.endsWith(".spec.ts")) return "test";
  return undefined;
}

async function filesBelow(path: string): Promise<string[]> {
  const children = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    children.map(async (entry) => (entry.isDirectory() ? filesBelow(join(path, entry.name)) : [join(path, entry.name)])),
  );
  return nested.flat();
}
