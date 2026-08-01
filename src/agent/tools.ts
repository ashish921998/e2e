/**
 * The constrained tool set the agent is allowed to call, and its execution
 * against the Playwright page connected in the E2B sandbox.
 *
 * Each tool maps 1:1 to a ProofStep (goto / clickRole / fillRole / expectRole /
 * expectText) plus a terminal `bash` tool for the "real dev tools" story and a
 * `finish` tool to end the loop. Executing a tool ALSO appends a
 * RecordedBrowserEvent to the session, so the session the agent produces
 * renders straight into a replayable Playwright test via
 * deterministicPlanFromSession — the proof stays deterministic and auditable,
 * never "the agent said so."
 */
import type {
  BrowserObservationEvent,
  RecordedBrowserEvent,
  RecordedSession,
} from "../proof/types";
import { redact } from "../proof/redact";
import type { ProofSandbox } from "./sandbox";

// Inline type import keeps playwright-core out of the runtime import graph;
// a top-level `import type { Page }` can still trip tsx's loader.
type Page = import("playwright-core").Page;
type AriaRole = Parameters<Page["getByRole"]>[0];

// The model supplies `role` as a free string. Validate it against Playwright's
// accessible roles at the trust boundary instead of casting the check away with
// `as never`: an unknown role becomes a clear tool error the agent can correct,
// not a raw Playwright throw.
const ARIA_ROLES = new Set<string>([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button",
  "caption", "cell", "checkbox", "code", "columnheader", "combobox", "complementary",
  "contentinfo", "definition", "deletion", "dialog", "document", "emphasis", "feed",
  "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img",
  "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar",
  "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar",
  "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong",
  "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term",
  "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

function toAriaRole(value: string): AriaRole | undefined {
  return ARIA_ROLES.has(value) ? (value as AriaRole) : undefined;
}

/** JSON-schema-ish tool descriptors handed to the model clients. */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** A plain-object schema; model clients translate to their native format. */
  input_schema: Record<string, unknown>;
}

export type ToolName =
  | "goto"
  | "click"
  | "fill"
  | "observe_role"
  | "observe_text"
  | "bash"
  | "finish";

/** A call the model made. */
export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

/** What executing a tool produced, fed back to the model as a tool_result. */
export interface ToolResult {
  ok: boolean;
  /** Short human/LLM-readable summary (may include a snippet of page text). */
  summary: string;
  /** Optional error text when ok is false. */
  error?: string;
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "goto",
    description:
      "Navigate the browser to a path on the target site. Use a relative path starting with '/', e.g. '/products'. This is always the first action.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, starting with '/'." } },
      required: ["path"],
    },
  },
  {
    name: "click",
    description:
      "Click an element by its accessible role and accessible name, e.g. role 'button', name 'Add to cart'. This is robust to CSS/class changes.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: "ARIA/accessible role, e.g. 'button', 'link', 'textbox'." },
        name: { type: "string", description: "Accessible name (visible text / aria-label)." },
      },
      required: ["role", "name"],
    },
  },
  {
    name: "fill",
    description: "Type text into a form field identified by accessible role and name.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        name: { type: "string" },
        value: { type: "string", description: "The text to enter." },
      },
      required: ["role", "name", "value"],
    },
  },
  {
    name: "observe_role",
    description:
      "Assert a user-visible element with the given role and accessible name is present and visible. Use this to verify a feature rendered.",
    input_schema: {
      type: "object",
      properties: { role: { type: "string" }, name: { type: "string" } },
      required: ["role", "name"],
    },
  },
  {
    name: "observe_text",
    description:
      "Assert that specific user-visible text is present on the page. Use the exact text, e.g. 'Only 3 left'. Prefer observe_role when an element has a role/name.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the sandbox terminal (curl an endpoint, inspect a log, etc.). Output is evidence only and is NOT a proof assertion.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "finish",
    description:
      "Call this when you have verified the goal (or determined it cannot be verified). Summarize the outcome.",
    input_schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        reason: { type: "string" },
      },
      required: ["verdict", "reason"],
    },
  },
];

export interface ToolExecutorOptions {
  sandbox: ProofSandbox;
  /** Base URL to resolve relative goto paths against. */
  baseUrl: string;
  /** The session under construction; events are appended in place. */
  session: RecordedSession;
  /** Append-only bash transcript lines. */
  terminal: string[];
  /** Per-step screenshot collector (filename -> buffer), for the agent video. */
  onScreenshot?: (label: string, png: Buffer) => void;
}

export interface ExecutedTool {
  result: ToolResult;
  /** The page snapshot text returned to the model (helps it reason next). */
  observation?: string;
}

/**
 * Execute one tool call against the sandbox. Returns the result to feed back to
 * the model and, for browser tools, a compact observation of the page so the
 * model can decide its next move. Recording happens as a side effect: browser
 * tools append a RecordedBrowserEvent to the session; bash appends a redacted
 * line to the terminal transcript.
 */
export async function executeTool(call: ToolCall, opts: ToolExecutorOptions): Promise<ExecutedTool> {
  const { sandbox, baseUrl, session, terminal } = opts;
  const at = new Date().toISOString();
  switch (call.name) {
    case "goto": {
      const path = asString(call.input.path);
      if (!path || !path.startsWith("/") || path.startsWith("//")) {
        return { result: { ok: false, summary: "path must be a relative URL starting with '/'", error: "invalid path" } };
      }
      const { page } = await sandbox.connectPage();
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      const event: RecordedBrowserEvent = { type: "navigate", at, path, label: `goto ${path}` };
      session.events.push(event);
      await capture(opts, `goto-${path}`);
      return { result: { ok: true, summary: `navigated to ${path}` }, observation: await observe(page) };
    }
    case "click": {
      const role = asString(call.input.role);
      const name = asString(call.input.name);
      if (!role || !name) return { result: { ok: false, summary: "click needs role and name", error: "missing args" } };
      const clickRole = toAriaRole(role);
      if (!clickRole) return { result: { ok: false, summary: `unknown role '${role}'`, error: "bad role" } };
      const { page } = await sandbox.connectPage();
      await page.getByRole(clickRole, { name, exact: false }).click({ timeout: 10_000 });
      const event: RecordedBrowserEvent = { type: "click", at, role, accessibleName: name, label: `click ${role} "${name}"` };
      session.events.push(event);
      await capture(opts, `click-${role}-${name}`);
      return { result: { ok: true, summary: `clicked ${role} "${name}"` }, observation: await observe(page) };
    }
    case "fill": {
      const role = asString(call.input.role);
      const name = asString(call.input.name);
      const value = asString(call.input.value) ?? "";
      if (!role || !name) return { result: { ok: false, summary: "fill needs role, name and value", error: "missing args" } };
      const fillRole = toAriaRole(role);
      if (!fillRole) return { result: { ok: false, summary: `unknown role '${role}'`, error: "bad role" } };
      const { page } = await sandbox.connectPage();
      await page.getByRole(fillRole, { name, exact: false }).fill(value, { timeout: 10_000 });
      const event: RecordedBrowserEvent = { type: "fill", at, role, accessibleName: name, value, label: `fill ${role} "${name}"` };
      session.events.push(event);
      await capture(opts, `fill-${role}-${name}`);
      return { result: { ok: true, summary: `filled ${role} "${name}"` }, observation: await observe(page) };
    }
    case "observe_role": {
      const role = asString(call.input.role);
      const name = asString(call.input.name);
      if (!role || !name) return { result: { ok: false, summary: "observe_role needs role and name", error: "missing args" } };
      const observeRole = toAriaRole(role);
      if (!observeRole) return { result: { ok: false, summary: `unknown role '${role}'`, error: "bad role" } };
      const { page } = await sandbox.connectPage();
      const locator = page.getByRole(observeRole, { name, exact: false });
      try {
        await locator.waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        return { result: { ok: false, summary: `${role} "${name}" not visible`, error: "not visible" }, observation: await observe(page) };
      }
      // role + accessibleName routes this to expectRole in the interpreter; text
      // mirrors the name only so the event's `text` field is non-empty.
      const event: BrowserObservationEvent = { type: "observe", at, role, accessibleName: name, text: name, label: `expect ${role} "${name}"` };
      session.events.push(event);
      await capture(opts, `observe-${role}-${name}`);
      return { result: { ok: true, summary: `${role} "${name}" is visible` }, observation: await observe(page) };
    }
    case "observe_text": {
      const text = asString(call.input.text);
      if (!text) return { result: { ok: false, summary: "observe_text needs text", error: "missing args" } };
      const { page } = await sandbox.connectPage();
      const locator = page.getByText(text, { exact: true });
      try {
        await locator.waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        return { result: { ok: false, summary: `text "${text}" not visible`, error: "not visible" }, observation: await observe(page) };
      }
      // No accessibleName → the interpreter routes this to expectText. Do not set
      // a role: it would falsely imply a role assertion the step never makes.
      const event: BrowserObservationEvent = { type: "observe", at, text, label: `expect text "${text}"` };
      session.events.push(event);
      await capture(opts, `observe-text`);
      return { result: { ok: true, summary: `text "${text}" is visible` }, observation: await observe(page) };
    }
    case "bash": {
      const command = asString(call.input.command);
      if (!command) return { result: { ok: false, summary: "bash needs command", error: "missing args" } };
      const { exitCode, stdout, stderr } = await sandbox.bash(command);
      // Bash output is evidence only, never an assertion. Redact common
      // credential shapes BEFORE it goes anywhere — both the persisted
      // transcript AND the summary fed back to the model. A leaked
      // `Authorization: bearer …` from a curl must never reach the provider.
      const safeStdout = redact(stdout);
      const safeStderr = redact(stderr);
      const line = `$ ${command}\n${safeStdout}${safeStderr ? `\n${safeStderr}` : ""}`;
      terminal.push(line);
      const summary = `exit ${exitCode}, ${truncateForSummary(safeStdout)}${safeStderr ? ` / ${truncateForSummary(safeStderr)}` : ""}`;
      return { result: { ok: exitCode === 0, summary, ...(exitCode === 0 ? {} : { error: `non-zero exit ${exitCode}` }) } };
    }
    // Note: `finish` is intercepted by the loop before executeTool is called, so
    // it has no case here — routing it through the executor would break the
    // loop's early return.
    default:
      return { result: { ok: false, summary: `unknown tool ${call.name}`, error: "unknown tool" } };
  }
}

/** A compact, accessibility-tree-flavoured observation the model can reason over. */
async function observe(page: Page): Promise<string> {
  try {
    const title = await page.title().catch(() => "");
    const url = page.url();
    // Visible text body, trimmed to keep the prompt small.
    const body = await page.evaluate(() => {
      const sel = "h1, h2, h3, [role=status], [role=alert], button, a, label, p, li";
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 40);
      return nodes.map((el) => {
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        const text = (el.textContent ?? "").trim().slice(0, 120);
        return `${role}: ${text}`;
      }).join("\n");
    }).catch(() => "");
    return `URL: ${url}\nTitle: ${title}\n${body}`.slice(0, 2_000);
  } catch {
    return "";
  }
}

async function capture(opts: ToolExecutorOptions, label: string): Promise<void> {
  if (!opts.onScreenshot) return;
  try {
    opts.onScreenshot(label, await opts.sandbox.screenshot());
  } catch {
    // Screenshots are best-effort evidence; never fail a tool on capture.
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateForSummary(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}
