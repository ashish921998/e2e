# 04 — Deterministic Proof-Plan Compiler

**What to build:** Turn a constrained Proof Plan into a validated, readable Playwright test and independently replay it against either configured target with trustworthy failure classification.

**Blocked by:** 02 — Same Proof Against an Older Target; 03 — Recorded Browser Session Becomes a Proof Plan.

**Status:** implemented

**Implementation note:** The renderer accepts only the constrained schema, executes in a fresh Playwright process, supports named targets, and classifies replay outcomes. Focused unit-test coverage remains a follow-up; the runtime and E2E seams are validated.

- [ ] Proof Plans are validated against an explicit supported action and assertion schema.
- [ ] A deterministic renderer converts a valid Proof Plan into readable Playwright TypeScript.
- [ ] The rendered test uses user-visible roles or text rather than implementation-specific selectors.
- [ ] The rendered test runs in a fresh browser context and cannot reuse state from the recording session.
- [ ] The same rendered test can run against either configured target without source changes.
- [ ] Outcomes are classified as `passed`, `failed`, `compile_error`, or `runner_error`.
- [ ] Invalid, missing, ambiguous, or unsupported plan data fails closed with `compile_error`.
- [ ] Contract tests cover schema validation, deterministic rendering, target substitution, replay isolation, and failure classification.
