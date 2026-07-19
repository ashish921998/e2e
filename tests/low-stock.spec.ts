import { expect, test } from "@playwright/test";

test("shows a warning when stock is low", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Vintage Camera" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Only 3 left");
});
