// Self-contained E2E smoke test for the rifts CLI. Each step uses its own
// isolated HOME so there's no cross-step port reuse or state leakage.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const RDIR = "/Users/ashishhuddar/Documents/build-week/rifts";
const fail = (msg) => { console.error("SMOKE FAIL:", msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Step 2: create assigns a port ≥ 8800 and records it ----
{
  const home = await mkdtemp(join(tmpdir(), "rifts-s2-"));
  const src = await mkdtemp(join(tmpdir(), "rifts-s2-src-"));
  const env = { ...process.env, HOME: home };
  delete env.OPENAI_API_KEY;
  spawnSync("rift", ["init"], { cwd: src, encoding: "utf8", env });
  const r = spawnSync("node", [`${RDIR}/dist/cli.js`, "create", "--name", "s2"], {
    cwd: src, encoding: "utf8", env,
  });
  if (r.status !== 0) fail(`create exited ${r.status}: ${r.stderr}`);
  const line = r.stdout.trim().split("\n").pop();
  const m = line.match(/(.+?) → port (\d+)/);
  if (!m) fail(`unexpected create output: ${line}`);
  const port = Number(m[2]);
  if (port < 8800) fail(`port ${port} < 8800`);
  const { readFileSync } = await import("node:fs");
  const ports = JSON.parse(readFileSync(join(home, ".rifts", "ports.json"), "utf8"));
  if (!ports.rifts["s2"] || ports.rifts["s2"].port !== port) fail("ports.json missing/wrong rift entry");
  console.log(`STEP2 create -> ${line}  (ports.json OK)`);
  await rm(home, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
}

// ---- Step 3+4: run injects PORT; list shows the rift ----
{
  const home = await mkdtemp(join(tmpdir(), "rifts-s34-"));
  const src = await mkdtemp(join(tmpdir(), "rifts-s34-src-"));
  const env = { ...process.env, HOME: home };
  delete env.OPENAI_API_KEY;
  spawnSync("rift", ["init"], { cwd: src, encoding: "utf8", env });
  const created = spawnSync("node", [`${RDIR}/dist/cli.js`, "create", "--name", "s34"], {
    cwd: src, encoding: "utf8", env,
  });
  const line = created.stdout.trim().split("\n").pop();
  const ws = line.split(" ")[0];
  const port = Number(line.match(/port (\d+)/)[1]);

  const child = spawn("node", [`${RDIR}/dist/cli.js`, "run", "node", "-e",
    `require("http").createServer((q,s)=>s.end("ok-step3")).listen(process.env.PORT)`],
    { cwd: ws, stdio: "ignore", env });
  await sleep(1200);
  const probe = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => null);
  // kill the whole process group (rifts run + its node child)
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  if (probe !== "ok-step3") fail(`STEP3 upstream on :${port} responded '${probe}'`);
  console.log(`STEP3 run -> :${port} responded '${probe}'`);

  const listed = spawnSync("node", [`${RDIR}/dist/cli.js`, "list"], { cwd: ws, encoding: "utf8", env });
  if (!listed.stdout.includes("s34") || !listed.stdout.includes(String(port))) {
    fail(`STEP4 list missing rift/port: ${listed.stdout}`);
  }
  console.log(`STEP4 list -> OK`);
  await rm(home, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
}

// ---- Step 5: proxy routes Host <name>.localhost → rift port ----
{
  const home = await mkdtemp(join(tmpdir(), "rifts-s5-"));
  const env = { ...process.env, HOME: home };
  delete env.OPENAI_API_KEY;
  // Stand up a real upstream on a fixed free port and record it as a rift.
  const upstream = http.createServer((_q, s) => s.end("ok-via-proxy"));
  await new Promise((r) => upstream.listen(0, r));
  const upPort = upstream.address().port;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".rifts"), { recursive: true });
  writeFileSync(join(home, ".rifts", "ports.json"), JSON.stringify({
    rifts: { "s5": { port: upPort, path: "/tmp/s5" } }, projects: {},
  }));

  const proxy = spawn("node", [`${RDIR}/dist/cli.js`, "proxy"], { stdio: "ignore", env });
  await sleep(1200);
  const proxied = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 8080, path: "/", headers: { Host: "s5.localhost:8080" } });
    req.on("response", (res) => { let b=""; res.on("data",c=>b+=c); res.on("end",()=>resolve({status:res.statusCode,body:b})); });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
  proxy.kill("SIGKILL");
  upstream.close();
  if (proxied.status !== 200 || proxied.body !== "ok-via-proxy") {
    fail(`STEP5 proxy status=${proxied.status} body='${proxied.body}'`);
  }
  console.log(`STEP5 proxy -> '${proxied.body}'`);
  await rm(home, { recursive: true, force: true });
}

// ---- Step 7: no-key path → help works, no crash ----
{
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const r = spawnSync("node", [`${RDIR}/dist/cli.js`, "help"], { encoding: "utf8", env });
  if (r.status !== 0 || !r.stdout.includes("rifts")) fail("STEP7 help broken");
  console.log(`STEP7 no-key/help -> OK`);
}

console.log("ALL SMOKE STEPS PASSED");
