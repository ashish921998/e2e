import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPackageModulesLink, linkPackageModules, packageNodeModules } from "../src/proof/execute";

// The consumer-repo replay resolves @playwright/test from a generated config +
// spec that live in a tool-owned run dir with no node_modules. Those files
// import it as ESM, and Node ignores NODE_PATH for ESM `import`, so the
// node_modules symlink that linkPackageModules() creates is the mechanism that
// actually works. This drives the REAL production helpers (not a parallel
// re-implementation) and asserts the symlink resolves AND — as a negative
// control — that NODE_PATH alone does not, the exact path CI's live proof job
// never exercises because its run dir sits below the repo's own node_modules.

// Exit code of an ESM `import("@playwright/test")` run with cwd = runDir.
// A spawn that never ran (result.error) throws, so the negative control below
// can't be satisfied by a broken spawn instead of actual non-resolution.
function esmImportExitCode(runDir: string, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("@playwright/test")'], {
    cwd: runDir,
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

test("linkPackageModules lets the run dir resolve @playwright/test as ESM", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "proof-run-"));
  try {
    const nodeModules = packageNodeModules();
    expect(nodeModules).toBeTruthy();

    // Negative control: NODE_PATH only, no symlink — ESM import must FAIL,
    // proving NODE_PATH is a no-op for ESM (the finding this fix addresses).
    const withoutSymlink = esmImportExitCode(runDir, { ...process.env, NODE_PATH: nodeModules! });
    expect(withoutSymlink).not.toBe(0);

    // Production logic: link the package modules into the run dir, then the
    // same ESM import resolves. linkPackageModules is the real code executePlaywright runs.
    const linked = await linkPackageModules(runDir);
    expect(linked.nodeModules).toBe(nodeModules);
    expect(linked.createdLinkPath).toBe(join(runDir, "node_modules"));
    const withSymlink = esmImportExitCode(runDir, { ...process.env, NODE_PATH: "" });
    expect(withSymlink).toBe(0);

    await cleanupPackageModulesLink(linked);
    await expect(lstat(join(runDir, "node_modules"))).rejects.toThrow();
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup preserves a node_modules symlink owned by the caller", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "proof-run-existing-"));
  try {
    const nodeModules = packageNodeModules();
    expect(nodeModules).toBeTruthy();
    const existingLink = join(runDir, "node_modules");
    await symlink(nodeModules!, existingLink, "junction");

    const linked = await linkPackageModules(runDir);
    expect(linked.createdLinkPath).toBeUndefined();
    await cleanupPackageModulesLink(linked);

    expect((await lstat(existingLink)).isSymbolicLink()).toBe(true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
