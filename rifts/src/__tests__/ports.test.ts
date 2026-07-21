import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  portsFilePath,
  readPorts,
  writePorts,
  findFreePort,
  resolveCurrentRift,
  type PortsFile,
} from "../ports.js";

let tmpRoot: string;
let savedHome: string | undefined;

async function withTmpHome<T>(fn: () => Promise<T>): Promise<T> {
  tmpRoot = await mkdtemp(join(tmpdir(), "rifts-test-"));
  savedHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  try {
    return await fn();
  } finally {
    process.env.HOME = savedHome;
  }
}

test("portsFilePath uses ~/.rifts/ports.json", () => {
  process.env.HOME = "/tmp/fake-home";
  assert.equal(portsFilePath(), "/tmp/fake-home/.rifts/ports.json");
});

test("readPorts treats missing file as empty", async () => {
  await withTmpHome(async () => {
    const ports = await readPorts();
    assert.deepEqual(ports, { rifts: {}, projects: {} });
  });
});

test("writePorts then readPorts round-trips rifts + projects", async () => {
  await withTmpHome(async () => {
    const data: PortsFile = {
      rifts: {
        "brave-otter": { port: 8801, path: "/x/brave-otter" },
        "quiet-falcon": { port: 8802, path: "/x/quiet-falcon" },
      },
      projects: {
        "my-app@0.1.0": {
          portMechanism: "flag",
          envVar: null,
          flagTemplate: "--port {port}",
          confidence: 0.9,
        },
      },
    };
    await writePorts(data);
    const read = await readPorts();
    assert.deepEqual(read, data);
  });
});

test("writePorts is atomic (no .tmp left behind)", async () => {
  await withTmpHome(async () => {
    await writePorts({ rifts: {}, projects: {} });
    const dir = join(tmpRoot, ".rifts");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    assert.deepEqual(files, ["ports.json"]);
  });
});

test("findFreePort returns the start port when it is free", async () => {
  // Use a high, concurrency-safe start so parallel test files don't collide.
  const start = await import("node:net").then((net) => {
    const srv = net.createServer();
    return new Promise<number>((resolve) => {
      srv.unref();
      srv.listen(0, () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
  });
  const port = await findFreePort(start);
  assert.equal(port, start);
});

test("findFreePort skips an in-use port", async () => {
  const http = await import("node:http");
  const blocker = http.createServer((_req, res) => res.end());
  // Bind to an ephemeral port so we don't collide with parallel test files.
  const blockedPort: number = await new Promise((resolve) => {
    blocker.listen(0, () => {
      resolve((blocker.address() as { port: number }).port);
    });
  });
  try {
    const port = await findFreePort(blockedPort);
    assert.equal(port, blockedPort + 1);
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
  }
});

test("resolveCurrentRift finds the .rift marker in cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "rift-walk-"));
  const nested = join(root, "src", "components");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, ".rift"), "marker-id");
  const cwd = process.cwd();
  process.chdir(nested);
  try {
    const result = resolveCurrentRift();
    assert.ok(result, "expected to resolve a rift");
    // realpath() resolves macOS /var → /private/var symlink mismatch between
    // mkdtemp's returned path and process.cwd().
    const { realpath } = await import("node:fs/promises");
    assert.equal(await realpath(result!.path), await realpath(root));
    assert.equal(result!.name, (await realpath(root)).split("/").pop());
  } finally {
    process.chdir(cwd);
  }
});

test("resolveCurrentRift returns null when not inside a rift", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-rift-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const result = resolveCurrentRift();
    // A fresh tmp dir has no .rift marker in itself or (in a clean env) its
    // ancestors. We assert null; if the host env happens to have a .rift
    // higher up this is a false positive worth noticing.
    assert.equal(result, null);
  } finally {
    process.chdir(cwd);
  }
});
