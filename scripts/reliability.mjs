#!/usr/bin/env node

/**
 * Rehearse the ProofMode golden path end-to-end through the real product
 * pipeline: POST a fixture RecordedSession to /api/proof-runs on the live dev
 * server and assert the returned Proof Bundle verdicts. The updated target
 * must pass; the older target must fail. The generated test written out by
 * this rehearsal is the test the proof compiler actually produced from the
 * session — not the hand-written spec — so the export sidecar is honest about
 * its origin. Every Playwright artifact stays in proof-runs/<run id>/ for
 * inspection after the command finishes.
 */
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = new Date().toISOString();
const runDir = join(root, "proof-runs", runId);
const localPort = process.env.PROOFMODE_LOCAL_PORT ?? "4173";
const olderPort = process.env.PROOFMODE_OLDER_PORT ?? "4174";
const localUrl = `http://127.0.0.1:${localPort}`;
const olderUrl = `http://127.0.0.1:${olderPort}`;
const servers = [];

// A fixture RecordedSession shaped exactly like a browser capture from the
// shop page. The proof compiler turns this into a constrained Playwright test.
const fixtureSession = {
  id: "session_reliability_fixture",
  title: "shows a warning when stock is low",
  startedAt: new Date().toISOString(),
  targetId: "local",
  events: [
    { type: "navigate", at: new Date().toISOString(), path: "/", label: "Open the Vintage Camera page" },
    { type: "observe", at: new Date().toISOString(), role: "heading", accessibleName: "Vintage Camera", text: "Vintage Camera", label: "Confirm the product loaded" },
    // The status element has no accessible name (the recorder captures text
    // only for role="status"), so the deterministic plan emits expectText.
    { type: "observe", at: new Date().toISOString(), role: "status", text: "Only 3 left", label: "Confirm the low-stock warning" },
  ],
};

function startServer(script, port) {
  // Never silently accept Vite's next-free-port fallback. A successful replay
  // against the wrong server is worse than a failed rehearsal.
  // The updated server hosts the /api/proof-runs runtime; give it the older
  // target URL so the runtime can accept targetId "production".
  const env = { ...process.env };
  if (script === "dev:local") env.PROOFMODE_PRODUCTION_URL = olderUrl;
  const child = spawn("npm", ["run", script, "--", "--port", port, "--strictPort"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  servers.push(child);
  return child;
}

async function waitFor(url, label) {
  // Vite cold-start on this machine has been observed >60s; allow up to 180s
  // so a slow first boot doesn't read as a product regression.
  const deadline = Date.now() + 180_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}: ${lastError}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive the real product pipeline: POST the fixture session to the live
 * /api/proof-runs endpoint and return the serialized Proof Bundle. The
 * runtime compiles the plan, renders the test, spawns Playwright in a fresh
 * browser, and persists artifacts — the same path the reviewer uses.
 */
async function runProofPipeline(name, targetId) {
  const bundleDir = join(runDir, name);
  await mkdir(bundleDir, { recursive: true });
  const response = await fetch(`${localUrl}/api/proof-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: fixtureSession, targetId, preferModel: false }),
  });
  const payload = await response.json().catch(() => ({ error: "non-json response" }));
  if (!response.ok) {
    await writeFile(join(bundleDir, "error.json"), `${JSON.stringify({ status: response.status, payload }, null, 2)}\n`);
    return { target: name, targetId, ok: false, error: payload.detail ?? payload.error ?? `HTTP ${response.status}` };
  }
  await writeFile(join(bundleDir, "bundle.json"), `${JSON.stringify(payload, null, 2)}\n`);
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  return {
    target: name,
    targetId,
    ok: true,
    verdict: payload?.result?.status,
    interpreter: payload?.interpreter,
    generatedTest: payload?.generatedTest,
    artifacts,
    runUrl: payload?.runUrl,
  };
}

async function stopServers() {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    if (server.exitCode !== null || server.killed) return resolve();
    server.once("exit", resolve);
    server.kill("SIGTERM");
    // A stuck process must not leak into the next rehearsal iteration.
    setTimeout(() => {
      if (server.exitCode === null) server.kill("SIGKILL");
    }, 2_000).unref();
  })));
}

try {
  await mkdir(runDir, { recursive: true });
  startServer("dev:local", localPort);
  startServer("dev:legacy", olderPort);
  await Promise.all([waitFor(localUrl, "updated target"), waitFor(olderUrl, "older target")]);

  const local = await runProofPipeline("local", "local");
  const older = await runProofPipeline("older", "production");

  // The exported test must be the one the proof compiler generated from the
  // session, not the hand-written spec. Write it from the bundle response.
  const generatedTest = join(runDir, "local", "generated-test.spec.ts");
  if (local.ok && typeof local.generatedTest === "string") {
    await writeFile(generatedTest, local.generatedTest, "utf8");
  }

  const checks = {
    localPassed: local.ok && local.verdict === "passed",
    localHasVideo: local.ok && local.artifacts.some((a) => a.kind === "video"),
    olderFailed: older.ok && older.verdict === "failed",
    olderHasVideo: older.ok && older.artifacts.some((a) => a.kind === "video"),
    olderHasScreenshot: older.ok && older.artifacts.some((a) => a.kind === "screenshot"),
    interpreterIsDeterministic: local.ok && local.interpreter === "deterministic-fallback",
    generatedTestAvailable: await exists(generatedTest),
  };
  const passed = Object.values(checks).every(Boolean);
  const summary = {
    format: "proofmode-reliability-run/v1",
    id: runId,
    startedAt,
    local: { verdict: local.verdict, interpreter: local.interpreter, runUrl: local.runUrl, error: local.error },
    older: { verdict: older.verdict, interpreter: older.interpreter, runUrl: older.runUrl, error: older.error },
    checks,
    passed,
    exportedTest: checks.generatedTestAvailable ? relative(runDir, generatedTest) : undefined,
  };
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nProofMode reliability ${passed ? "PASSED" : "FAILED"}: ${relative(root, runDir)}`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error("ProofMode reliability failed:", error);
  process.exitCode = 1;
} finally {
  await stopServers();
}
