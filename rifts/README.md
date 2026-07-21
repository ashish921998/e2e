# rifts

Deterministic per-rift port assignment for parallel [rift](https://github.com/anomalyco/rift) workspaces.

Rift isolates filesystems but every dev server wants the same hardcoded port (3000/5173/8080), so a second rift's `npm run dev` crashes with `EADDRINUSE`. `rifts` assigns each rift its own port at creation time and injects it at run time — so parallel rifts get parallel live previews with zero collisions.

## Install

```sh
cd rifts
npm install      # typescript, @types/node (dev deps)
npx tsc          # compile src/ → dist/
npm link         # make `rifts` available on PATH
```

Requires Node ≥ 20 and `rift` on PATH.

## Usage

```sh
rifts create             # wrap `rift create`, assign + record a port (≥8800)
rifts run <cmd> [args…]  # run a command in the current rift with its port injected
rifts list               # list rifts with ports and preview URLs
rifts proxy              # local reverse proxy on :8080 (Host → rift)
```

### Port injection (two tiers)

1. **Fast path (default, free, instant):** sets `PORT=<n>` in the child env. Works for any server that reads `PORT` (Express, Next, Parcel, most Node servers).
2. **LLM fallback:** for projects known to ignore `PORT` (currently `vite`, `@docusaurus/core`), `rifts run` asks GPT-5.6 how this server receives a port, applies it, and caches the result in `ports.json` keyed by `name@version` — so GPT-5.6 is called **at most once per project**, ever, across all rifts.

Without `OPENAI_API_KEY`, the tool skips the LLM entirely, uses the `PORT` fast path, and warns once.

## Design

See [`docs/superpowers/specs/2026-07-21-rifts-port-negotiation-design.md`](../docs/superpowers/specs/2026-07-21-rifts-port-negotiation-design.md) for the full design spec. The entire data model is one file at `~/.rifts/ports.json`:

```json
{
  "rifts":    { "<rift-name>": { "port": 8801, "path": "/abs/path" } },
  "projects": { "my-app@0.1.0": { "portMechanism": "flag", "flagTemplate": "--port {port}", "confidence": 0.9 } }
}
```

Zero runtime dependencies; the OpenAI Chat Completions API is called via Node's built-in `fetch`.

## Test

```sh
npx tsc && npm test   # 32 unit/integration tests; no real GPT-5.6 calls (mocked)
```

An end-to-end smoke test (real rift, real HTTP server, real proxy) lives in `scripts/smoke.mjs`.
