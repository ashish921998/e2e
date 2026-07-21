/**
 * E2B execution layer — the "give the agent a computer" piece.
 *
 * One thin module so the rest of the agent is E2B-agnostic. It boots an E2B
 * Desktop sandbox (an isolated cloud Linux VM with Chrome + a terminal), launches
 * headless Chrome with a remote-debugging port, and exposes:
 *   - the CDP URL for Playwright to attach structured (role/name) tools to,
 *   - `bash()` backed by the sandbox terminal,
 *   - `screenshot()` for vision, and
 *   - a place to stash per-step screenshots that become the agent video.
 *
 * Why Desktop + our own Chrome, not a "browser" template: the installed SDKs
 * are `e2b` + `@e2b/desktop`. The Desktop template (default "desktop") is a
 * full Ubuntu VM; we launch Chrome there with --remote-debugging-port and read
 * the forwarded host via `sandbox.getHost(port)`. That CDP URL is what
 * Playwright connects over, so `getByRole(...)` works — which is what maps 1:1
 * to a ProofStep and keeps the proof deterministic.
 *
 * NOTE on recording: `@e2b/desktop` exposes a live VNC *stream*
 * (`sandbox.stream.start()/getUrl()`) and `screenshot()`, but has no
 * "save recording to file". So the agent-exploration video is assembled from
 * per-step screenshots (see agent/video.ts); the deterministic *replay* video
 * still comes from the engine's Playwright `video:"on"` run, untouched.
 */
/**
 * NOTE: playwright-core and @e2b/desktop are imported lazily inside
 * startSandbox(), not at module top level. They are heavy and (under some
 * tsx/esbuild configs) their static import can stall the loader; deferring them
 * keeps `--help`, arg parsing, and any non-sandbox path instant and robust.
 */
type Browser = import("playwright-core").Browser;
type BrowserContext = import("playwright-core").BrowserContext;
type Page = import("playwright-core").Page;
type Sandbox = InstanceType<typeof import("@e2b/desktop").Sandbox>;

export interface SandboxOptions {
  /** E2B template. Defaults to the Desktop template ("desktop"). */
  template?: string;
  /** Sandbox timeout in ms. The agent loop can be long; default 15 min. */
  timeoutMs?: number;
  /** Port Chrome listens on inside the sandbox. */
  debugPort?: number;
  /** Extra env for the sandbox process. */
  env?: Record<string, string>;
}

export interface ProofSandbox {
  sandbox: Sandbox;
  /** Connect Playwright over CDP and return a fresh page navigated to baseURL. */
  connectPage(): Promise<{ browser: Browser; context: BrowserContext; page: Page }>;
  /** Run a shell command in the sandbox terminal. */
  bash(command: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Capture a PNG screenshot of the current page (or the desktop if no page). */
  screenshot(): Promise<Buffer>;
  /** Forwarded host for a sandbox port (used to build the CDP URL). */
  getHost(port: number): string;
  /** The live VNC stream URL (for embedding a live view / debugging). */
  streamUrl(): string;
  /** Tear the sandbox down. */
  close(): Promise<void>;
}

const DEFAULT_TEMPLATE = "desktop";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const CHROME_DEBUG_PORT = 9_222;

export async function startSandbox(options: SandboxOptions = {}): Promise<ProofSandbox> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is required to start a sandbox.");

  const template = options.template ?? process.env.E2B_TEMPLATE ?? DEFAULT_TEMPLATE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const debugPort = options.debugPort ?? CHROME_DEBUG_PORT;

  // Lazy-load the heavy SDKs so importing this module (and the CLI's --help)
  // never pays for them or risks a loader stall.
  const [{ Sandbox: DesktopSandbox }, { chromium }] = await Promise.all([
    import("@e2b/desktop"),
    import("playwright-core"),
  ]);

  const sandbox = (await DesktopSandbox.create(template, {
    apiKey,
    timeoutMs,
    ...(options.env ? { envs: options.env } : {}),
  } as Record<string, unknown>)) as Sandbox;

  // Keep the VM alive for the whole agent loop regardless of idle time.
  try {
    await sandbox.setTimeout(timeoutMs);
  } catch {
    // setTimeout is optional on some SDK versions; the create timeout still applies.
  }

  // Start the live VNC stream so a live view is available for debugging. This
  // does not produce a file — see module note on recording.
  try {
    await sandbox.stream.start();
  } catch {
    // The stream is a debugging convenience; its absence is non-fatal.
  }

  let chromeLaunched = false;

  async function ensureChrome(): Promise<void> {
    if (chromeLaunched) return;
    // Launch headless Chrome with a remote debugging port bound to all
    // interfaces so the host-forwarded port is reachable via getHost. We try
    // the common binary names; the Desktop template ships Google Chrome.
    const candidates = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ];
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=0.0.0.0",
      "--about:blank",
    ];
    let lastError: unknown;
    for (const bin of candidates) {
      try {
        // Run in the background: Chrome stays up for the session.
        await sandbox.commands.run(`${bin} ${args.join(" ")}`, {
          background: true,
          timeoutMs: 10_000,
        } as Record<string, unknown>);
        chromeLaunched = true;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Could not launch Chrome in the sandbox (tried ${candidates.join(", ")}). ` +
        `Install Chrome in your E2B template or set E2B_TEMPLATE to one that has it. ` +
        safeMessage(lastError),
    );
  }

  async function waitForCdp(url: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "not attempted";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${url}/json/version`);
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Chrome CDP did not become ready at ${url}: ${lastError}`);
  }

  let cached: { browser: Browser; context: BrowserContext } | undefined;

  return {
    sandbox,
    async connectPage() {
      if (!cached) {
        await ensureChrome();
        const host = sandbox.getHost(debugPort);
        const cdpUrl = `http://${host}`;
        await waitForCdp(cdpUrl);
        const browser = await chromium.connectOverCDP(cdpUrl);
        // connectOverCDP yields an already-connected browser; use its default
        // context so we share the open tab rather than spawning a second one.
        const context = browser.contexts()[0] ?? (await browser.newContext());
        cached = { browser, context };
      }
      const page = cached.context.pages()[0] ?? (await cached.context.newPage());
      return { browser: cached.browser, context: cached.context, page };
    },
    async bash(command, opts) {
      try {
        const result = await sandbox.commands.run(command, {
          timeoutMs: opts?.timeoutMs ?? 60_000,
        } as Record<string, unknown>);
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // commands.run throws CommandExitError on non-zero exit; surface its fields.
        if (isCommandResult(error)) {
          return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        }
        throw error;
      }
    },
    async screenshot() {
      // Prefer a page-level screenshot when a page is connected (DOM-faithful);
      // fall back to the desktop screenshot (whole screen) otherwise.
      if (cached?.context.pages().length) {
        try {
          return await cached.context.pages()[0]!.screenshot({ type: "png" });
        } catch {
          // fall through to desktop screenshot
        }
      }
      const bytes = await sandbox.screenshot();
      return Buffer.from(bytes);
    },
    getHost: (port) => sandbox.getHost(port),
    streamUrl: () => sandbox.stream.getUrl(),
    async close() {
      try {
        await cached?.browser.close();
      } catch {
        // Browser may already be gone with the sandbox.
      }
      try {
        await sandbox.kill();
      } catch {
        // Best-effort teardown.
      }
    },
  };
}

function isCommandResult(value: unknown): value is { exitCode: number; stdout: string; stderr: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { exitCode?: unknown }).exitCode === "number" &&
    typeof (value as { stdout?: unknown }).stdout === "string"
  );
}

function safeMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
