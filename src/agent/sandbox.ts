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

  let chromePid: number | undefined;
  const chromeLog = "/tmp/chrome-cdp.log";

  async function ensureChrome(): Promise<void> {
    if (chromePid) return;
    // Resolve the binary first. The E2B SDK's `commands.run(background:true)`
    // returns a handle immediately WITHOUT throwing if the binary is missing or
    // exits on startup — the failure only surfaces if you `.wait()` the handle,
    // which means a silent 9222 and a bare "CDP HTTP 502" 30s later. So we
    // detect the real path up front (blocking `command -v`, which *does* throw
    // on a missing binary) and then launch it in the background.
    const candidates = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ];
    let bin: string | undefined;
    let detectError = "";
    for (const candidate of candidates) {
      try {
        // `command -v` exits non-zero when the binary is absent; commands.run
        // (blocking) throws CommandExitError on that, so this is the real gate.
        const result = await sandbox.commands.run(`command -v ${candidate}`, { timeoutMs: 5_000 });
        if (result.exitCode === 0) {
          bin = (result.stdout || candidate).trim().split("\n")[0]!.trim() || candidate;
          break;
        }
        detectError = `${candidate}: exit ${result.exitCode}`;
      } catch (error) {
        detectError = `${candidate}: ${safeMessage(error)}`;
      }
    }
    if (!bin) {
      throw new Error(
        `No Chrome/Chromium binary found in the E2B sandbox (tried ${candidates.join(", ")}; last: ${detectError}). ` +
          `Use a template that ships Chrome (e.g. the default "desktop") or set E2B_TEMPLATE.`,
      );
    }

    // Launch headless Chrome with a remote debugging port bound to all
    // interfaces so the host-forwarded port is reachable via getHost. We write
    // stdout/stderr to a log file so a CDP timeout can report the real reason
    // instead of a bare HTTP status.
    // `about:blank` is a positional URL (not the invalid `--about:blank` flag)
    // and gives the CDP browser an initial target for Playwright to attach to.
    const args = [
      `--headless=new`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationGuide,MediaRouter",
      "--user-data-dir=/tmp/chrome-cdp-profile",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=0.0.0.0",
      "about:blank",
    ];
    // Detach at the shell/process level. An E2B background CommandHandle is tied
    // to its command session and Chrome was being reaped shortly after startup
    // in CI, despite briefly logging "DevTools listening".
    const launch = `nohup setsid ${bin} ${args.join(" ")} </dev/null >${chromeLog} 2>&1 & echo $!`;
    try {
      const result = await sandbox.commands.run(launch, { timeoutMs: 10_000 });
      chromePid = Number.parseInt(result.stdout.trim(), 10);
      if (!Number.isInteger(chromePid)) throw new Error(`invalid Chrome PID: ${result.stdout.trim()}`);
    } catch (error) {
      throw new Error(`Failed to start Chrome (${bin}) in the sandbox: ${safeMessage(error)}`);
    }

  }

  /**
   * If Chrome's CDP endpoint isn't up, dump the diagnostics we can gather from
   * the sandbox (is the process alive? is the port listening? what did Chrome
   * print?) so the thrown error points at the real cause instead of "HTTP 502".
   */
  async function diagnoseCdpFailure(url: string, lastError: string): Promise<string> {
    const parts = [`Chrome CDP did not become ready at ${url}: ${lastError}`];
    try {
      // Dump: is Chrome alive, is the port up, and the FULL chrome log minus the
      // known-noisy dbus/GCM lines that bury the real fatal message.
      const ps = await sandbox.commands.run(
        `echo "[ps chrome]"; ps aux | grep -iE 'chrome|chromium' | grep -v grep || echo "(no chrome process)"; ` +
          `echo "[port 9222]"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 9222 || echo "(nothing listening on 9222)"; ` +
          `echo "[chrome.log (dbus/gcm noise filtered)]"; ` +
          `grep -vE 'dbus|object_proxy|gcm|DEPRECATED_ENDPOINT' ${chromeLog} 2>/dev/null | tail -n 80 || echo "(no chrome log)"`,
        { timeoutMs: 10_000 },
      );
      parts.push(`\n--- sandbox diagnostics ---\n${(ps.stdout || "")+(ps.stderr || "")}`.trimEnd());
    } catch (error) {
      parts.push(`(diagnostics unavailable: ${safeMessage(error)})`);
    }
    return parts.join("\n");
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
    throw new Error(await diagnoseCdpFailure(url, lastError));
  }

  let cached: { browser: Browser; context: BrowserContext } | undefined;

  return {
    sandbox,
    async connectPage() {
      if (!cached) {
        await ensureChrome();
        const host = sandbox.getHost(debugPort);
        // E2B forwards sandbox ports over TLS in production (getHost returns a
        // bare host like "<port>-<id>.e2b.dev", served at https://). Chrome's
        // CDP /json/version endpoint and the WebSocket upgrade are reachable
        // over that https URL. Override with E2B_CDP_SCHEME=http only for a
        // local/debug sandbox (E2B_DEBUG), where ports are plain http.
        const scheme = process.env.E2B_CDP_SCHEME ?? (process.env.E2B_DEBUG ? "http" : "https");
        const cdpUrl = `${scheme}://${host}`;
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
        if (chromePid) await sandbox.commands.run(`kill ${chromePid} 2>/dev/null || true`);
      } catch {
        // Chrome may already be gone with the sandbox.
      }
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
