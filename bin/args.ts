/**
 * CLI argument parsing for e2e-prove — pure and separately importable so
 * tests/cli-args.spec.ts can cover it without executing the CLI.
 */
export interface ParsedArgs {
  url?: string;
  goal?: string;
  diff?: string;
  out?: string;
  targetId?: string;
  maxSteps?: string;
  model?: string;
  provider?: "openai" | "anthropic";
  noReplay?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (key === "no-replay") {
        out.noReplay = true;
        continue;
      }
      if (next === undefined || next.startsWith("--")) continue;
      switch (key) {
        case "url": out.url = next; break;
        case "goal": out.goal = next; break;
        case "diff": out.diff = next; break;
        case "out": out.out = next; break;
        case "target-id": out.targetId = next; break;
        case "max-steps": out.maxSteps = next; break;
        case "model": out.model = next; break;
        case "provider":
          if (next === "openai" || next === "anthropic") out.provider = next;
          break;
      }
      i++;
    }
  }
  return out;
}

export function usage(): string {
  return [
    "e2e-prove — agentic web proof on E2B",
    "",
    "Usage: e2e-prove --url <baseURL> [options]",
    "",
    "Options:",
    "  --url <url>        Base URL of the app to verify (required).",
    "  --goal <text>      What to verify (default: a generic smoke check).",
    "  --diff <file>      Path to a unified diff / PR description to ground the agent.",
    "  --out <dir>        Output directory (default: ./proof-out).",
    "  --target-id <id>   Target id recorded in the bundle (default: 'preview').",
    "  --max-steps <n>    Agent step cap (default: 25).",
    "  --model <id>       Override the model id.",
    "  --provider <p>     Model provider: openai (default) | anthropic. Also via E2E_PROVE_PROVIDER.",
    "  --no-replay        Skip the deterministic replay (exploration only; exits non-zero — never a pass gate).",
    "  -h, --help         Show this help.",
    "",
    "Environment: E2B_API_KEY (required) + OPENAI_API_KEY (GPT-5.6, default) | ANTHROPIC_API_KEY (Claude).",
    "",
  ].join("\n");
}
