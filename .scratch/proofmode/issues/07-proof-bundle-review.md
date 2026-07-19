# 07 — Complete Proof Bundle Review Experience

**What to build:** Give a reviewer one polished page where the complete evidence for a Proof Run can be understood without checking out or running the application locally.

**Blocked by:** 05 — GPT-5.6 Session Interpretation; 06 — Codex Development Evidence.

**Status:** implemented

**Implementation note:** The reviewer distinguishes verdict types and displays generated test, video, screenshots when present, trace, steps, and terminal evidence. Runtime-generated diff capture remains future work.

- [ ] The page leads with the verdict and named target and makes pass and failure states immediately distinguishable.
- [ ] The generated test, implementation diff, structured steps, browser recording, screenshots, trace, and terminal transcript are accessible from the same review experience.
- [ ] A failed assertion is shown prominently beside its failure screenshot and diagnostic output.
- [ ] Compilation and runner failures are visually distinct from product assertion failures.
- [ ] The Proof Bundle manifest records artifact references, timestamps, duration, target, and outcome without secrets.
- [ ] Every artifact link in the manifest resolves or is explicitly marked unavailable with an explanation.
- [ ] A reviewer can understand the local-pass and older-target-failure story without running the project.
