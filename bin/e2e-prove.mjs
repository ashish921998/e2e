#!/usr/bin/env node
/**
 * Thin launcher: the npm bin is .mjs (npm convention), but the real CLI is
 * TypeScript (bin/e2e-prove.ts) run through tsx so there is no build step. We
 * resolve the repo-local tsx first so `npx` from the published Action / npm
 * ref works without a global tsx.
 *
 * tsx's esbuild loader occasionally stalls on a cold start (a known
 * intermittent issue). We run the child with a watchdog and retry once on a
 * stall so the CLI is reliable in CI.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "e2e-prove.ts");
// Resolve the dependency as a module rather than assuming npm created a
// package-local .bin directory. npm commonly hoists tsx in consumer projects.
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const argv = process.argv.slice(2);

// spawn (async) + a watchdog so we can detect a stall and retry. spawnSync
// can't be killed cleanly mid-stall under some stdio setups.
//
// The watchdog guards ONLY the loader cold start, never the run itself: the
// CLI prints the exact marker "[e2e-prove] cli loaded\n" to stderr the moment
// it loads, and only that marker disarms the timer (not the first byte, which
// could be an early diagnostic). A legitimate run can then take as long as
// the agent needs.
async function runWithWatchdog(attempt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, entry, ...argv], {
      stdio: ["inherit", "inherit", "pipe"],
    });
    let watchdog = setTimeout(() => {
      watchdog = undefined;
      child.kill("SIGKILL");
      resolve({ stalled: true, code: null });
    }, attempt === 1 ? 45_000 : 60_000);
    const disarm = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    // Disarm only on the exact readiness marker, not the first stderr byte:
    // early diagnostics or tsx module output would otherwise false-disarm and
    // leave a real cold-start stall undetected. Chunks are forwarded
    // immediately and buffered across boundaries until the marker appears.
    const MARKER = "[e2e-prove] cli loaded\n";
    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (watchdog) {
        stderrBuf += chunk.toString();
        if (stderrBuf.includes(MARKER)) disarm();
        // Bound the buffer so a pathological producer can't grow it forever.
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
      }
    });
    child.on("error", () => {
      disarm();
      resolve({ stalled: false, code: 127 });
    });
    child.on("exit", (code) => {
      disarm();
      resolve({ stalled: false, code: code ?? 1 });
    });
  });
}

async function main() {
  let result = await runWithWatchdog(1);
  if (result.stalled) result = await runWithWatchdog(2);
  if (result.stalled) {
    process.stderr.write(
      "tsx stalled while loading the CLI. Re-run; if it persists, run `node_modules/.bin/tsx bin/e2e-prove.ts` directly.\n",
    );
    process.exit(124);
  }
  process.exit(result.code ?? 1);
}

main();
