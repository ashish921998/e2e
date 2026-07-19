# 01 — Local Proof Run with Playable Evidence

**What to build:** Deliver the smallest complete ProofMode experience: a developer can run one deterministic low-stock proof against the updated local shop and review an independently produced passing verdict with playable evidence.

**Blocked by:** None — can start immediately.

**Status:** completed

**Implementation note:** The local Proof Run produces a generated test, result manifest, video, and trace through the local runtime. A passing run does not intentionally generate a failure screenshot.

- [ ] A deterministic shop exposes a product with stock of three and visibly renders the low-stock warning expected by the proof.
- [ ] One readable Playwright proof runs in a fresh browser context against the named local target.
- [ ] The Proof Run reports `passed` only after the browser assertion succeeds.
- [ ] The run produces a machine-readable result, test source, screenshot, browser recording, and trace.
- [ ] A minimal review page shows the passing verdict, target, test source, screenshot, and playable recording.
- [ ] The complete local Proof Run is covered at the highest practical external seam and can be launched with one documented command.
