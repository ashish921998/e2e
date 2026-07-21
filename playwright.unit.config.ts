import { defineConfig } from "@playwright/test";

// Pure-logic specs only — no dev server, no browser, no demo app. This is what
// `npm run test:unit` (and CI) runs, so it works on a bare checkout anywhere.
export default defineConfig({
  testDir: "./tests",
  // The one spec that needs a live target; everything else in tests/ is pure.
  testIgnore: "low-stock.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
