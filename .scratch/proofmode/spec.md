Status: implemented — remaining scope is explicitly tracked in tickets 06 and 10.

> Implementation update (2026-07-19): the local golden path is implemented: browser capture, constrained plan validation and rendering, fresh Playwright runtime replays, local/older targets, persisted local artifacts, reviewer, command-line export, and a ten-run reliability gate. Generic agent tool integration, automatic terminal capture, hosted runners, and automatic repository commits remain future scope.

# ProofMode: Agent Work as Reproducible Evidence

## Problem Statement

Developers can ask coding agents to implement product changes, but reviewing the resulting code is not enough to establish that the requested behavior works. Agents can report that they tested a feature without leaving behind a trustworthy, replayable record of what they exercised. Reviewers are therefore forced to check out the branch, install dependencies, start the application, reproduce the workflow, and interpret failures locally.

Existing browser recorders and end-to-end frameworks capture or execute tests, but they do not connect the agent's development session to an independently replayed acceptance test. Existing coding agents can modify code and use developer tools, but their successful interactive verification is normally discarded rather than converted into durable repository-owned evidence.

For the Build Week demonstration, this trust problem must be shown through one short, deterministic workflow. The product must visibly distinguish an agent's claim from an independently reproduced result.

## Solution

ProofMode is a local-first, open-source proof runner for coding agents. It gives an agent the same browser and terminal surfaces used during development, records a successful verification session as structured events, uses GPT-5.6 to interpret the session's intent and select meaningful assertions, renders those assertions into a deterministic Playwright test, and replays the generated test in a fresh browser context.

Each replay produces a Proof Bundle containing the generated test, target information, pass or fail verdict, browser video, screenshots, trace, terminal transcript, and the implementation diff. A reviewer can inspect the test and its evidence without running the application locally.

The Build Week golden path uses a small, deterministic shop application. Codex implements a low-stock warning, verifies the warning in Chrome, and asks ProofMode to create proof. ProofMode generates and independently replays the acceptance test against an updated local target, where it passes, and an older production-like target, where the same test fails visibly because the warning is absent.

## User Stories

1. As a developer, I want to give Codex a product task, so that it can implement the requested behavior.
2. As a developer, I want Codex to use a real terminal, so that its repository inspection, edits, and commands reflect an authentic development workflow.
3. As a developer, I want Codex to use a real browser, so that it can verify the user-visible behavior it implemented.
4. As a developer, I want ProofMode to record the agent's browser actions as structured events, so that successful exploration can be converted into a durable test.
5. As a developer, I want ProofMode to record relevant terminal activity, so that reviewers can understand how the agent developed and verified the change.
6. As a developer, I want recording to begin and end explicitly, so that unrelated activity is excluded from the proof.
7. As a developer, I want each recorded action to have a human-readable description, so that the resulting proof tells a coherent story.
8. As a developer, I want recording to preserve navigations, user actions, and observed outcomes, so that test generation has structured evidence rather than only pixels.
9. As a developer, I want sensitive environment values excluded from artifacts, so that proof can be shared safely.
10. As a developer, I want GPT-5.6 to infer the verification intent from the successful session, so that I do not have to hand-author the complete test.
11. As a developer, I want GPT-5.6 to return a constrained proof plan rather than arbitrary executable code, so that generated output remains predictable and safe to render.
12. As a developer, I want to see the proposed test name and assertions before replay, so that I can understand what behavior will be proven.
13. As a developer, I want generated assertions to use user-visible roles and text, so that the test describes product behavior rather than implementation details.
14. As a developer, I want unsupported or ambiguous recorded actions to be reported clearly, so that ProofMode never silently emits incomplete proof.
15. As a developer, I want ProofMode to render a readable Playwright test from the proof plan, so that the proof can live in the repository and be maintained by humans.
16. As a developer, I want the rendered test to be validated before execution, so that syntax or unsupported-step failures are separated from product failures.
17. As a developer, I want the generated test to run in a fresh browser context, so that success does not depend on state left behind by the agent.
18. As a developer, I want the replay to use fixed seed data, so that repeated runs produce the same observable state.
19. As a developer, I want the replay to complete quickly, so that creating proof feels like part of development rather than a separate CI job.
20. As a developer, I want to select a named target, so that the same proof can be evaluated against different deployed versions.
21. As a developer, I want target configuration to change the base URL without changing the test, so that local and production-like behavior remain directly comparable.
22. As a developer, I want ProofMode to show which target produced each verdict, so that evidence cannot be mistaken for a different environment.
23. As a reviewer, I want the local updated target to pass, so that I can see independent confirmation of the agent's implementation.
24. As a reviewer, I want the unchanged production-like target to fail the identical test, so that I can see that ProofMode detects real deployment drift.
25. As a reviewer, I want a concise pass or fail verdict, so that I can understand the outcome immediately.
26. As a reviewer, I want the exact generated test beside the verdict, so that I can judge whether the proof matches the requirement.
27. As a reviewer, I want to inspect the implementation diff, so that I can connect the claimed behavior to the code change.
28. As a reviewer, I want to play the browser video, so that I can see the behavior that produced the verdict.
29. As a reviewer, I want step screenshots, so that I can inspect important states without watching the full video.
30. As a reviewer, I want the Playwright trace, so that browser, network, and DOM details are available when a replay fails.
31. As a reviewer, I want the terminal transcript, so that I can inspect the agent's development and verification commands.
32. As a reviewer, I want the failed assertion and its captured screen shown together, so that the reason for failure is immediately understandable.
33. As a reviewer, I want proof artifacts to remain available after the run, so that review does not depend on a live agent session.
34. As a maintainer, I want the approved generated test committed to the repository, so that the behavior remains protected after the original proof run.
35. As a maintainer, I want the Proof Bundle to use a stable machine-readable manifest, so that a hosted runner can consume the same artifacts later.
36. As a maintainer, I want failed compilation, infrastructure failure, and failed product assertions to have distinct states, so that reviewers do not confuse runner problems with regressions.
37. As a maintainer, I want the system to fail closed when proof cannot be reproduced, so that an agent narrative is never presented as a passing verdict.
38. As a hackathon judge, I want to see the complete workflow in under three minutes, so that I can understand the problem, invention, and working implementation quickly.
39. As a hackathon judge, I want GPT-5.6 and Codex to have visible, substantive roles, so that the project demonstrates the event technologies rather than merely naming them.
40. As a hackathon judge, I want the same proof to pass and fail against controlled targets, so that the product's value is demonstrated rather than explained abstractly.

## Implementation Decisions

- The initial product is named ProofMode. Its central domain object is a Proof Bundle: independently replayable evidence for one claimed user-visible behavior.
- The golden-path task is adding a low-stock warning to a small shop product page when fewer than five items remain.
- The shop uses fixed local data. The demonstrated product contains a stable product with stock of three so the expected warning is deterministic.
- The proof workflow is explicit: record a successful agent session, compile a proof plan, render a test, validate it, replay it against a target, and present the Proof Bundle.
- The highest-level system boundary is a single Proof Run. A Proof Run accepts a recorded session and target, and returns either a complete Proof Bundle or a classified failure.
- Chrome and a terminal are the only agent surfaces required for the initial release.
- Browser activity is captured as structured events including navigation, accessible target description, user action, visible outcome, timestamps, and step labels. Video is evidence, not the source from which actions are reconstructed.
- Terminal activity is captured as a timestamped transcript. Secret-bearing commands and environment values must be redacted or excluded before persistence.
- GPT-5.6 converts the structured session into a constrained proof plan containing a test name, setup intent, supported actions, and supported assertions.
- GPT-5.6 does not provide the final executable verdict and does not return unrestricted code. A deterministic renderer converts the constrained proof plan into Playwright TypeScript.
- The supported golden-path action vocabulary is intentionally small: navigate to a relative path and wait for a user-visible page state. Additional interaction actions are added only if required by the final demonstration.
- The supported assertion vocabulary includes visible text and accessible-role assertions. The low-stock demonstration must use a user-visible assertion for the warning.
- Every generated proof plan is schema-validated. Unsupported, missing, or ambiguous actions stop the run with a compilation failure rather than being ignored.
- Playwright performs the independent replay in a new isolated browser context. The replay cannot reuse cookies, DOM state, or the page used during development verification.
- Target configuration is external to the generated test and supplies a name and base URL. The identical test must run against both `local` and `production` targets.
- The production target in the demonstration is a controlled older build of the shop, not an external service. This guarantees that the expected failure is deterministic and does not require network access.
- Proof verdicts are limited to `passed`, `failed`, `compile_error`, and `runner_error`. Only a completed Playwright run with all assertions passing receives `passed`.
- A Proof Bundle contains a manifest, generated test source, target metadata, verdict, assertion output, browser video, screenshots, Playwright trace, terminal transcript, and implementation diff.
- The manifest records artifact locations, timestamps, duration, target identity, and failure classification without embedding secrets.
- The review experience is a single page optimized for the demonstration. It leads with verdict and target, then presents video, generated test, diff, steps, screenshots, and diagnostic output.
- A failed replay shows the failed assertion and failure screenshot prominently. It must remain visually distinct from compilation and infrastructure failures.
- Proof artifacts are stored locally. The initial release requires no account, remote database, hosted storage, or external queue.
- The generated test may be copied or committed into the repository only after it has passed a clean replay. Repository commit automation is secondary to the core proof workflow and may be represented by an explicit export action if necessary.
- Codex has a visible role in implementing the shop feature with terminal and browser tools. GPT-5.6 has a visible role in interpreting the successful structured session into the proof plan.
- The normal proof replay must complete in under 30 seconds on the demonstration machine.
- The demonstration is performed against preinstalled browser dependencies with no runtime dependency on authentication, GitHub, third-party APIs, or public network availability.
- Product polish is concentrated on the single Proof Run and Proof Bundle review flow. General configuration and administration interfaces are deferred.
- The system is open source and local-first. A future hosted product may supply managed VMs and artifact storage without changing the Proof Bundle contract.

## Testing Decisions

- The primary and ideally single end-to-end testing seam is the Proof Run boundary: given a known recorded session and named target, ProofMode must produce a classified verdict and inspectable Proof Bundle.
- The golden-path acceptance test records the successful low-stock verification, compiles it, replays it against the updated local shop, and asserts a passing verdict plus the required artifacts.
- The contrast acceptance test sends the exact same generated test to the controlled older production target and asserts a failed product assertion plus a failure video or screenshot.
- Tests evaluate external behavior: visible shop output, generated test readability, replay isolation, verdict classification, and artifact availability. They do not assert internal model prompts, renderer implementation details, or component state.
- The proof-plan schema and deterministic renderer receive focused contract tests because malformed model output must never become arbitrary executable code.
- Target substitution receives a contract test proving that changing target configuration does not alter generated test source.
- Replay isolation receives a test demonstrating that browser state from the recording session is unavailable during replay.
- Failure classification receives tests distinguishing assertion failures, invalid proof plans, browser-launch failures, and target-unreachable errors.
- Artifact generation receives a test verifying that the manifest references the generated test, target, verdict, video or recording fallback, screenshots, trace, terminal transcript, and diff when applicable.
- Secret handling receives a test using synthetic credentials and verifying that they do not appear in persisted artifacts.
- Tests use fixed seed data, stable accessible names, local targets, and controlled ports. No acceptance test depends on an external API or public deployment.
- Playwright is the prior art for browser isolation, assertions, video, screenshots, and trace capture. The reviewed Executor E2E implementation is prior art for cross-target scenarios and placing test source beside recorded artifacts, but ProofMode's session-to-proof-plan compiler remains the differentiating seam.
- Before presentation, the complete golden path must succeed ten consecutive times on the demonstration machine. Each run must include recording, compilation, clean replay, passing local proof, failing old-target proof, and playable evidence.
- The submission recording is made only after the ten-run reliability gate passes.

## Out of Scope

- General autonomous QA exploration that discovers unknown test cases without a developer task.
- A full replacement for Playwright, Vitest, CI providers, or coding agents.
- Hosted VM orchestration, subscriptions, billing, organization management, and multi-user collaboration.
- A production-grade macOS, Windows, and Linux execution matrix.
- Mobile-device testing, native applications, Safari, Firefox, and multiple Chromium versions.
- Arbitrary terminal-to-test conversion or unrestricted model-generated executable test code.
- Complex authentication, payment, email, or third-party API workflows.
- Automatic production deployment or rollback.
- Long-running background agents.
- A generalized visual-regression platform.
- Broad test maintenance, automatic selector healing, flake management, and historical analytics.
- Multiple demonstration applications or multiple feature scenarios before the golden path is reliable.
- Recreating Executor's complete E2E infrastructure or viewer.
- Building LiveSpec, company messaging, a company brain, issue tracking, or collaborative design workspaces.

## Further Notes

- The product promise is: “Coding agents can write software. ProofMode makes their claims independently verifiable.”
- The decisive trust rule is that an agent's narrative is never proof. Only a fresh deterministic replay can produce a passing verdict.
- The three-minute story has three acts: Codex develops and verifies the warning; ProofMode compiles and passes the proof locally; the identical proof fails against the controlled older target.
- The most important milestone is one reliable interaction: create proof, generate a real Playwright test, replay it in a fresh browser, and display the passing video.
- The repository context and ADR now use ProofMode terminology. This spec remains the original design record; individual ticket status records the implementation boundary more precisely.
