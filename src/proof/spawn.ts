/**
 * One spawn→promise helper for the whole engine. Runs a child process, buffers
 * stdout/stderr, and resolves (never rejects) with the exit code — a missing
 * binary (ENOENT 'error' event) surfaces as exit 1 so callers branch on the
 * code rather than a try/catch. Replaces the near-identical copies that had
 * accreted in execute.ts and video.ts.
 */
import { spawn } from "node:child_process";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function spawnCollect(
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // Decode as UTF-8 so a multi-byte char split across two chunks is not
    // corrupted (Node's StringDecoder keeps state across chunks; raw
    // Buffer→string coercion per chunk does not).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
