# 03 — Recorded Browser Session Becomes a Proof Plan

**What to build:** Allow a developer to explicitly record the successful low-stock verification in a real browser and inspect the constrained Proof Plan derived from that structured session.

**Blocked by:** 01 — Local Proof Run with Playable Evidence.

**Status:** implemented — browser-video capture remains replay evidence rather than a recording of the original capture interaction.

**Implementation note:** Start/stop capture persists structured current-path, visible heading/status, and click events in browser local storage. The runtime compiles supported events into a Proof Plan.

- [ ] The developer can explicitly start and stop a recording session.
- [ ] The session captures navigation, accessible user-visible observations, timestamps, and human-readable step labels.
- [ ] The recording excludes unrelated browser activity outside the explicit session boundary.
- [ ] Video is retained as evidence while structured events remain the source for test generation.
- [ ] The recorded low-stock verification produces a constrained Proof Plan containing the intended navigation and warning assertion.
- [ ] The developer can inspect the structured session and proposed Proof Plan before replay.
- [ ] Unsupported recorded actions are reported instead of being silently discarded.
