import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const REPO = "https://github.com/PinetheApple/stemdeck";

test("the About box names the AGPL and links to the source code", async ({ page }) => {
  await openStudio(page);
  await page.locator("#aboutBtn").click();
  const line = page.locator("#aboutDialog .about-license");
  await expect(line).toBeVisible();
  await expect(line).toContainText("GNU AGPL-3.0");
  const link = line.getByRole("link", { name: "Source code" });
  await expect(link).toHaveAttribute("href", REPO);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("the license line follows the interface language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stemdeck.language", JSON.stringify("de")));
  await openStudio(page);
  await page.locator("#aboutBtn").click();
  const line = page.locator("#aboutDialog .about-license");
  await expect(line).toContainText("freie Software");
  await expect(line.getByRole("link", { name: "Quellcode" })).toHaveAttribute("href", REPO);
});
