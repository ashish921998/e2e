# rifts — deterministic per-rift port assignment

**Status:** Draft
**Date:** 2026-07-21
**Target:** Build-week V1

## Project setup

- **Location:** `rifts/` subdirectory at the root of this repo (`build-week`). It is a standalone Node project with its own `package.json`, not merged into the existing `e2e` Vite app. The `e2e` app remains untouched.
- **Package name:** `rifts` (npm bin entry: `"rifts": "./dist/cli.js"`).
- **Node version:** ≥ 20 (uses built-in `fetch`, `node:fs/promises`, `node:http`).
- **Language:** TypeScript, compiled with `tsc` to `dist/`. No bundler. `tsconfig.json` targets ES2022 / NodeNext module resolution.
- **Dependencies:** zero runtime deps for V1. The proxy uses `node:http`; the CLI uses Node's built-in `util.parseArgs` (no Commander/yargs). Dev dep: `typescript`, `@types/node`.
- **bin entry:** `src/cli.ts` has a `#!/usr/bin/env node` shebang, compiled to `dist/cli.js`, linked as the `rifts` bin.
- **`OPENAI_API_KEY`:** read from the environment. If unset, `rifts run` skips the LLM path entirely, uses only the `PORT` fast path, and prints a one-line warning the first time it would have called GPT-5.6. The tool stays fully functional for `PORT`-reading servers without a key.
- **GPT-5.6 model id:** use `"gpt-5.6"` as the model string in API requests, via the OpenAI Node SDK (`openai`) as a dev dependency. Call `openai.chat.completions.create({ model: "gpt-5.6", ... })` with `response_format: { type: "json_object" }` and parse the JSON response. If the API returns an error or the model id is unavailable, treat it identically to `portMechanism: "unknown"` — fall back to the `PORT` fast path and warn.

## Problem

[Rift](https://github.com/anomalyco/rift) creates isolated copy-on-write workspaces in <0.1s with near-zero extra disk. But every dev server inside a rift still wants the same hardcoded port — 3000 (Next), 5173 (Vite), 8080 (Express) — so the second rift's `npm run dev` crashes with `EADDRINUSE`. Rift does filesystem isolation and nothing else. In practice you can preview one rift at a time, which defeats the entire payoff of running parallel rifts (parallel agents, parallel experiments, parallel branches).

## Idea

Port assignment is a **property of the rift workspace**, decided at creation time and bound for the workspace's lifetime.

- `rifts create` wraps `rift create`, then assigns the next free port and records it.
- `rifts run <cmd>` runs a command from inside a rift, automatically injecting that rift's assigned port. It first tries the `PORT` env var (fast path, no LLM); if that framework ignores `PORT`, GPT-5.6 determines the correct port mechanism (e.g. Vite needs `--port`, some servers read a config key) and the result is cached per project.
- `rifts list` shows each rift, its port, and its preview URL.
- `rifts proxy` runs a local reverse proxy so `<rift-name>.localhost` routes to that rift's port.

The port is deterministic (same rift → same port across restarts), decoupled from launch (no separate "up" step), and has no race window (assigned at create, not lazily).

## GPT-5.6 usage (hackathon requirement)

GPT-5.6 is a hard judging criterion. The honest place it earns its keep is the one problem in this domain that's genuinely fuzzy: **how does *this* dev server accept a port?** There is no universal convention. Express reads `PORT`, Vite ignores it and needs `--port`, Django reads `--bind`, some read a `.env` key, some a config file. A rules table can't keep up; an LLM reading the project is the right tool.

`rifts run` applies port injection in two tiers:

1. **Fast path (default, no LLM).** Set `PORT=<n>` in the child env. Works for any server that reads `PORT` — Express, Next, Parcel, most Node servers. This is the common case and stays free/instant.
2. **LLM fallback (when `PORT` is known not to work).** Send `package.json` (name, scripts, dependencies, devDependencies) plus the exact dev command to GPT-5.6 and ask for the port mechanism. Structured response:

   ```json
   {
     "portMechanism": "flag",       // "env" | "flag" | "config" | "unknown"
     "envVar": null,                // name if mechanism is env
     "flagTemplate": "--port {port}", // template if mechanism is flag
     "confidence": 0.9
   }
   ```

   `rifts run` applies it: env → set the named var; flag → append the rendered template to the command; config → return "unsupported, set manually"; unknown → fall back to `PORT` and warn. **The result is cached in `ports.json` keyed by project signature** (`name@version` or a hash of `package.json`) so GPT-5.6 is called at most once per project, ever — not per run, not per rift.

Triggering the fallback: the fast path only fails visibly (a server that silently ignores `PORT` and grabs 5173 anyway is undetectable at run time), so we trigger the LLM when the project matches a known `ignoresPort` list rather than waiting for a collision. This keeps the LLM call predictable and keeps the common Express/Next case on the free fast path.

**Known `ignoresPort` list (V1):** a project is flagged as ignoring `PORT` if its `package.json` `devDependencies` contains `vite` (Vite uses `--port`, ignores `PORT`) or `@docusaurus/core` (same). This list is checked by exact dependency name. Projects not on this list use the `PORT` fast path. The list lives as a constant array in `src/llm.ts` and is the only place that needs editing to add more frameworks.

**Project signature (cache key):** `name@version` read from the project's `package.json` (e.g. `my-app@0.1.0`). If `package.json` is absent (non-JS project), do not use the LLM path in V1 — use the `PORT` fast path and warn "project signature unavailable, using PORT fallback". The cache is keyed by this signature under `ports.json` → `projects`, so all rifts of the same project share one GPT-5.6 call.

**GPT-5.6 prompt (exact):**

```
You determine how a dev server receives a port override. Respond as JSON only.

Project package.json:
{...truncated to name, scripts, dependencies, devDependencies...}

Dev command the user is about to run: <command>

Return JSON with exactly these fields:
{
  "portMechanism": "env" | "flag" | "config" | "unknown",
  "envVar": string | null,            // the env var name if mechanism is "env"
  "flagTemplate": string | null,      // e.g. "--port {port}" if mechanism is "flag"
  "confidence": number                // 0.0 to 1.0
}
```

The response is parsed with `JSON.parse`; any parse failure or schema mismatch is treated as `unknown` and we fall back to `PORT`.

## Architecture

Four pieces. No database, no config file for the user to author, no daemon, no plugin system.

```
rifts create ──wraps──> rift create ──> assign next free port ──> write ports.json

ports.json   { "<rift-name>": { "port": 8801, "path": "/abs/path" } }   ← entire data model

rifts run  ──reads──> ports.json, sets PORT, execs command
rifts list ──reads──> rift list + ports.json, prints table
rifts proxy──reads──> ports.json, routes Host header → port
```

### Data model

One JSON file at `~/.rifts/ports.json`. Created on first write; absence is treated as empty (`{ rifts: {}, projects: {} }`).

```json
{
  "rifts": {
    "brave-otter": {
      "port": 8801,
      "path": "/Users/x/.rifts/app/brave-otter"
    },
    "quiet-falcon": {
      "port": 8802,
      "path": "/Users/x/.rifts/app/quiet-falcon"
    }
  },
  "projects": {
    "my-app@0.1.0": {
      "portMechanism": "flag",
      "flagTemplate": "--port {port}",
      "confidence": 0.9
    }
  }
}
```

- `rifts` is keyed by rift name (derived from the last segment of the workspace path). Each value has `port` (number) and `path` (absolute workspace path).
- `projects` is keyed by `name@version` from the project's `package.json`. Each value is the cached GPT-5.6 port-mechanism result.
- The project cache makes the LLM a one-time cost per project, not per run — `rifts run` only calls GPT-5.6 the first time it sees a new project signature, and serves from cache on every subsequent run across all rifts of that project.

Writes are atomic: write to `ports.json.tmp` in the same dir, then `fs.rename` over `ports.json`. Single-user, single-process tool — no locking.

No sqlite. We don't need concurrent writes, transactions, or relational queries. One JSON file is readable, debuggable by hand, and ~10 lines of code.

### Port range

Start at **8800**, increment by 1 per new rift. Before assigning, probe the port with `net.createServer().listen()` — if it's in use, skip to the next. 8800+ avoids colliding with common dev defaults (3000/5173/8080), so there's never confusion about whether `:5173` is a rift or the user's normal server.

### rift integration

We **wrap** `rift create` as a subprocess — we do not fork rift. This keeps upstream swappable and respects rift's constraints:

- rift's `.rift.toml` config schema is `deny_unknown_fields` and only supports `[[hooks.postcreate]] run = "..."`. We cannot extend it, so port metadata lives in our own `ports.json`, never in rift's config.
- rift prints the new workspace path to stdout on `create`. `rifts create` parses that path from stdout to know which workspace was just created.
- rift resolves the current workspace by walking `cwd.ancestors()` and reading the `.rift` marker. `rifts run` does the same walk to resolve "which rift am I in" before looking up the port.

**Resolving the current rift (exact algorithm):** starting from `process.cwd()`, walk upward through each ancestor directory. For each, check whether a `.rift` marker file exists in that directory (rift creates this file in every workspace root). The first ancestor (including `cwd` itself) that contains a `.rift` marker is the current rift. Its directory path is the workspace path, and its last path segment is the rift name used as the `ports.json` key. If no ancestor has a `.rift` marker, error: "not inside a rift workspace". (We do not need to read the marker's contents in V1 — existence is enough to identify a rift.)

**Parsing rift create's stdout:** rift prints the created workspace path as the last line of stdout on success. `rifts create` captures rift's stdout, takes the last non-empty line, and treats it as the workspace path. If `rift create` exits non-zero, surface rift's stderr verbatim and exit with the same code — do not touch `ports.json`.

## CLI surface

| Command | What it does |
|---|---|
| `rifts create [args…]` | Runs `rift create` with the same args, parses the new workspace path from rift's stdout, derives the rift name from the last path segment (`<path>/<name>`), assigns the next free port (≥8800), writes `ports.json`, prints `<path> → port <n>`. **Argument pass-through rule:** `rifts create` accepts no flags of its own in V1; every arg after `create` is forwarded verbatim to `rift create`. |
| `rifts run <cmd> [args…]` | Resolves the current rift (walk ancestors for `.rift` marker). If the current dir is not inside a rift, error: "not inside a rift workspace; run `rifts create` first". If inside a rift but no port is assigned, auto-assign and record it (this case should not normally happen — `rifts create` assigns — but handles manual `rift create` usage). **Fast path:** if the project has no cached mechanism or cached `env`/`PORT`, set `PORT=<n>` in the child env and exec `<cmd>`. **LLM path:** if the project is known to ignore `PORT` (see known-ignores list below) or a cached `flag`/`config` result exists, apply that mechanism instead. |
| `rifts list` | Runs `rift list`, joins with `ports.json`, prints: name, path, port, URL (`http://<name>.localhost:8080`). |
| `rifts proxy` | Starts the reverse proxy on `:8080` (or first free of 8080/8081/8082…). Foreground process; Ctrl-C to stop. Routes `Host: <name>.localhost` → that rift's assigned port. `*.localhost` resolves to 127.0.0.1 in-browser with zero external DNS dependency. |

No `init`, no `config`, no `up`/`down`. The proxy is a plain foreground process, not a daemon.

## The proxy

A single `http.createServer`. On each request:

1. Read the `Host` header, strip `:8080`, strip `.localhost` → rift name.
2. Look up the rift name in `ports.json.rifts` → port.
3. Pipe the request to `localhost:<port>`, pipe the response back (both directions, `req.pipe(proxyReq)` and `proxyRes.pipe(res)`).

`*.localhost` resolves to 127.0.0.1 in-browser on macOS, Linux, and Windows with no DNS setup and no external dependency — safer than `localtest.me` for a live demo on conference wifi. If the rift name isn't in `ports.json`, respond `404` with a short plain-text message naming the unknown rift. ~40 lines of Node, no library.

**Proxy port selection:** try binding `:8080`; if `EADDRINUSE`, try `:8081`, then `:8082`, up to `:8089`. Print the chosen port on startup so the user knows the URL suffix (`http://<name>.localhost:<chosen>`).

## Tech stack

Node + TypeScript. Plain `#!/usr/bin/env node` CLI, compiled with `tsc` to plain JS (run via `node dist/cli.js`, or published as a bin). Matches the build-week repo's existing stack. No Bun-specific APIs, no FFI.

## Error handling

Cases we handle, with clear messages:

- `rifts run` outside any rift → "not inside a rift workspace; run `rifts create` first".
- `rifts run` in a rift with no assigned port → auto-assign on the fly (friendlier than erroring).
- Port probe finds a candidate in use → skip to the next free port.
- `rift create` fails → surface rift's stderr, do not write `ports.json`, exit with rift's code.

Cases we explicitly **do not** handle in V1:

- Port released and reassigned to a different app between create and run (rare; acceptable for hackathon).
- Concurrent `rifts create` races (single-user, single-process tool).
- Rift removed via `rift remove` without `rifts` knowing → stale entries in `ports.json`. Acceptable in V1; a `rifts prune` command is a natural follow-up, not in scope.
- GPT-5.6 returns `portMechanism: "unknown"` → fall back to the `PORT` env fast path and warn. The tool still works; we don't hard-fail on an uncertain model answer.

## Testing

Unit-test the pure logic only:

- Port assignment: picks the first free port ≥8800, correctly skips an in-use port.
- `ports.json` read/write round-trips correctly (rifts + projects sections).
- Host-header parsing: `brave-otter.localhost:8080` → `brave-otter`.
- LLM response parsing: a GPT-5.6 response `{ portMechanism: "flag", flagTemplate: "--port {port}" }` renders to `--port 8801`; `env` mechanism sets the named var; `unknown` falls back to `PORT` + warning.
- Cache key: same `name@version` → cache hit, no second LLM call.

Integration smoke test: spin a real `http.createServer` on an assigned port, assert `rifts run` routes to it (or for the proxy, that a request to `<name>.localhost:8080` reaches the upstream). Do not test rift itself or make real GPT-5.6 calls in tests — mock the LLM response.

## Non-goals (V1)

- Remote / hosted / multi-machine previewing (strictly localhost).
- HTTPS / TLS termination (plain HTTP).
- HMR / WebSocket socket plumbing beyond what the reverse proxy passes through by default.
- Cross-origin cookie isolation per subdomain.
- A daemon, a config file format, a plugin system, or a TUI.

Port assignment for servers that read neither `PORT` nor a discoverable flag/config **is** in scope — that's the GPT-5.6 fallback's job. Servers that hardcode a port in source code with no external override are the genuine remaining limitation; `rifts run` warns and exits if GPT-5.6 returns `unknown` for them.

## Demo

```
rifts create              # → brave-otter, port 8801
rifts create              # → quiet-falcon, port 8802
rifts create              # → swift-lynx, port 8803
rifts proxy &             # start :8080 reverse proxy
# in 3 rifts:
rifts run npm run dev
# open:
#   http://brave-otter.localhost:8080
#   http://quiet-falcon.localhost:8080
#   http://swift-lynx.localhost:8080
```

Four rifts, four live previews, zero port collisions, near-zero extra disk. That's the build-week demo. For a project that ignores `PORT` (e.g. a Vite app), the first `rifts run npm run dev` calls GPT-5.6 once to learn `--port {port}`, caches it, and every subsequent run — in this rift or any other rift of the same project — uses the cached result with no further LLM calls.

## File layout (expected)

```
rifts/
  package.json        # name: rifts, bin: { "rifts": "./dist/cli.js" }, type: module
  tsconfig.json       # target ES2022, module NodeNext
  src/
    cli.ts            # #!/usr/bin/env node; parseArgs dispatch to create/run/list/proxy
    ports.ts          # read/write ports.json (atomic), free-port probe, resolve current rift
    create.ts         # wrap rift create, parse stdout, assign port, write ports.json
    run.ts            # resolve rift, two-tier injection (fast PORT + LLM fallback)
    llm.ts            # GPT-5.6 call, known-ignores list, response parsing, cache read/write
    list.ts           # exec rift list, join with ports.json, print table
    proxy.ts          # node:http reverse proxy, Host-header routing
  __tests__/
    ports.test.ts     # free-port probe, read/write round-trip, rift resolution
    llm.test.ts       # response parsing (flag/env/unknown), cache key
    proxy.test.ts     # host-header → rift name, 404 for unknown
```

## Build & verify

From `rifts/`:

```sh
npm install           # installs typescript, @types/node, openai (dev deps)
npx tsc               # compiles src/ → dist/
npm link              # makes `rifts` available on PATH locally
```

Verify each command end-to-end against a scratch project:

```sh
# 1. rift must be installed (rift is a prerequisite, not bundled)
rift --version

# 2. create a rift via rifts, confirm port assignment
cd /path/to/test-project
rift init
rifts create --name test-one
# expect: <path>/test-one → port 8801

# 3. run a PORT-reading server, confirm it starts on the assigned port
cd <path>/test-one
rifts run node -e 'require("http").createServer((q,s)=>s.end("ok")).listen(process.env.PORT)'
curl localhost:8801   # expect: ok

# 4. list
rifts list
# expect: test-one row with port 8801 and http://test-one.localhost:8080

# 5. proxy (in another terminal)
rifts proxy
curl -H "Host: test-one.localhost" localhost:8080   # expect: ok

# 6. LLM fallback (Vite project): confirm GPT-5.6 is called once and cached
#    set OPENAI_API_KEY, run rifts run npm run dev in a vite rift, check ports.json
#    has a projects.<signature> entry with portMechanism "flag"

# 7. no-key path: unset OPENAI_API_KEY, run again — expect warning + PORT fast path
```

The build is done when all 7 steps pass.
