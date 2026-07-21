import { test } from "node:test";
import assert from "node:assert/strict";
import { riftNameFromHost, pickProxyPort, startProxy } from "../proxy.js";
import http from "node:http";

test("riftNameFromHost strips :port and .localhost", () => {
  assert.equal(riftNameFromHost("brave-otter.localhost:8080"), "brave-otter");
  assert.equal(riftNameFromHost("brave-otter.localhost"), "brave-otter");
  assert.equal(riftNameFromHost("quiet-falcon.localhost:8081"), "quiet-falcon");
});

test("riftNameFromHost returns null for non-localhost host", () => {
  assert.equal(riftNameFromHost("example.com"), null);
  assert.equal(riftNameFromHost("example.com:8080"), null);
});

test("riftNameFromHost handles bare host without port", () => {
  assert.equal(riftNameFromHost("swift-lynx.localhost"), "swift-lynx");
});

test("pickProxyPort returns 8080 when free (guarded)", async () => {
  // Probe 8080 ourselves first; if a parallel test or dev server holds it,
  // skip the assertion rather than fail spuriously.
  const net = await import("node:net");
  const free8080 = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(8080, () => srv.close(() => resolve(true)));
  });
  if (!free8080) return; // 8080 busy in this env; can't assert cleanly.
  const port = await pickProxyPort();
  assert.equal(port, 8080);
});

test("pickProxyPort skips an in-use port", async () => {
  // Block 8080 ourselves, then assert the picker moves to 8081 — unless a
  // parallel test already holds 8081, in which case skip.
  const net = await import("node:net");
  const free8081 = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(8081, () => srv.close(() => resolve(true)));
  });
  if (!free8081) return;

  const blocker = http.createServer((_req, res) => res.end());
  await new Promise<void>((r) => blocker.listen(8080, r));
  try {
    const port = await pickProxyPort();
    assert.equal(port, 8081);
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
  }
});

test("startProxy routes Host <name>.localhost to the rift's port", async () => {
  // upstream: a real server on 8701 that echoes "hello"
  const upstream = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("hello-from-upstream");
  });
  await new Promise<void>((r) => upstream.listen(8701, r));

  const ports = {
    rifts: { "brave-otter": { port: 8701, path: "/x/brave-otter" } },
    projects: {},
  };
  const proxy = await startProxy({ port: 8700, ports });
  try {
    // Use http.request (not fetch) so our custom Host header is honored.
    const { status, body } = await proxyFetch(8700, "brave-otter.localhost:8700", "/");
    assert.equal(status, 200);
    assert.equal(body, "hello-from-upstream");
  } finally {
    proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("startProxy returns 404 for unknown rift", async () => {
  const ports = { rifts: {}, projects: {} };
  const proxy = await startProxy({ port: 8702, ports });
  try {
    const { status, body } = await proxyFetch(8702, "no-such-rift.localhost:8702", "/");
    assert.equal(status, 404);
    assert.match(body, /no-such-rift/);
  } finally {
    proxy.close();
  }
});

/** Raw HTTP client that lets the caller set an arbitrary Host header. */
function proxyFetch(
  port: number,
  host: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
