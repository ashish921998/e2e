# Constrain model output before rendering executable tests

## Status

Accepted.

## Context

e2e uses a model to interpret a Recorded Session, but an agent's explanation or arbitrary generated JavaScript cannot be treated as executable proof. The generated behavior must be understandable, reviewable, and safe to run locally.

## Decision

The model returns only a schema-validated Proof Plan. The allowed first-release steps are relative navigation, role-based click and fill actions, visible-text assertions, and role-based visibility assertions. A deterministic renderer is the sole component that emits Playwright source.

The runtime rejects malformed, unsupported, missing, or ambiguous plan data as `compile_error`. If the optional GPT-5.6 request is unavailable or invalid, the local deterministic interpreter derives a plan from supported captured events. The fresh Playwright replay, not the model response, determines the Verdict.

## Consequences

- The generated test is readable and can be exported only after a successful independent replay.
- The model cannot introduce unrestricted shell commands, selectors, URLs, or arbitrary JavaScript into the runner.
- The first release intentionally supports a narrow interaction vocabulary; additional actions require an explicit schema and renderer change.
- The fallback keeps local rehearsals reliable without presenting a missing model response as a pass.
