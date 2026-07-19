#!/usr/bin/env node

/** Export a passing, independently replayed proof without overwriting prior exports. */
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [runId, destinationName] = process.argv.slice(2);
if (!runId) {
  console.error("Usage: node scripts/export-proof.mjs <proof-run-id> [test-name]");
  process.exit(1);
}

const root = process.cwd();
const runDir = join(root, "proof-runs", basename(runId));
const summaryPath = join(runDir, "summary.json");
const source = join(runDir, "local", "generated-test.spec.ts");
const exportDir = join(root, "proof-exports");
const outputName = destinationName ?? `proof-${basename(runId)}.spec.ts`;
const destination = join(exportDir, basename(outputName));

try {
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  if (summary?.passed !== true || summary?.checks?.localPassed !== true) {
    throw new Error("Only a fully passing reliability run can be exported.");
  }
  await access(source);
  let destinationExists = true;
  try {
    await access(destination);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      destinationExists = false;
    } else {
      throw error;
    }
  }
  if (destinationExists) throw new Error(`Refusing to overwrite existing export: ${destination}`);
  await mkdir(exportDir, { recursive: true });
  await copyFile(source, destination);
  await writeFile(`${destination}.proof.json`, `${JSON.stringify({
    sourceRun: runId,
    sourceArtifact: "local/generated-test.spec.ts",
    exportedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`Exported ${destination}`);
} catch (error) {
  console.error(`Unable to export proof: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
