import { spawn } from "node:child_process";
import process from "node:process";
import { readPorts } from "./ports.js";

export interface ListOptions {
  riftBin?: string;
  proxyPort?: number;
}

interface RiftRow {
  name: string;
  path: string;
  port: number | undefined;
  url: string;
}

/**
 * Run `rift list`, join with ports.json, and print a table:
 *   NAME  PORT  PATH  URL
 * where URL = http://<name>.localhost:<proxyPort>.
 */
export async function riftsList(opts: ListOptions = {}): Promise<number> {
  const riftBin = opts.riftBin ?? "rift";
  const proxyPort = opts.proxyPort ?? 8080;
  const ports = await readPorts();
  // If `rift list` fails (e.g. rift not installed), warn but still show the
  // rifts we have recorded in ports.json rather than hiding them.
  let riftWorkspaces: string[] = [];
  try {
    riftWorkspaces = await runRiftList(riftBin);
  } catch (err) {
    process.stderr.write(`rifts: ${(err as Error).message}\n`);
  }

  const rows: RiftRow[] = riftWorkspaces.map((path) => {
    const name = path.split("/").pop() ?? path;
    const entry = ports.rifts[name];
    return {
      name,
      path,
      port: entry?.port,
      url: entry
        ? `http://${name}.localhost:${proxyPort}`
        : "(no port — run inside this rift)",
    };
  });

  // Also include rifts that rift list didn't return but we have recorded.
  for (const [name, entry] of Object.entries(ports.rifts)) {
    if (rows.some((r) => r.name === name)) continue;
    rows.push({
      name,
      path: entry.path,
      port: entry.port,
      url: `http://${name}.localhost:${proxyPort}`,
    });
  }

  if (rows.length === 0) {
    console.log("No rifts found. Create one with: rifts create");
    return 0;
  }

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const portW = 4;
  const pathW = 4;
  console.log(
    `${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  ${"PATH".padEnd(pathW)}  URL`,
  );
  for (const r of rows) {
    const portStr = r.port === undefined ? "-" : String(r.port);
    console.log(
      `${r.name.padEnd(nameW)}  ${portStr.padEnd(portW)}  ${r.path}  ${r.url}`,
    );
  }
  return 0;
}

function runRiftList(riftBin: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(riftBin, ["list"], { stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`\`rift list\` exited ${code}${err ? ": " + err.trim() : ""}`));
        return;
      }
      const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(lines);
    });
  });
}
