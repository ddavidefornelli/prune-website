import { test, expect, addTask, newTask, openList, savedList, synced, AUTH_KEY, ACCOUNT_ID, GUEST_ID, PROJECT } from "./helpers/browser";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../src/cloud/privacy-state";

const consentNotice = (page: import("@playwright/test").Page) => page.getByText("By adding a task you agree to the Terms and Privacy Policy.");

test.describe("a new visitor", () => {
  test.use({ visitor: "new" });

  test("lands on the list, ready to type: no sign-up, and nothing sent anywhere", async ({ page, backend }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("prune — A to-do list. Nothing else.");
    await expect(newTask(page)).toBeFocused();
    await expect(consentNotice(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Google|email|sign/i })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "To do" }).getByRole("listitem")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(backend.requests).toEqual([]);
    expect(await page.locator("script[src*='googletagmanager'],script[src*='goatcounter'],script[src*='vercel-scripts']").count()).toBe(0);
  });

  test("the first task accepts the terms and quietly makes a guest id that the list syncs under", async ({ page, backend }) => {
    await page.goto("/");
    await addTask(page, "Buy milk");
    const record = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRIVACY_ACKNOWLEDGEMENT_KEY);
    expect(record.version).toBe(PRIVACY_POLICY_VERSION);
    await synced(page);
    expect(backend.guests).toHaveLength(1);
    expect(backend.tasks.map((task) => task.title)).toEqual(["Buy milk"]);
    expect((await savedList(page))?.owner).toBe(`${PROJECT}:${backend.guests[0]}`);
    // The same guest next time: no new id.
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Buy milk" })).toBeVisible();
    await synced(page);
    expect(backend.guests).toHaveLength(1);
  });

  test("the menu opens the terms and privacy notice, and reading it sends nothing", async ({ page, backend }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Terms & Privacy" }).click();
    const dialog = page.getByRole("dialog", { name: "Terms & Privacy" });
    await expect(dialog.getByRole("heading", { name: "Terms of use", exact: true })).toBeVisible();
    await expect(dialog).toContainText("There are no subscription fees or in-app purchases.");
    await expect(dialog).toContainText("Nothing in these terms excludes liability");
    await expect(dialog).toContainText("browser's localStorage");
    expect(backend.requests).toEqual([]);
  });

  test("with guests switched off on the server, the list still works and says nothing", async ({ page, backend }) => {
    backend.guestsDisabled = true;
    await page.goto("/");
    await addTask(page, "Kept on this device");
    await page.getByRole("checkbox", { name: "Kept on this device" }).check();
    await expect.poll(() => backend.requests.filter((request) => request.path === "/auth/v1/signup").length).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Done 1" })).toBeVisible();
    expect((await savedList(page))?.owner).toBeNull();
    expect(backend.syncs).toEqual([]);
  });

  test("a browser that cannot store the acceptance keeps the list here and sends nothing", async ({ page, backend }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "prune:privacy:acknowledgement") throw new DOMException("Storage denied", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await page.goto("/");
    await addTask(page, "Still here");
    await expect(consentNotice(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(backend.requests).toEqual([]);
  });

  test.describe("on a phone", () => {
    test.use({ hasTouch: true, isMobile: true });
    for (const banner of [false, true]) {
      test(`the field and menu fit, ${banner ? "with" : "without"} the cookie banner`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        if (banner) await page.addInitScript(() => localStorage.removeItem("prune:cookies:v1"));
        for (const viewport of [{ width: 280, height: 568 }, { width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
          await page.setViewportSize(viewport);
          await page.goto("/");
          const size = `${viewport.width}×${viewport.height}`;
          await expect(newTask(page), `field at ${size}`).toBeInViewport({ ratio: 1 });
          await expect(consentNotice(page), `no consent notice at ${size}`).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Menu" }), `menu at ${size}`).toBeInViewport({ ratio: 1 });
          // A phone does not raise the keyboard on arrival.
          await expect(newTask(page)).not.toBeFocused();
          expect(await page.evaluate(() => document.documentElement.scrollWidth), `no sideways scroll at ${size}`).toBeLessThanOrEqual(viewport.width);
          await expect(page.locator(".cookie-banner")).toHaveCount(banner ? 1 : 0);
        }
      });
    }
  });

  test("the page stays light: no artwork, no webfont, no images", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(requested.filter((path) => /\.(png|jpe?g|webp|svg|woff2?|ttf|otf)$/.test(path) && !/icon/.test(path))).toEqual([]);
  });
});

test.describe("a returning guest", () => {
  test("keeps its guest id and its list", async ({ page, backend }) => {
    await openList(page);
    expect(backend.guests).toEqual([]);
    expect((await savedList(page))?.owner).toBe(`${PROJECT}:${GUEST_ID}`);
    await expect(consentNotice(page)).toHaveCount(0);
  });

  test("an outdated acceptance stays local until the next task without showing a notice", async ({ page, backend }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "privacy-old", acknowledgedAt: new Date().toISOString() }));
    }, PRIVACY_ACKNOWLEDGEMENT_KEY);
    await page.goto("/");
    await expect(consentNotice(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(backend.requests).toEqual([]);
    await addTask(page, "Agreed by adding");
    await synced(page);
    expect(backend.guests).toEqual([]);
    expect(backend.tasks.map((task) => task.title)).toEqual(["Agreed by adding"]);
  });

  test("a guest the server no longer knows becomes a new guest and keeps this browser's list", async ({ page, backend }) => {
    await openList(page);
    await addTask(page, "Mine all along");
    await synced(page);
    backend.removedUsers.push(GUEST_ID);
    backend.tasks = [];
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Mine all along" })).toBeVisible();
    await synced(page);
    expect(backend.guests).toHaveLength(1);
    expect((await savedList(page))?.owner).toBe(`${PROJECT}:${backend.guests[0]}`);
    expect(backend.tasks.map((task) => task.title)).toEqual(["Mine all along"]);
  });
});

test.describe("an account from before guests", () => {
  test.use({ visitor: "account" });

  test("keeps syncing its list where it is signed in, and the menu says whose it is", async ({ page, backend }) => {
    await openList(page);
    expect(backend.guests).toEqual([]);
    expect((await savedList(page))?.owner).toBe(`${PROJECT}:${ACCOUNT_ID}`);
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toContainText("user@example.com");
    expect(await page.evaluate((key) => localStorage.getItem(key) !== null, AUTH_KEY)).toBe(true);
  });
});
