#!/usr/bin/env node
import process from "node:process";
import { riftsCreate } from "./create.js";
import { riftsRun } from "./run.js";
import { riftsList } from "./list.js";
import { readPorts } from "./ports.js";
import { runProxyServer } from "./proxy.js";

function usage(): never {
  process.stdout.write(`rifts — deterministic per-rift port assignment

Usage:
  rifts create [args…]    wrap \`rift create\`, assign + record a port
  rifts run <cmd> [args…] run a command inside the current rift with its port injected
  rifts list              list rifts with ports and preview URLs
  rifts proxy             start the local reverse proxy on :8080
  rifts help              print this message
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();

    case "create": {
      // Every arg after `create` is forwarded verbatim to `rift create`.
      const result = await riftsCreate({ riftArgs: rest });
      console.log(`${result.path} → port ${result.port}`);
      return;
    }

    case "run": {
      // Everything after `run` is the command — no flag parsing, so tokens
      // like `-e` or `--port` reach the child untouched.
      if (rest.length === 0) {
        process.stderr.write("rifts: `run` requires a command\n");
        process.exit(2);
      }
      const code = await riftsRun({ command: rest });
      process.exit(code);
    }

    case "list": {
      const code = await riftsList();
      process.exit(code);
    }

    case "proxy": {
      const ports = await readPorts();
      await runProxyServer(ports);
      return;
    }

    case "--version":
    case "-V":
      console.log("rifts 0.1.0");
      process.exit(0);

    default:
      process.stderr.write(`rifts: unknown command "${subcommand}"\n`);
      process.stderr.write(`Run \`rifts help\` for usage.\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`rifts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
