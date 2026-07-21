# e2e-proof — OpenAI Build Week submission

Status: code-ready. Items marked **(user)** require an authenticated account or final media.

## Category

Developer Tools — an autonomous web-tester that turns an LLM agent's browser
verification into a reviewable, deterministic proof on every pull request.

## One-line description

An agentic web tester for PRs: an LLM agent drives a real browser in an E2B
cloud sandbox, then an independent Playwright replay produces the verdict and
posts both videos to the PR — an agent's claim is never the proof; the replay is.

## Project description

AI coding agents can say they tested a change, but reviewers still have to trust
that claim. e2e-proof turns the agent's browser verification into something a
human can inspect and CI can enforce. GPT-5.6 explores a deployed pull request
in an isolated E2B desktop using a constrained set of accessible browser tools.
Every action and observation becomes structured data, not generated test code.
The tool then renders that session into a readable Playwright test and replays
it in a fresh browser. The replay—not the model narrative—produces the verdict,
video, trace, screenshots, and PR check.

The result is a framework-independent testing workflow that installs with one
GitHub Action plus two secrets. It makes agent verification reviewable,
repeatable, and capable of blocking a merge when the claimed behavior is absent.

## How Codex and GPT-5.6 were used

Codex was the development environment for designing and implementing the
constrained proof-plan contract, E2B integration, model tool loop, Playwright
renderer, GitHub Action, security redaction, tests, and submission hardening.
It was also used to challenge the original implementation: that review exposed
cases where a navigation-only replay or an ignored agent failure could produce
a false green result. Those findings led to the three-signal verdict gate.

GPT-5.6 is the runtime QA agent in the submitted demo. It receives the goal,
pull-request diff, and current screenshot; chooses only constrained browser and
terminal tools; and records accessible actions and user-visible assertions.
GPT-5.6 never writes executable Playwright code. The deterministic renderer and
fresh replay keep the final verdict independently verifiable.

## Technical highlights

- E2B isolated desktop with real Chrome and terminal access.
- GPT-5.6 Responses API tool loop with screenshots between turns.
- Accessible role/name operations rather than CSS selectors or coordinates.
- Constrained `RecordedSession` to `ProofPlan` to Playwright pipeline.
- Three-signal pass gate: assertion present, agent passed, replay passed.
- Replay video, trace, screenshots, generated test, and PR comment.
- Transcript credential redaction before persistence or model feedback.

## Built with / runs on

- **Built with:** Codex (development).
- **Runtime agent:** GPT-5.6 (OpenAI) by default; Claude Opus 4.8 (Anthropic)
  optional. Selected via `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (OpenAI wins when
  both are set) or `E2E_PROVE_PROVIDER` / `--provider`.

## What makes it a proof (not a claim)

1. The agent uses a **constrained tool set** (`goto`, `click(role,name)`,
   `fill(role,name,value)`, `observe_role`/`observe_text`, `bash`, `finish`)
   driven over CDP into sandboxed Chrome.
2. Every browser tool also appends a `RecordedBrowserEvent`, so the session
   renders straight into a `ProofPlan`.
3. `runProof` replays that plan once in a **fresh** browser with `video:"on"`.
4. A `passed` verdict requires **all three** of: the plan has an assertion step,
   the agent finished with `verdict: "pass"`, and the replay passed
   (`src/proof/verdict.ts`). A nav-only run or an agent `fail` can't pass.

## Public links and judge test path

- **Public repository:** https://github.com/ashish921998/e2e
- **Example PR:** https://github.com/ashish921998/e2e/pull/1
- **Existing proof video:** https://github.com/ashish921998/e2e/releases/download/proof-videos/pr-1-run-29834037811.mp4
- **One-click judge path:** after this branch is pushed and repository secrets
  `E2B_API_KEY` + `OPENAI_API_KEY` are configured, use the `proof` workflow's
  `workflow_dispatch` button. It uses repository secrets, so judges need no
  local installation or API keys. **(user)** configure the two secrets and
  preserve one successful GPT-5.6 run.
- **Adopt in your own repo:** copy one workflow file, add two secrets, reference
  `ashish921998/e2e@v1`. The Action installs its own deps + the replay's
  Chromium on the runner.

## Demo video (≤ 3 min) — *(user)* record with voiceover

Suggested beats:
1. The problem: "an agent said it tested my PR — did it?"
2. Open a PR; the Action boots E2B, the agent (GPT-5.6) explores, then the
   deterministic replay runs in a fresh browser.
3. The PR comment with both videos; show a **failing** proof turning the check red.
4. The three-signal verdict: nav-only ≠ pass, agent-fail ≠ pass, replay = proof.
5. Close on the pitch: built with Codex, runs on GPT-5.6, one file + two secrets.

## Codex feedback

- Codex Session ID for `/feedback`: **(user)** paste the session id here.

## Definition of done (submission checklist)

- [x] Engine typechecks (`tsc -b`) and `proof:rehearse` is green.
- [x] `decideVerdict` unit tests cover the three-signal gate (`tests/verdict.spec.ts`).
- [x] Action is self-contained (installs own deps + Chromium; no checkout needed).
- [x] Failing proof turns the CI check red (verdict gate step).
- [x] `package.json` publishable: name `e2e-prove`, MIT, `files`, `engines`.
- [x] GPT-5.6 is the documented and code default.
- [ ] *(user)* `npm publish` the `e2e-prove` package (so `npx e2e-prove` works).
- [ ] *(user)* tag `v1` so `uses: ashish921998/e2e@v1` resolves.
- [ ] *(user)* add `E2B_API_KEY` and `OPENAI_API_KEY` to the public repository and preserve a successful GPT-5.6 workflow run.
- [ ] *(user)* record the demo video + paste the Codex `/feedback` session id above.
