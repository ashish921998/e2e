# 08 — Export the Passing Test to the Repository

**What to build:** Let a maintainer preserve independently verified behavior by exporting a passing generated test into the application's test suite.

**Blocked by:** 07 — Complete Proof Bundle Review Experience.

**Status:** implemented — command-line export

**Implementation note:** `npm run proof:export -- <proof-run-id>` exports only a fully passing rehearsal and refuses to overwrite an existing export. A reviewer-page export button is not implemented.

- [ ] A passing Proof Bundle offers an explicit export action for its generated Playwright test.
- [ ] The exported test is readable, stable, and runnable through the application's documented test command.
- [ ] Export does not change the behavior or source of the test that produced the passing verdict.
- [ ] Failed, incomplete, compile-error, and runner-error Proof Runs cannot be exported as approved tests.
- [ ] Existing repository tests and unrelated files are preserved.
- [ ] The review page confirms the export destination and resulting status without requiring automatic GitHub interaction.
