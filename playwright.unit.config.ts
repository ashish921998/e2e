import { defineConfig } from "@playwright/test";

// Pure-logic specs only — no dev server, no browser, no demo app. This is what
// `npm run test:unit` (and CI) runs, so it works on a bare checkout anywhere.
export default defineConfig({
  testDir: "./tests",
  // The one spec that needs a live target; everything else in tests/ is pure.
  // Denylist (not allowlist) on purpose: a new live spec fails CI loudly here,
  // whereas an allowlist would silently drop a forgotten pure spec. Leading
  // **/ so the glob matches the absolute test path.
  testIgnore: "**/low-stock.spec.ts",
  // Mirror the e2e config: a committed `test.only` fails CI instead of silently
  // running one spec and skipping the rest.
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
