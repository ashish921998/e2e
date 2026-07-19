# 02 — Same Proof Against an Older Target

**What to build:** Let a reviewer run the identical low-stock proof against an updated local target and a controlled older target, making deployment drift visible through a passing local run and a failed older-target run.

**Blocked by:** 01 — Local Proof Run with Playable Evidence.

**Status:** completed

**Implementation note:** The reliability rehearsal uses the same Playwright source for the updated local and controlled older targets. The older target produces the expected assertion failure, screenshot, video, and trace.

- [ ] The target is selected through configuration rather than changes to the generated test.
- [ ] The updated local target passes the low-stock proof.
- [ ] The controlled older target omits the low-stock warning and fails the same proof deterministically.
- [ ] The test source used for both targets is byte-for-byte identical.
- [ ] The failed run reports `failed`, identifies the failed user-visible assertion, and includes a failure screenshot and playable recording.
- [ ] The review page clearly distinguishes each target and does not confuse an assertion failure with a runner failure.
