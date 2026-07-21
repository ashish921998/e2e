# rifts — deterministic per-rift port assignment

**Status:** Draft
**Date:** 2026-07-21
**Target:** Build-week V1

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

Triggering the fallback: the fast path only fails visibly (a server that silently ignores `PORT` and grabs 5173 anyway is undetectable at run time), so we trigger the LLM when the project matches a known `ignoresPort` list (Vite, Django dev server) rather than waiting for a collision. This keeps the LLM call predictable and keeps the common Express/Next case on the free fast path.

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

One JSON file at `~/.rifts/ports.json`:

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
    "vite-app@5.x": {
      "portMechanism": "flag",
      "flagTemplate": "--port {port}",
      "confidence": 0.9
    }
  }
}
```

Two top-level keys: `rifts` (per-workspace port + path) and `projects` (per-project cached GPT-5.6 result, keyed by `name@version` from `package.json`). The project cache makes the LLM a one-time cost per project, not per run — `rifts run` only calls GPT-5.6 the first time it sees a new project, and serves from cache on every subsequent run across all rifts of that project.

No sqlite. We don't need concurrent writes, transactions, or relational queries. One JSON file is readable, debuggable by hand, and ~10 lines of code.

### Port range

Start at **8800**, increment by 1 per new rift. Before assigning, probe the port with `net.createServer().listen()` — if it's in use, skip to the next. 8800+ avoids colliding with common dev defaults (3000/5173/8080), so there's never confusion about whether `:5173` is a rift or the user's normal server.

### rift integration

We **wrap** `rift create` as a subprocess — we do not fork rift. This keeps upstream swappable and respects rift's constraints:

- rift's `.rift.toml` config schema is `deny_unknown_fields` and only supports `[[hooks.postcreate]] run = "..."`. We cannot extend it, so port metadata lives in our own `ports.json`, never in rift's config.
- rift prints the new workspace path to stdout on `create`. `rifts create` parses that path from stdout to know which workspace was just created.
- rift resolves the current workspace by walking `cwd.ancestors()` and reading the `.rift` marker. `rifts run` does the same walk to resolve "which rift am I in" before looking up the port.

## CLI surface

| Command | What it does |
|---|---|
| `rifts create [args…]` | Runs `rift create` with the same args, parses the new workspace path from rift's stdout, derives the rift name from the last path segment (`<path>/<name>`), assigns the next free port (≥8800), writes `ports.json`, prints `<path> → port <n>`. Pass-through: unknown args forward to rift. |
| `rifts run <cmd> [args…]` | Resolves the current rift (walk ancestors for `.rift` marker), looks up its port in `ports.json` (auto-assigns if missing). **Fast path:** if the project has no cached mechanism or cached `env`/`PORT`, set `PORT=<n>` and exec. **LLM path:** if the project is known to ignore `PORT` (Vite etc.) or a cached `flag`/`config` result exists, apply that mechanism instead. |
| `rifts list` | Runs `rift list`, joins with `ports.json`, prints: name, path, port, URL (`http://<name>.localhost:8080`). |
| `rifts proxy` | Starts the reverse proxy on `:8080` (or first free of 8080/8081/8082…). Foreground process; Ctrl-C to stop. Routes `Host: <name>.localhost` → that rift's assigned port. `*.localhost` resolves to 127.0.0.1 in-browser with zero external DNS dependency. |

No `init`, no `config`, no `up`/`down`. The proxy is a plain foreground process, not a daemon.

## The proxy

A single `http.createServer`. On each request:

1. Read the `Host` header, strip `:8080`, strip `.localhost` → rift name.
2. Look up the rift name in `ports.json` → port.
3. Pipe the request to `localhost:<port>`, pipe the response back.

`*.localhost` resolves to 127.0.0.1 in-browser on macOS, Linux, and Windows with no DNS setup and no external dependency — safer than `localtest.me` for a live demo on conference wifi. If the rift isn't in `ports.json`, respond `404` with a short message. ~40 lines of Node, no library.

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
src/
  cli.ts          # arg parsing, command dispatch
  ports.ts        # ports.json read/write + free-port probe
  create.ts       # wrap rift create, assign port
  run.ts          # resolve rift, two-tier port injection (fast + LLM)
  llm.ts          # GPT-5.6 call for port mechanism (cached in ports.json)
  list.ts         # join rift list + ports.json
  proxy.ts        # reverse proxy (~40 lines)
__tests__/        # unit tests for ports.ts, llm response parsing, host parsing
```
