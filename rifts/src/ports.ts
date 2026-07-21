import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import net from "node:net";
import process from "node:process";

export const PORT_RANGE_START = 8800;

export type PortMechanism = "env" | "flag" | "config" | "unknown";

export interface ProjectCache {
  portMechanism: PortMechanism;
  envVar: string | null;
  flagTemplate: string | null;
  confidence: number;
}

export interface RiftEntry {
  port: number;
  path: string;
}

export interface PortsFile {
  rifts: Record<string, RiftEntry>;
  projects: Record<string, ProjectCache>;
}

export const EMPTY_PORTS: PortsFile = { rifts: {}, projects: {} };

/** Path to the single data file: ~/.rifts/ports.json */
export function portsFilePath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".rifts", "ports.json");
}

/** Read ports.json; absence is treated as empty. */
export async function readPorts(): Promise<PortsFile> {
  const file = portsFilePath();
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return {
      rifts: parsed.rifts ?? {},
      projects: parsed.projects ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_PORTS };
    throw err;
  }
}

/** Atomic write: ports.json.tmp → rename over ports.json. */
export async function writePorts(data: PortsFile): Promise<void> {
  const file = portsFilePath();
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "ports.json.tmp");
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

/**
 * Probe whether a port is free by attempting to listen, then releasing.
 * Returns the first free port at or after `start`.
 */
export function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => tryPort(port + 1));
      srv.listen(port, () => {
        srv.close(() => resolve(port));
      });
    };
    tryPort(start);
    // Safety: avoid infinite loop in pathological cases.
    setTimeout(
      () => reject(new Error(`no free port found starting at ${start}`)),
      10_000,
    ).unref();
  });
}

/**
 * Assign the next free port for a new rift. Considers BOTH ports already
 * recorded in `ports.json` (so two `rifts create` calls with no servers
 * running don't collide) AND ports currently bound on the host (so a running
 * dev server isn't clobbered). Returns the first port >= `start` that is
 * neither recorded nor bound.
 */
export async function assignNextPort(
  ports: PortsFile,
  start: number = PORT_RANGE_START,
): Promise<number> {
  const assigned = new Set(Object.values(ports.rifts).map((r) => r.port));
  const probe = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => resolve(probe(port + 1)));
      srv.listen(port, () => srv.close(() => resolve(port)));
    });

  const tryPort = async (port: number): Promise<number> => {
    if (assigned.has(port)) return tryPort(port + 1);
    // Probe binds briefly to confirm nothing's listening either.
    const bound = await probe(port);
    // probe may have skipped past a bound port; re-check the assigned set
    // and the returned port in lockstep.
    if (assigned.has(bound)) return tryPort(bound + 1);
    return bound;
  };
  return tryPort(start);
}

/**
 * Resolve the current rift by walking from cwd upward looking for a `.rift`
 * marker file. Returns null if no ancestor (including cwd) is a rift.
 */
export function resolveCurrentRift(
  startDir: string = process.cwd(),
): { name: string; path: string } | null {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const marker = join(dir, ".rift");
    // Synchronous existence check is fine here; this runs once per invocation.
    if (existsSync(marker)) {
      return { name: basename(dir), path: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached root
    dir = parent;
  }
}
