import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(join(tmpdir(), "e2e-prove-package-"));

try {
  const pack = run("npm", ["pack", "--json", "--pack-destination", tempDir], root);
  const [manifest] = parseTrailingJsonArray(pack.stdout);
  if (!manifest?.filename || !Array.isArray(manifest.files)) {
    throw new Error("npm pack did not return a package manifest");
  }

  const paths = new Set(manifest.files.map((file) => file.path));
  for (const required of ["bin/e2e-prove.mjs", "bin/e2e-prove.ts", "src/proof/execute.ts", "action.yml"]) {
    if (!paths.has(required)) throw new Error(`packed artifact is missing ${required}`);
  }
  for (const excluded of ["src/proof/runtime.ts", "src/proof/demo-bundle.ts"]) {
    if (paths.has(excluded)) throw new Error(`packed artifact unexpectedly contains ${excluded}`);
  }

  const consumerDir = join(tempDir, "consumer");
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    '{"name":"consumer","private":true,"scripts":{"smoke":"e2e-prove --help"}}\n',
    "utf8",
  );
  run("npm", ["install", "--ignore-scripts", "--omit=dev", join(tempDir, manifest.filename)], consumerDir);
  const help = run("npm", ["run", "smoke"], consumerDir);
  if (!help.stdout.includes("--no-replay")) throw new Error("packed CLI help did not load");

  process.stdout.write(`package smoke passed (${manifest.files.length} files)\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function parseTrailingJsonArray(output) {
  let index = output.lastIndexOf("[");
  while (index >= 0) {
    try {
      const parsed = JSON.parse(output.slice(index));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Lifecycle output may precede npm's final JSON payload.
    }
    index = index === 0 ? -1 : output.lastIndexOf("[", index - 1);
  }
  throw new Error(`npm pack did not emit valid JSON:\n${output}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return result;
}
