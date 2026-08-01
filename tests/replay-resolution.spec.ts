import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The consumer-repo replay resolves @playwright/test from a generated config +
// spec that live in a tool-owned run dir with no node_modules. Those files
// import it as ESM, and Node ignores NODE_PATH for ESM `import`, so a
// node_modules symlink in the run dir is the mechanism that actually works.
// This asserts the symlink resolves AND (negative control) that NODE_PATH alone
// does not — the exact path CI's live proof job never exercises because its
// run dir sits below the repo's own node_modules.

function packageNodeModules(): string {
  // .../node_modules/@playwright/test/cli.js → .../node_modules
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  return dirname(dirname(dirname(cli)));
}

// Exit code of an ESM `import("@playwright/test")` run with cwd = runDir.
function esmImportExitCode(runDir: string, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("@playwright/test")'], {
    cwd: runDir,
    env,
  });
  return result.status ?? 1;
}

test("a node_modules symlink lets the run dir resolve @playwright/test as ESM", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "proof-run-"));
  try {
    const nodeModules = packageNodeModules();

    // Baseline: NODE_PATH only, no symlink — ESM import must FAIL, proving the
    // finding (NODE_PATH is a no-op for ESM).
    const withoutSymlink = esmImportExitCode(runDir, { ...process.env, NODE_PATH: nodeModules });
    expect(withoutSymlink).not.toBe(0);

    // With the symlink the same ESM import resolves.
    await symlink(nodeModules, join(runDir, "node_modules"), "junction");
    const withSymlink = esmImportExitCode(runDir, { ...process.env, NODE_PATH: "" });
    expect(withSymlink).toBe(0);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
