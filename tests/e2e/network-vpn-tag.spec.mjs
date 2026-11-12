// Settings > Network lists one QR card per address another device can open.
// An address on a VPN only works for devices on that VPN, so its card says so.

import { test, expect } from "@playwright/test";
import { seedLibrary, settleRoutes, waitForNetworkRendered } from "./helpers.mjs";

test.afterEach(settleRoutes);

const LAN_URL = "http://192.168.1.50:8000";
const VPN_URL = "http://100.64.0.7:8000";

const card = (page, host) => page.locator(".qr-card", { hasText: host });
const tag = (cardLocator) => cardLocator.locator(".qr-label .qr-tag");

async function openNetworkSettings(page) {
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await page.locator('.settings-tab[data-tab="network"]').click();
  await expect(page.locator(".net-access-input")).toBeVisible();
  await waitForNetworkRendered(page);
}

/** Answer GET /api/settings with the given address fields merged in. */
async function withSettings(page, fields) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = await (await route.fetch()).json();
    delete body.network_addresses;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...body, allow_network: true, ...fields }),
    });
  });
}

test("a VPN address carries a VPN tag and a LAN address does not", async ({ page }) => {
  await withSettings(page, {
    lan_addresses: [LAN_URL, VPN_URL],
    network_addresses: [
      { url: LAN_URL, kind: "lan" },
      { url: VPN_URL, kind: "vpn" },
    ],
  });
  await openNetworkSettings(page);
  const vpnCard = card(page, "100.64.0.7:8000");
  await expect(tag(vpnCard)).toHaveText("VPN");
  await expect(vpnCard.locator(".qr-label")).toHaveAttribute("title", `${VPN_URL}/mobile/`);
  await expect(tag(card(page, "192.168.1.50:8000"))).toHaveCount(0);
});

test("a payload with only lan_addresses still renders a card per address", async ({ page }) => {
  await withSettings(page, { lan_addresses: [LAN_URL, VPN_URL] });
  await openNetworkSettings(page);
  await expect(page.locator(".qr-card")).toHaveCount(2);
  await expect(page.locator(".qr-tag")).toHaveCount(0);
});
