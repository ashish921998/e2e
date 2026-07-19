# ProofMode

ProofMode is a local-first proof runner for coding-agent work. It records a successful browser verification as structured evidence, compiles that evidence into a constrained Playwright test, replays the test in a fresh browser, and presents the resulting artifacts as a reviewable Proof Bundle.

The Build Week implementation demonstrates one deterministic behavior: a Vintage Camera product with three remaining units must display `Only 3 left`. The same generated proof passes against the updated local target and fails against a controlled older target that omits the warning.

## Language

**ProofMode**:
A local-first product that turns a coding agent's browser verification into independently replayed evidence.
_Avoid_: Agent dashboard, autonomous QA platform

**Recorded Session**:
An explicit browser capture containing structured navigation, interaction, and user-visible observation events. It is source material for a proof, not itself a verdict.
_Avoid_: Video recording, test result

**Proof Plan**:
A schema-validated, constrained sequence of supported browser actions and assertions derived from a Recorded Session.
_Avoid_: Arbitrary model code, free-form test

**Proof Run**:
One fresh execution of a rendered Proof Plan against a named Target. It produces the verdict.
_Avoid_: Agent claim, browser session

**Proof Bundle**:
The persisted evidence from a Proof Run: result manifest, generated test, target metadata, video, screenshots when applicable, trace, terminal evidence when attached, and artifact URLs.
_Avoid_: Test report, model output

**Target**:
A named deployment shape of the product, identified by a controlled base URL. The initial targets are `local` and an opt-in older `production` target.
_Avoid_: Arbitrary URL, environment variable dump

**Independent Replay**:
A Playwright execution in a fresh browser context. Only its executable assertions may produce a `passed` verdict.
_Avoid_: Agent verification, visual claim

**Verdict**:
The classified result of a Proof Run: `passed`, `failed`, `compile_error`, or `runner_error`.
_Avoid_: Confidence score, AI judgement

**Reliability Rehearsal**:
The repeatable local command that verifies a local pass and older-target failure with required artifacts. The current implementation completed ten consecutive successful rehearsals after fixing server-port teardown.
_Avoid_: Unit test, static demo

## Current scope

- Browser capture records the live product path, visible product semantics, and browser interactions to local storage.
- The local Vite runtime accepts a constrained Recorded Session, optionally asks GPT-5.6 for a Proof Plan, falls back deterministically when unavailable, runs a fresh Playwright process, and stores artifacts in gitignored `proof-runs/`.
- A reviewer can inspect a generated test, verdict, runtime video, screenshots on failure, trace, and terminal text when present.
- Passing rehearsal tests can be exported by command without overwriting an existing export.

## Deliberately not implemented

- Generic agent/computer-use integration or automatic terminal recording.
- Hosted runners, virtual-machine matrices, accounts, collaboration, and remote artifact storage.
- Automatic commits or pull requests.
- Model-generated test steps beyond the constrained Proof Plan schema.
