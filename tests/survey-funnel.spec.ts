import { test, expect } from "@playwright/test";

test("production survey visits count each funnel step once, never answers, under CSP", async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prune:cookies:v1", JSON.stringify({ choice: "rejected", at: Date.now() }));
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as any).__violations ??= [];
      (window as any).__violations.push(event.violatedDirective);
    });
  });
  // The flag-on build, served as the production origin so counting is active.
  await page.route("https://www.prune.win/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/_vercel/")) {
      await route.fulfill({ status: 204 });
      return;
    }
    const response = await request.get(`http://127.0.0.1:4174${url.pathname}`);
    await route.fulfill({ response });
  });
  const headers = { "Access-Control-Allow-Origin": "https://www.prune.win", "Access-Control-Allow-Headers": "apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const counted: unknown[] = [];
  await page.route("https://web-fixture.supabase.co/**", async (route) => {
    if (route.request().method() === "POST") counted.push({ path: new URL(route.request().url()).pathname, ...route.request().postDataJSON() });
    await route.fulfill({ status: route.request().method() === "OPTIONS" ? 204 : 200, headers, contentType: "application/json", body: "null" });
  });
  await page.goto("https://www.prune.win/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("textbox", { name: "First, what should we call you?" }).fill("Ada");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Ship a project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What do you do?" })).toBeVisible();
  await page.getByRole("button", { name: "Skip, just let me plan" }).click();
  await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
  const metrics = (event: string) => ({ path: "/rest/v1/rpc/guest_record_usage", p_metrics: { [`funnel_survey_${event}`]: 1 } });
  await expect.poll(() => counted).toEqual([metrics("shown"), metrics("started"), metrics("skipped")]);
  expect(JSON.stringify(counted)).not.toMatch(/Ada|ship/);
  // Coming back counts nothing new for this browser.
  await page.reload();
  await expect(page.locator(".plan-summary")).toBeVisible();
  await page.waitForTimeout(300);
  expect(counted).toHaveLength(3);
  expect(await page.evaluate(() => (window as any).__violations ?? [])).toEqual([]);
});
