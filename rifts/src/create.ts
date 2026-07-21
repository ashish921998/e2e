import { spawn } from "node:child_process";
import { basename } from "node:path";
import process from "node:process";
import {
  readPorts,
  writePorts,
  assignNextPort,
  PORT_RANGE_START,
  type PortsFile,
} from "./ports.js";

export interface CreateOptions {
  /** Args forwarded verbatim to `rift create`. */
  riftArgs: string[];
  /** Override for tests / programmatic use. */
  riftBin?: string;
  /** Start of the port range (default 8800). */
  portStart?: number;
}

export interface CreateResult {
  path: string;
  name: string;
  port: number;
}

/**
 * Run `rift create <args...>`, parse the new workspace path from the last line
 * of stdout, assign the next free port, and record it in ports.json.
 */
export async function riftsCreate(opts: CreateOptions): Promise<CreateResult> {
  const riftBin = opts.riftBin ?? "rift";
  const { stdout, stderr, code } = await runRiftCreate(riftBin, opts.riftArgs);

  if (code !== 0) {
    // Surface rift's stderr verbatim, do not touch ports.json.
    if (stderr) process.stderr.write(stderr);
    process.exit(code ?? 1);
  }

  // The workspace path is the last non-empty line of stdout.
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const workspacePath = lines[lines.length - 1];
  if (!workspacePath) {
    process.stderr.write(
      "rifts: could not parse workspace path from `rift create` stdout\n",
    );
    process.exit(1);
  }

  const name = basename(workspacePath);
  const ports = await readPorts();
  if (ports.rifts[name]) {
    // Already tracked — keep its existing port (idempotent re-create).
    return { path: workspacePath, name, port: ports.rifts[name].port };
  }

  const port = await assignNextPort(ports, opts.portStart ?? PORT_RANGE_START);
  const next: PortsFile = {
    ...ports,
    rifts: { ...ports.rifts, [name]: { port, path: workspacePath } },
  };
  await writePorts(next);

  return { path: workspacePath, name, port };
}

/** Spawn `rift create` and capture stdout/stderr/exit code. */
function runRiftCreate(
  riftBin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(riftBin, ["create", ...args], {
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
