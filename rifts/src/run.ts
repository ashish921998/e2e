import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  readPorts,
  writePorts,
  assignNextPort,
  resolveCurrentRift,
  PORT_RANGE_START,
  type PortsFile,
} from "./ports.js";
import {
  projectIgnoresPort,
  projectSignature,
  detectPortMechanism,
  renderPortMechanism,
  getCachedProject,
  setCachedProject,
  type PackageJsonLike,
  type PortMechanismResult,
} from "./llm.js";

export interface RunOptions {
  /** Command tokens to exec, e.g. ["npm", "run", "dev"]. */
  command: string[];
  /** CWD override (defaults to process.cwd()). */
  cwd?: string;
  /** Programmatic override of the GPT-5.6 caller (for tests). */
  detect?: (
    pkg: PackageJsonLike,
    command: string,
  ) => Promise<PortMechanismResult>;
}

/**
 * Resolve the current rift, look up (or auto-assign) its port, then exec the
 * command with port injection applied. Two tiers:
 *   1. Fast path: set PORT=<n> for any project not known to ignore it.
 *   2. LLM path: for projects known to ignore PORT (or with a cached flag/config
 *      result), apply the resolved mechanism instead.
 */
export async function riftsRun(opts: RunOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const rift = resolveCurrentRift(cwd);
  if (!rift) {
    process.stderr.write(
      "rifts: not inside a rift workspace; run `rifts create` first\n",
    );
    return 1;
  }

  const ports = await readPorts();
  let port: number;
  let entry = ports.rifts[rift.name];
  if (entry) {
    port = entry.port;
  } else {
    // Auto-assign on the fly (handles manual `rift create` usage).
    port = await assignNextPort(ports, PORT_RANGE_START);
    const next: PortsFile = {
      ...ports,
      rifts: { ...ports.rifts, [rift.name]: { port, path: rift.path } },
    };
    await writePorts(next);
    entry = { port, path: rift.path };
  }

  // Load the project's package.json from the rift workspace (best effort).
  const pkg = await loadPackageJson(rift.path);

  // Decide mechanism: cache → known-ignores → PORT fast path → LLM.
  const injection = await resolveInjection(ports, pkg, opts.command.join(" "), port, opts);

  // Always set PORT in the env too — it's harmless and covers servers that
  // read it even when a flag also applies.
  const env = { ...process.env, PORT: String(port), ...injection.env };
  const args = [...opts.command.slice(1), ...injection.args];
  const cmd = opts.command[0];

  const child = spawn(cmd, args, { stdio: "inherit", env, cwd: rift.path, shell: false });
  const code: number = await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`rifts: failed to spawn ${cmd}: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (c) => resolve(c ?? 0));
  });
  return code;
}

interface Injection {
  env: Record<string, string>;
  args: string[];
}

async function resolveInjection(
  ports: PortsFile,
  pkg: PackageJsonLike | null,
  command: string,
  port: number,
  opts: RunOptions,
): Promise<Injection> {
  // No package.json → no signature, no cache, no LLM. PORT fast path only.
  if (!pkg) {
    process.stderr.write(
      "rifts: project signature unavailable (no package.json), using PORT fallback\n",
    );
    return { env: {}, args: [] };
  }

  const signature = projectSignature(pkg);
  // Without a signature we can't cache; stay on the fast path.
  if (!signature) {
    process.stderr.write(
      "rifts: project signature unavailable, using PORT fallback\n",
    );
    return { env: {}, args: [] };
  }

  // 1. Cache hit.
  const cached = getCachedProject(ports, signature);
  if (cached) {
    if (cached.portMechanism === "unknown") {
      return { env: {}, args: [] }; // caller sets PORT (fast path) already
    }
    // env / flag / config: render the cached mechanism. For an env mechanism
    // whose var is PORT this is a no-op (caller already sets PORT); for a
    // different var, render sets it here.
    return renderPortMechanism(cached as PortMechanismResult, port);
  }

  // 2. Fast path: project not known to ignore PORT.
  if (!projectIgnoresPort(pkg)) {
    return { env: {}, args: [] }; // PORT env (set by caller) is enough.
  }

  // 3. LLM path: project is known to ignore PORT. Resolve + cache.
  const detect = opts.detect ?? ((p, c) => detectPortMechanism(p, c));
  const result = await detect(pkg, command);
  // Persist the result (one-time cost per project).
  const updated = setCachedProject(ports, signature, result);
  await writePorts(updated);

  if (result.portMechanism === "unknown") {
    process.stderr.write(
      "rifts: GPT-5.6 uncertain; falling back to PORT env\n",
    );
    return { env: {}, args: [] };
  }
  return renderPortMechanism(result, port);
}

async function loadPackageJson(riftPath: string): Promise<PackageJsonLike | null> {
  try {
    const raw = await readFile(join(riftPath, "package.json"), "utf8");
    return JSON.parse(raw) as PackageJsonLike;
  } catch {
    return null;
  }
}
