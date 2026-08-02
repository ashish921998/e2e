# e2e-proof

**Agentic end-to-end testing for any web app.** An LLM agent drives a real browser to verify your change, then a deterministic Playwright replay produces the verdict. The replay video lands on the pull request (both videos are attached to the run as artifacts).

> An agent's claim is not the proof — the independent replay is.

`e2e-proof` runs on every PR: it boots an isolated cloud sandbox (E2B — real Chrome + a terminal), a frontier model explores the app to confirm the change works, then the **same engine** replays the recorded steps in a fresh browser to issue a pass/fail verdict you can gate on. It is framework-agnostic — anything reachable by URL works (React, Vue, Svelte, static, SSR).

## Why

Most "AI testing" tools stop at the agent saying "it looked fine." That claim is not evidence. `e2e-proof` splits the work in two:

1. **Exploration** — a model uses a constrained tool set (`goto`, `click`, `fill`, `observe_role`, `observe_text`, `bash`, `finish`) to exercise the change. This is creative and non-deterministic.
2. **Replay** — every browser action the agent took is compiled into a real Playwright spec and re-run in a **fresh** browser context. Only this replay's assertions can produce a `passed` verdict.

The exploration video shows the journey; the replay video is the proof.

## Quick start (GitHub Action)

One workflow file + two secrets. Drop this into `.github/workflows/e2e-proof.yml`:

```yaml
on:
  deployment_status:          # fires when your preview deploy succeeds
jobs:
  proof:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: ashish921998/e2e@v1
        with:
          goal: "Verify the changed feature works."
        env:
          E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}   # or ANTHROPIC_API_KEY
```

That's the whole install. The action is self-contained — it installs its own dependencies and the replay's Chromium on the runner, so the consuming repo needs no Playwright, no copied code, no wiring. It auto-resolves the PR's preview URL from the `deployment_status` event (works with Vercel, Netlify, Cloudflare Pages, Render, Amplify); pass `base-url` to override, or trigger on `pull_request` with an explicit URL.

**Secrets:** `E2B_API_KEY` (required) plus one model key — `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. When both are present OpenAI is used; override with the `E2E_PROVE_PROVIDER` env var.

## CLI

Run the same pipeline locally or in any CI:

```sh
npx e2e-prove --url https://your-preview.app --goal "the cart total updates on add"
# → proof-out/agent-exploration.mp4, proof-out/replay/bundle.json, exit 0 on pass
```

The exit code **is** the verdict, so CI gates on it directly.

| Flag          | Purpose                                                        |
| ------------- | ------------------------------------------------------------- |
| `--url`       | Target URL to test (required).                                |
| `--goal`      | What the agent should verify, in plain language.              |
| `--diff`      | Path to a unified diff; grounds the agent on the PR change.   |
| `--max-steps` | Agent step cap (default 25).                                  |
| `--model`     | Explicit model id for the provider.                           |
| `--provider`  | `openai` or `anthropic` (overrides key-based detection).      |
| `--no-replay` | Exploration video + agent verdict only; skips the replay. The verdict gate needs the replay, so such a run never `passed` (exits `2`). |
| `--out`       | Output directory (default `proof-out/`).                      |
| `--target-id` | Target id recorded in the bundle (default `preview`).         |

The CLI resolves its **own** pinned Playwright install for the replay — your repo never needs Playwright as a dependency. Install its matching browser binary once on the host: `npx --yes playwright@1.61.1 install chromium`.

## Configuration

Action inputs (see [`action.yml`](action.yml) for the canonical list):

| Input          | Default | Description                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `goal`         | `Verify the changed feature works against the running app.` | What the agent should verify, in plain language. |
| `base-url`     | —       | Explicit URL to test; overrides auto-detection.                             |
| `preview-url`  | —       | Fallback URL when neither `base-url` nor a deployment event is available.   |
| `max-steps`    | `25`    | Agent step cap.                                                             |
| `model`        | —       | Optional model id override for the chosen provider.                         |
| `no-replay`    | `false` | If `true`, skip the deterministic replay.                                   |
| `comment-on-pr`| `true`  | Post the verdict + video link as a PR comment.                              |
| `github-token` | `github.token` | Token for posting the PR comment and uploading the video asset.      |

## How it works

```text
PR → action → startSandbox(E2B) → agent loop (model + tools) → RecordedSession
            → deterministicPlanFromSession → runProof (fresh Playwright, video:on) → verdict + videos → PR comment
```

1. The agent calls a **constrained tool set** over a CDP connection into the sandboxed Chrome.
2. Every browser tool **also** appends a `RecordedBrowserEvent` to a `RecordedSession`.
3. When the agent finishes, `deterministicPlanFromSession` compiles the session into a schema-validated `ProofPlan`.
4. `renderPlaywrightTest` turns the plan into a real Playwright spec.
5. `runProof` replays that spec once in a **fresh** browser with `video: "on"`. Only this replay's assertions can return `passed`.

Because the replay uses `getByRole(...)` locators (robust to CSS/class churn) and a constrained action schema, the proof resists incidental UI changes — it fails on genuine behavior changes, not styling noise. Browser, network, timing, or target-availability problems can still surface as failures; the goal is that a red verdict reflects a real behavioral difference rather than a brittle selector.

### Why a sandbox

The E2B sandbox is the "give the agent a computer" layer: an isolated cloud VM with Chrome, a terminal, and a live stream, with nothing to install on the runner. The agent attaches Playwright over the CDP URL E2B exposes; the replay then runs its own Playwright + Chromium on the GitHub runner, which is what produces the verdict.

## Supported platforms

- **CI:** GitHub Actions (`ubuntu-latest`); portable to any CI via the `npx` CLI.
- **Sandbox:** E2B cloud Linux VM (Ubuntu) — Chrome + terminal + recording for the agent's exploration.
- **CLI host:** Node 20.18.1–20.x or Node 22+ on macOS / Linux / Windows (WSL).
- **Target:** any web app reachable by URL — framework-agnostic.
- **Models:** any OpenAI or Anthropic model id, selected by which key is present or via `E2E_PROVE_PROVIDER` / `--provider`.

## Developing

```sh
git clone <this-repo>
npm ci
npm run playwright:install        # install this package's pinned Chromium for the replay
npm run typecheck                 # tsc -b across src/, bin/, tests/
npm run test:unit                 # pure-logic specs — no sandbox, no browser, no keys
node bin/e2e-prove.mjs --help     # launcher smoke
```

The unit suite covers the verdict gate, the session→plan→Playwright-source round-trip, transcript redaction, and CLI argument parsing — everything decidable without a sandbox or model key.

To exercise the full pipeline locally you'll need `E2B_API_KEY` and a model key in your environment; the engine degrades to a deterministic interpreter when no model is available.

## License

MIT — see [LICENSE](LICENSE).
