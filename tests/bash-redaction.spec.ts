import { expect, test } from "@playwright/test";
import { executeTool } from "../src/agent/tools";
import type { ProofSandbox } from "../src/agent/sandbox";
import type { RecordedSession } from "../src/proof/types";

// The bash tool persists `$ <command>` into the terminal transcript, which is
// saved as evidence and mirrored to the model. A secret in the command line
// (e.g. a curl Authorization header) must be redacted there too — not just in
// stdout/stderr. This drives the real executor with a stub sandbox.
test("bash executor redacts a credential in the command line, not just output", async () => {
  const stub = {
    async bash() {
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  } as unknown as ProofSandbox;
  const session: RecordedSession = {
    id: "s", title: "t", startedAt: new Date().toISOString(), targetId: "preview", events: [],
  };
  const terminal: string[] = [];
  // No `sk-`/`e2b_` prefix on purpose: this exercises the Authorization
  // key/value redaction path, not the catch-all bare-provider-key rule.
  const secret = "livesecret0123";

  await executeTool(
    { id: "1", name: "bash", input: { command: `curl -H "Authorization: Bearer ${secret}" https://api` } },
    { sandbox: stub, baseUrl: "https://app", session, terminal },
  );

  expect(terminal).toHaveLength(1);
  expect(terminal[0]).not.toContain(secret);
  expect(terminal[0]).toContain("[REDACTED]");
});
