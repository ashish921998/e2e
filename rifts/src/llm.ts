import process from "node:process";
import type { PortsFile, PortMechanism, ProjectCache } from "./ports.js";

/**
 * Packages known to ignore the PORT env var and need an LLM-resolved mechanism.
 * The only place that needs editing to add more frameworks.
 */
export const IGNORES_PORT_PACKAGES = ["vite", "@docusaurus/core"] as const;

/** Minimal package.json shape we care about for port decisions. */
export interface PackageJsonLike {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** True if the project's deps include a package known to ignore PORT. */
export function projectIgnoresPort(pkg: PackageJsonLike): boolean {
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  return IGNORES_PORT_PACKAGES.some((dep) => dep in allDeps);
}

/** Cache key: name@version, or null if either is missing. */
export function projectSignature(pkg: PackageJsonLike): string | null {
  if (!pkg.name || !pkg.version) return null;
  return `${pkg.name}@${pkg.version}`;
}

export type PortMechanismResult = {
  portMechanism: PortMechanism;
  envVar: string | null;
  flagTemplate: string | null;
  confidence: number;
};

const UNKNOWN_RESULT: PortMechanismResult = {
  portMechanism: "unknown",
  envVar: null,
  flagTemplate: null,
  confidence: 0,
};

/**
 * Parse GPT-5.6's JSON response. Any parse failure or schema mismatch → unknown.
 */
export function parseLlmResponse(raw: string): PortMechanismResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...UNKNOWN_RESULT };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...UNKNOWN_RESULT };
  const obj = parsed as Record<string, unknown>;
  const mechanism = obj.portMechanism;
  if (
    mechanism !== "env" &&
    mechanism !== "flag" &&
    mechanism !== "config" &&
    mechanism !== "unknown"
  ) {
    return { ...UNKNOWN_RESULT };
  }
  return {
    portMechanism: mechanism,
    envVar: typeof obj.envVar === "string" ? obj.envVar : null,
    flagTemplate:
      typeof obj.flagTemplate === "string" ? obj.flagTemplate : null,
    confidence:
      typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
        ? obj.confidence
        : 0,
  };
}

/** Render a parsed mechanism into env + extra command args for a given port. */
export function renderPortMechanism(
  result: PortMechanismResult,
  port: number,
): { env: Record<string, string>; args: string[] } {
  if (result.portMechanism === "env" && result.envVar) {
    return { env: { [result.envVar]: String(port) }, args: [] };
  }
  if (result.portMechanism === "flag" && result.flagTemplate) {
    const rendered = result.flagTemplate.replaceAll("{port}", String(port));
    return { env: {}, args: rendered.split(/\s+/).filter(Boolean) };
  }
  // config / unknown: caller falls back to the PORT fast path.
  return { env: {}, args: [] };
}

/**
 * The exact prompt sent to GPT-5.6. Exported for testing/auditing.
 */
export function buildPrompt(pkg: PackageJsonLike, command: string): string {
  const truncated = {
    name: pkg.name,
    scripts: (pkg as { scripts?: Record<string, string> }).scripts,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
  };
  return `You determine how a dev server receives a port override. Respond as JSON only.

Project package.json:
${JSON.stringify(truncated, null, 2)}

Dev command the user is about to run: ${command}

Return JSON with exactly these fields:
{
  "portMechanism": "env" | "flag" | "config" | "unknown",
  "envVar": string | null,            // the env var name if mechanism is "env"
  "flagTemplate": string | null,      // e.g. "--port {port}" if mechanism is "flag"
  "confidence": number                // 0.0 to 1.0
}`;
}

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

let warnedNoKey = false;

/**
 * Call GPT-5.6 via the OpenAI Chat Completions API using built-in fetch.
 * On any error or unavailability, returns an "unknown" result (caller falls
 * back to the PORT fast path and warns). GPT-5.6 is called at most once per
 * project signature thanks to the ports.json project cache.
 */
export async function detectPortMechanism(
  pkg: PackageJsonLike,
  command: string,
  opts: { apiKey?: string; model?: string; fetchImpl?: FetchLike } = {},
): Promise<PortMechanismResult> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (!warnedNoKey) {
      console.error(
        "rifts: OPENAI_API_KEY unset — skipping GPT-5.6, using PORT fast path.",
      );
      warnedNoKey = true;
    }
    return { ...UNKNOWN_RESULT };
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const model = opts.model ?? "gpt-5.6";
  try {
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(pkg, command) }],
      }),
    });
    if (!res.ok) {
      console.error(
        `rifts: GPT-5.6 request failed (HTTP ${res.status}) — falling back to PORT.`,
      );
      return { ...UNKNOWN_RESULT };
    }
    const data = JSON.parse(await res.text()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return parseLlmResponse(content);
  } catch (err) {
    console.error(
      `rifts: GPT-5.6 call error (${(err as Error).message}) — falling back to PORT.`,
    );
    return { ...UNKNOWN_RESULT };
  }
}

/** Read a cached project mechanism from ports.json, if present. */
export function getCachedProject(
  ports: PortsFile,
  signature: string,
): ProjectCache | undefined {
  return ports.projects[signature];
}

/** Write a project mechanism into ports.json cache. */
export function setCachedProject(
  ports: PortsFile,
  signature: string,
  result: PortMechanismResult,
): PortsFile {
  return {
    ...ports,
    projects: {
      ...ports.projects,
      [signature]: {
        portMechanism: result.portMechanism,
        envVar: result.envVar,
        flagTemplate: result.flagTemplate,
        confidence: result.confidence,
      },
    },
  };
}
