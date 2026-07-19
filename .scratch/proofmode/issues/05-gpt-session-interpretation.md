# 05 — GPT-5.6 Session Interpretation

**What to build:** Use GPT-5.6 to interpret a successful structured browser session into the constrained Proof Plan while keeping test rendering and the final verdict deterministic.

**Blocked by:** 04 — Deterministic Proof-Plan Compiler.

**Status:** implemented — optional model call not exercised without an API key

**Implementation note:** The local runtime calls GPT-5.6 only with `OPENAI_API_KEY` and validates its structured response. The deterministic fallback was exercised during rehearsals.

- [ ] GPT-5.6 receives only the structured session context needed to infer the proof intent and assertions.
- [ ] Model output is constrained to the established Proof Plan schema and contains no unrestricted executable code.
- [ ] The low-stock session produces a meaningful test name, navigation step, and user-visible warning assertion.
- [ ] Every model response is schema-validated before rendering or execution.
- [ ] Invalid or ambiguous responses fail closed and are never presented as passing proof.
- [ ] The review experience visibly attributes session interpretation to GPT-5.6 and the implementation work to Codex.
- [ ] A deterministic fixture fallback can exercise the rest of the golden path when the model call is unavailable, and the UI clearly identifies fallback use.
