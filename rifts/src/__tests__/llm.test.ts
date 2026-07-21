import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IGNORES_PORT_PACKAGES,
  projectIgnoresPort,
  projectSignature,
  parseLlmResponse,
  renderPortMechanism,
  type PortMechanismResult,
} from "../llm.js";

test("IGNORES_PORT_PACKAGES includes vite and @docusaurus/core", () => {
  assert.ok(IGNORES_PORT_PACKAGES.includes("vite"));
  assert.ok(IGNORES_PORT_PACKAGES.includes("@docusaurus/core"));
});

test("projectIgnoresPort: true when vite in devDependencies", () => {
  const pkg = {
    name: "app",
    version: "1.0.0",
    devDependencies: { vite: "^5.0.0" },
  };
  assert.equal(projectIgnoresPort(pkg), true);
});

test("projectIgnoresPort: false for plain express app", () => {
  const pkg = {
    name: "app",
    version: "1.0.0",
    dependencies: { express: "^4.0.0" },
  };
  assert.equal(projectIgnoresPort(pkg), false);
});

test("projectIgnoresPort: true when vite in dependencies (not just devDeps)", () => {
  const pkg = {
    name: "app",
    version: "1.0.0",
    dependencies: { vite: "^5.0.0" },
  };
  assert.equal(projectIgnoresPort(pkg), true);
});

test("projectSignature: name@version", () => {
  assert.equal(
    projectSignature({ name: "my-app", version: "0.1.0" }),
    "my-app@0.1.0",
  );
});

test("projectSignature: null when name or version missing", () => {
  assert.equal(projectSignature({ name: "x" }), null);
  assert.equal(projectSignature({ version: "1.0.0" }), null);
  assert.equal(projectSignature({}), null);
});

test("parseLlmResponse: flag mechanism", () => {
  const raw = JSON.stringify({
    portMechanism: "flag",
    flagTemplate: "--port {port}",
    envVar: null,
    confidence: 0.9,
  });
  const result = parseLlmResponse(raw);
  assert.equal(result.portMechanism, "flag");
  assert.equal(result.flagTemplate, "--port {port}");
  assert.equal(result.confidence, 0.9);
});

test("parseLlmResponse: env mechanism", () => {
  const raw = JSON.stringify({
    portMechanism: "env",
    envVar: "PORT",
    flagTemplate: null,
    confidence: 0.8,
  });
  const result = parseLlmResponse(raw);
  assert.equal(result.portMechanism, "env");
  assert.equal(result.envVar, "PORT");
});

test("parseLlmResponse: unknown mechanism falls back safely", () => {
  const raw = JSON.stringify({
    portMechanism: "unknown",
    envVar: null,
    flagTemplate: null,
    confidence: 0.2,
  });
  const result = parseLlmResponse(raw);
  assert.equal(result.portMechanism, "unknown");
});

test("parseLlmResponse: malformed JSON → unknown", () => {
  const result = parseLlmResponse("not json at all");
  assert.equal(result.portMechanism, "unknown");
  assert.equal(result.confidence, 0);
});

test("parseLlmResponse: missing mechanism field → unknown", () => {
  const result = parseLlmResponse(JSON.stringify({ confidence: 0.5 }));
  assert.equal(result.portMechanism, "unknown");
});

test("renderPortMechanism: flag renders port into template", () => {
  const result: PortMechanismResult = {
    portMechanism: "flag",
    flagTemplate: "--port {port}",
    envVar: null,
    confidence: 0.9,
  };
  assert.deepEqual(renderPortMechanism(result, 8801), {
    env: {},
    args: ["--port", "8801"],
  });
});

test("renderPortMechanism: env sets the named var", () => {
  const result: PortMechanismResult = {
    portMechanism: "env",
    envVar: "PORT",
    flagTemplate: null,
    confidence: 0.8,
  };
  assert.deepEqual(renderPortMechanism(result, 8801), {
    env: { PORT: "8801" },
    args: [],
  });
});

test("renderPortMechanism: unknown produces no injection (caller falls back to PORT)", () => {
  const result: PortMechanismResult = {
    portMechanism: "unknown",
    envVar: null,
    flagTemplate: null,
    confidence: 0.1,
  };
  assert.deepEqual(renderPortMechanism(result, 8801), { env: {}, args: [] });
});
