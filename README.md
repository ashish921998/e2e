# ProofMode

ProofMode turns an agent's successful browser verification into a reviewable proof: a constrained, readable Playwright test replayed in a fresh browser, with a verdict and its visual evidence. The Build Week golden path is deliberately narrow: an agent adds the Vintage Camera low-stock warning, then ProofMode proves it locally and exposes deployment drift against an older target.

## Implementation status

The local golden path is implemented and validated. A user can capture a browser session, run a fresh local replay through the Vite runtime, inspect the generated test and video in the reviewer, rehearse local-pass/older-target-failure behavior, and export a verified rehearsal test. GPT-5.6 interpretation is optional because the runner must remain deterministic when `OPENAI_API_KEY` is unavailable.

Not yet included: generic Codex/computer-use hooks, automatic terminal recording, hosted runners, cross-platform VM orchestration, accounts, and automatic GitHub commits.

## Setup

```sh
npm install
npx playwright install chromium
```

Start the updated app and open the proof reviewer at [http://127.0.0.1:5173/proof](http://127.0.0.1:5173/proof):

```sh
npm run dev:local
```

On the shop page, use **Start recording** and **Stop & save** to capture the live product semantics in this browser. Then choose **Create proof** and **Run fresh replay**. Use `?target=production` on the proof page to inspect the controlled older-target failure; for a live production replay, start the older target separately and launch the updated app with `PROOFMODE_PRODUCTION_URL=http://127.0.0.1:4174`.

## How the proof flow works

1. A browser session records only structured actions and observations: paths, accessible roles/names, visible text, timestamps, and optional terminal transcript.
2. GPT-5.6 may interpret that successful session into a **constrained Proof Plan**. It never returns arbitrary JavaScript; invalid or unavailable model output falls back to deterministic interpretation.
3. The renderer turns the validated plan into Playwright source.
4. Playwright replays the source in a fresh browser context against a chosen target.
5. The Proof Bundle presents the generated test, target, verdict, diff, terminal evidence, trace, screenshots, and browser video. A model narrative is never treated as proof—the independent replay is the verdict.

The reviewer opens a small seeded example when no capture is selected, but its primary path accepts a live session captured in the browser and sends it to the local runner. Terminal transcript is evidence only, never an assertion source.

## Targets and direct E2E commands

`npm run dev:local` serves the current updated product, where the Vintage Camera displays `Only 3 left`.

`npm run dev:legacy` serves a controlled older release, where that warning is deliberately absent. Both targets retain the same product data, selectors, and E2E source.

```sh
# Updated target: passes and records video
npm run test:e2e

# Older target: intentionally fails the exact same test
npm run dev:legacy -- --port 4174
E2E_BASE_URL=http://127.0.0.1:4174 npm run test:e2e
```

Playwright stores video for every run and keeps screenshots and traces for failures in `test-results/`. View the HTML report with `npm run test:e2e:report`.

## Reliability rehearsal and test export

The reliability rehearsal starts both controlled targets, runs the same proof against each, and writes all artifacts plus `summary.json` to a timestamped `proof-runs/` folder. It exits non-zero unless the updated target passes with video and the older target fails with video and screenshot.

```sh
node scripts/reliability.mjs
```

After a fully passing rehearsal, export its passing generated test without overwriting existing exports:

```sh
node scripts/export-proof.mjs <proof-run-id>
# Optional stable export name
node scripts/export-proof.mjs <proof-run-id> low-stock.proof.spec.ts
```

Exports go to `proof-exports/` with a small sidecar that records the source proof run. Do not export failed or incomplete proofs.

## Optional GPT-5.6 configuration

The demo remains deterministic and offline-rehearsable. For live session interpretation, configure the server-side OpenAI integration with `OPENAI_API_KEY`; never expose this key in the browser or commit it. If no model call succeeds, ProofMode validates and uses its deterministic fallback rather than inventing a test.

## Three-minute demo script

1. Open the small shop and state the task: “Add a warning when fewer than five items remain.”
2. Show Codex’s terminal/browser development evidence and the resulting `Only 3 left` warning.
3. Open `/proof`: the reviewer sees the generated Playwright test, implementation diff, and fresh local `PASS` with video.
4. Switch to `?target=production`. The byte-identical test runs against the older target and fails at the missing low-stock assertion; play the captured failure video.
5. Close: “An agent’s claim is not proof. ProofMode independently replays the claim.”

For a rehearsal, run the reliability command before recording and use its timestamped artifacts as backup evidence.
## Local proof-run API

While `vite` is running, `POST /api/proof-runs` turns a constrained recorded browser session into a fresh Playwright replay. The body is `{ "session": RecordedSession, "targetId": "local", "preferModel": false }`. `targetId` is restricted to `local` and, only when `PROOFMODE_PRODUCTION_URL` is set, `production`; callers cannot choose arbitrary URLs. Set `preferModel` to `true` with `OPENAI_API_KEY` to ask GPT-5.6 for the constrained plan. The runner falls back to the deterministic interpreter if the model is unavailable.

Runs and evidence are written beneath the gitignored `proof-runs/` directory and served read-only at `/proof-runs/<run-id>/...`. The response is a serialized Proof Bundle with the generated test and artifact URLs. Never put secrets in a recorded terminal transcript; the runtime redacts common credential assignments before persisting it.
