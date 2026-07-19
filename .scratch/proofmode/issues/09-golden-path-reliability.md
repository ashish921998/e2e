# 09 — Golden-Path Reliability Gate

**What to build:** Make the entire ProofMode demonstration reproducible from one command and prove that it remains stable through ten consecutive complete runs on the presentation machine.

**Blocked by:** 08 — Export the Passing Test to the Repository.

**Status:** completed

**Implementation note:** The rehearsal uses strict target ports and waits for both Vite processes to exit, preventing cross-run target races. Ten consecutive rehearsal runs passed after that fix.

- [ ] One documented command prepares fixed data and starts every local service required by the demonstration.
- [ ] One complete run records the verification, interprets it, renders the test, passes locally, fails against the older target, and produces reviewable artifacts.
- [ ] The normal Proof Run completes within 30 seconds, excluding the visible Codex implementation segment.
- [ ] The demo has no runtime dependency on authentication, GitHub, third-party APIs, or public network access other than the intended OpenAI model call.
- [ ] The deterministic GPT fallback is tested and visibly identified when used.
- [ ] Ports, seed data, browser dependencies, and artifact locations are deterministic and validated before the presentation begins.
- [ ] The full golden path succeeds ten consecutive times, with the run results recorded for inspection.
- [ ] Any failure in the ten-run gate blocks submission recording until corrected and rerun.
