import { test, expect } from "@playwright/test";

const origin = "https://www.prune.win";
const key = "prune:cookies:v1";

test("optional recorder waits for consent, remembers it and stops after withdrawal", async ({ page, request }) => {
  const recorderRequests: string[] = [];
  await page.route("https://**.contentsquare.net/**", async (route) => {
    recorderRequests.push(route.request().url());
    await route.fulfill({ contentType: "application/javascript", body: "" });
  });
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/_vercel/")) {
      await route.fulfill({ contentType: "application/javascript", body: "" });
    } else {
      await route.fulfill({ response: await request.get(`http://127.0.0.1:4173${url.pathname}`) });
    }
  });
  await page.goto(origin);
  const banner = page.getByRole("region", { name: "Cookie preferences" });
  await expect(banner).toBeVisible();
  expect(recorderRequests).toEqual([]);
  // Signed-out visitors land on sign-in, which keeps Cookie settings reachable.
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  await page.reload();
  await expect(banner).toHaveCount(0);
  expect(recorderRequests).toEqual([]);
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await page.getByRole("button", { name: "Accept optional", exact: true }).click();
  await expect.poll(() => recorderRequests.length).toBe(1);
  await page.reload();
  await expect.poll(() => recorderRequests.length).toBe(2);
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  expect(recorderRequests).toHaveLength(2);
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).choice, key)).toBe("rejected");
});

test("expired consent prompts again without loading the recorder", async ({ page }) => {
  await page.addInitScript((storageKey) => {
    localStorage.setItem(storageKey, JSON.stringify({ choice: "accepted", at: 1 }));
  }, key);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Cookie preferences" })).toBeVisible();
  expect(await page.locator('script[src*="contentsquare"]').count()).toBe(0);
});
