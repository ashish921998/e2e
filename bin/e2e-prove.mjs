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
import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "e2e-prove.ts");
const localTsx = join(here, "..", "node_modules", ".bin", "tsx");

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const tsx = isExecutable(localTsx) ? localTsx : "tsx";
const argv = process.argv.slice(2);

// spawn (async) + a watchdog so we can detect a stall and retry. spawnSync
// can't be killed cleanly mid-stall under some stdio setups.
async function runWithWatchdog(bin, attempt) {
  return new Promise((resolve) => {
    const child = spawn(bin, [entry, ...argv], { stdio: "inherit" });
    // tsx cold-start should be well under 20s; if it hasn't exited by then,
    // treat it as stalled, kill, and let the caller retry.
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ stalled: true, code: null });
    }, attempt === 1 ? 45_000 : 60_000);
    child.on("error", () => {
      clearTimeout(watchdog);
      resolve({ stalled: false, code: 127 });
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve({ stalled: false, code: code ?? 1 });
    });
  });
}

async function main() {
  let result = await runWithWatchdog(tsx, 1);
  if (result.stalled && tsx !== "tsx") {
    // Retry once with the PATH-resolved tsx name.
    result = await runWithWatchdog("tsx", 2);
  }
  if (result.stalled) {
    process.stderr.write(
      "tsx stalled while loading the CLI. Re-run; if it persists, run `node_modules/.bin/tsx bin/e2e-prove.ts` directly.\n",
    );
    process.exit(124);
  }
  if (result.code === 127) {
    process.stderr.write(
      "tsx was not found. Install it (`npm i -D tsx`) or run with `node --import tsx/esm bin/e2e-prove.ts`.\n",
    );
  }
  process.exit(result.code ?? 1);
}

main();
