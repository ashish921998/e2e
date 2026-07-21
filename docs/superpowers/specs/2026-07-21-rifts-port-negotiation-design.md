# rifts — deterministic per-rift port assignment

**Status:** Draft
**Date:** 2026-07-21
**Target:** Build-week V1

## Problem

[Rift](https://github.com/anomalyco/rift) creates isolated copy-on-write workspaces in <0.1s with near-zero extra disk. But every dev server inside a rift still wants the same hardcoded port — 3000 (Next), 5173 (Vite), 8080 (Express) — so the second rift's `npm run dev` crashes with `EADDRINUSE`. Rift does filesystem isolation and nothing else. In practice you can preview one rift at a time, which defeats the entire payoff of running parallel rifts (parallel agents, parallel experiments, parallel branches).

## Idea

Port assignment is a **property of the rift workspace**, decided at creation time and bound for the workspace's lifetime.

- `rifts create` wraps `rift create`, then assigns the next free port and records it.
- `rifts run <cmd>` runs a command from inside a rift, automatically injecting that rift's assigned port via the `PORT` env var.
- `rifts list` shows each rift, its port, and its preview URL.
- `rifts proxy` runs a local reverse proxy so `<rift-name>.localtest.me` routes to that rift's port.

The port is deterministic (same rift → same port across restarts), decoupled from launch (no separate "up" step), and has no race window (assigned at create, not lazily).

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
  "brave-otter":   { "port": 8801, "path": "/Users/x/.rifts/app/brave-otter" },
  "quiet-falcon":  { "port": 8802, "path": "/Users/x/.rifts/app/quiet-falcon" }
}
```

Keyed by rift name (unique within a source). Each entry stores the assigned port and the absolute path to the workspace. We don't own workspace identity — rift does — we only annotate each with a port.

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
| `rifts run <cmd> [args…]` | Resolves the current rift (walk ancestors for `.rift` marker), looks up its port in `ports.json` (auto-assigns if missing), sets `PORT=<n>` in the child env, `exec`s the command. Works for any server that reads `PORT`. |
| `rifts list` | Runs `rift list`, joins with `ports.json`, prints: name, path, port, URL (`http://<name>.localtest.me:8080`). |
| `rifts proxy` | Starts the reverse proxy on `:8080` (or first free of 8080/8081/8082…). Foreground process; Ctrl-C to stop. Routes `Host: <name>.localtest.me` → that rift's assigned port. |

No `init`, no `config`, no `up`/`down`. The proxy is a plain foreground process, not a daemon.

## The proxy

A single `http.createServer`. On each request:

1. Read the `Host` header, strip `:8080`, strip `.localtest.me` → rift name.
2. Look up the rift name in `ports.json` → port.
3. Pipe the request to `localhost:<port>`, pipe the response back.

`localtest.me` is a public domain that resolves all subdomains to `127.0.0.1`, so `<anything>.localtest.me` needs zero DNS setup on any OS. If the rift isn't in `ports.json`, respond `404` with a short message. ~40 lines of Node, no library.

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

## Testing

Unit-test the pure logic only:

- Port assignment: picks the first free port ≥8800, correctly skips an in-use port.
- `ports.json` read/write round-trips correctly.
- Host-header parsing: `brave-otter.localtest.me:8080` → `brave-otter`.

Integration smoke test: spin a real `http.createServer` on an assigned port, assert `rifts run` routes to it (or for the proxy, that a request to `<name>.localtest.me:8080` reaches the upstream). Do not test rift itself.

## Non-goals (V1)

- Remote / hosted / multi-machine previewing (strictly localhost).
- HTTPS / TLS termination (plain HTTP).
- HMR / WebSocket socket plumbing beyond what the reverse proxy passes through by default.
- Cross-origin cookie isolation per subdomain.
- Port assignment for non-`PORT`-reading servers (servers that hardcode a port and ignore `PORT` are out of scope; document as a known limitation).
- A daemon, a config file format, a plugin system, or a TUI.

## Demo

```
rifts create              # → brave-otter, port 8801
rifts create              # → quiet-falcon, port 8802
rifts create              # → swift-lynx, port 8803
rifts proxy &             # start :8080 reverse proxy
# in 3 rifts:
rifts run npm run dev
# open:
#   http://brave-otter.localtest.me:8080
#   http://quiet-falcon.localtest.me:8080
#   http://swift-lynx.localtest.me:8080
```

Four rifts, four live previews, zero port collisions, near-zero extra disk. That's the build-week demo.

## File layout (expected)

```
src/
  cli.ts          # arg parsing, command dispatch
  ports.ts        # ports.json read/write + free-port probe
  create.ts       # wrap rift create, assign port
  run.ts          # resolve rift, set PORT, exec
  list.ts         # join rift list + ports.json
  proxy.ts        # reverse proxy (~40 lines)
__tests__/        # unit tests for ports.ts + host parsing
```
