import type { ProofPlan, ProofStep } from "./types";

/** Render a plan without ever evaluating model supplied source code. */
export function renderPlaywrightTest(plan: ProofPlan): string {
  const body = plan.steps.map(renderStep).join("\n");
  return `import { expect, test } from "@playwright/test";

test(${quote(plan.name)}, async ({ page }) => {
  // ${comment(plan.intent)}
${indent(body, 2)}
});
`;
}

function renderStep(step: ProofStep): string {
  switch (step.kind) {
    case "goto":
      return `await page.goto(${quote(step.path)});`;
    case "clickRole":
      return `await page.getByRole(${quote(step.role)}, { name: ${quote(step.name)} }).click();`;
    case "fillRole":
      return `await page.getByRole(${quote(step.role)}, { name: ${quote(step.name)} }).fill(${quote(step.value)});`;
    case "expectText":
      return `await expect(page.getByText(${quote(step.text)}, { exact: true })).toBeVisible();`;
    case "expectRole":
      return `await expect(page.getByRole(${quote(step.role)}, { name: ${quote(step.name)} })).toBeVisible();`;
  }
}

function quote(value: string): string { return JSON.stringify(value); }
function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
function comment(value: string): string { return value.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /"); }
