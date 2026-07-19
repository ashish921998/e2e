# 06 — Codex Development Evidence

**What to build:** Show Codex implementing and verifying the low-stock warning with real developer tools, then preserve the relevant terminal activity and implementation diff inside the resulting Proof Bundle.

**Blocked by:** 04 — Deterministic Proof-Plan Compiler.

**Status:** partially implemented

**Implementation note:** The reviewer can display terminal text and a demo implementation diff, and persisted terminal text is redacted. Direct Codex/computer-use hooks and automatic terminal capture are not implemented.

- [ ] Codex can inspect and modify the demo shop using a real terminal workflow.
- [ ] Codex can verify the implemented warning through the real browser recording surface.
- [ ] Relevant terminal activity is captured as a timestamped, reviewable transcript.
- [ ] The implementation diff is captured and associated with the Proof Run.
- [ ] Synthetic secrets and sensitive environment values are redacted or excluded from all persisted artifacts.
- [ ] The Proof Bundle connects the Codex development evidence to the independently replayed test without treating the agent's narrative as the verdict.
- [ ] Automated checks verify that synthetic credentials do not appear in persisted evidence.
