import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const INSIDE_PATH = "/library/StemData/cookies.txt";
const OUTSIDE_PATH = "/home/user/cookies.txt";
const INSIDE_MESSAGE = "This file is inside the StemData folder. Pick a cookies file outside it.";
const REFUSAL = {
  detail: "The cookies file must be outside the library folder.",
  code: "cookies_in_library",
};

async function openSettings(page) {
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".set-cookies-file")).toBeVisible();
}

async function enterCookiesPath(page, path) {
  const input = page.locator(".set-cookies-file");
  await input.fill(path);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "POST"),
    input.blur(),
  ]);
}

async function serverSettings(route, overrides) {
  const real = await (await route.fetch({ method: "GET" })).json();
  return { ...real, ...overrides };
}

async function stubSaves(page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const { cookies_file: path } = route.request().postDataJSON();
    if (path === INSIDE_PATH) {
      return route.fulfill({ status: 422, json: REFUSAL });
    }
    return route.fulfill({
      json: await serverSettings(route, { cookies_file: path, cookies_file_in_library: false }),
    });
  });
}

async function stubOpenFlagged(page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: await serverSettings(route, { cookies_file: INSIDE_PATH, cookies_file_in_library: true }),
    });
  });
}

test.describe("cookies file inside the StemData folder", () => {
  test("a file inside it is refused with its own message", async ({ page }) => {
    await stubSaves(page);
    await openSettings(page);
    await enterCookiesPath(page, INSIDE_PATH);
    await expect(page.locator(".cookies-file-msg")).toHaveText(INSIDE_MESSAGE);
  });

  test("a file outside it saves and clears the message", async ({ page }) => {
    await stubSaves(page);
    await openSettings(page);
    await enterCookiesPath(page, INSIDE_PATH);
    await expect(page.locator(".cookies-file-msg")).toHaveText(INSIDE_MESSAGE);

    await enterCookiesPath(page, OUTSIDE_PATH);
    await expect(page.locator(".cookies-file-msg")).toBeHidden();
    await expect(page.locator(".set-cookies-file")).toHaveValue(OUTSIDE_PATH);
  });

  test("a saved file now inside it is flagged on open", async ({ page }) => {
    await stubOpenFlagged(page);
    await openSettings(page);
    await expect(page.locator(".set-cookies-file")).toHaveValue(INSIDE_PATH);
    await expect(page.locator(".cookies-file-msg")).toHaveText(INSIDE_MESSAGE);
  });

  test("a flagged file replaced by one outside it clears the message", async ({ page }) => {
    await stubOpenFlagged(page);
    await stubSaves(page);
    await openSettings(page);
    await expect(page.locator(".cookies-file-msg")).toHaveText(INSIDE_MESSAGE);

    await enterCookiesPath(page, OUTSIDE_PATH);
    await expect(page.locator(".cookies-file-msg")).toBeHidden();
    await expect(page.locator(".set-cookies-file")).toHaveValue(OUTSIDE_PATH);
  });
});
