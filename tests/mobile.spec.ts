import { test, expect, openPlanner, openSignIn, visitProfile, addTask, synced } from "./helpers/browser";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("touch-first signup and policy remain usable on a phone", async ({ page }, info) => {
  await openSignIn(page);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `test-results/${info.project.name}-mobile-signup.png`, fullPage: true });
  await page.getByRole("button", { name: "Terms & Privacy", exact: true }).first().tap();
  await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Close privacy policy" }).tap();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue with Google" }).tap();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test.describe("mobile planner", () => {
  test.use({ signedIn: true });
  test("navigation labels keep their own space on narrow phones", async ({ page }) => {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 700 });
      await openPlanner(page);
      const tabs = await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button").evaluateAll(
        (buttons) => buttons.map((button) => ({ label: button.textContent, fits: button.scrollWidth <= button.clientWidth })),
      );
      expect(tabs.length).toBe(4);
      for (const tab of tabs) expect(tab, `${tab.label} at ${width}px`).toMatchObject({ fits: true });
    }
  });
  test("task controls, timer and pause dialog work with touch", async ({ page }, info) => {
    await openPlanner(page);
    for (const title of ["Write the first draft", "Ship the small update", "Make time to read"]) { await addTask(page, title); await synced(page); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/${info.project.name}-mobile-today.png`, fullPage: true });
    await page.locator(".task").first().getByRole("button", { name: "Start focus", exact: true }).tap();
    await expect(page.locator("#focus-timer")).toBeEnabled();
    await page.waitForTimeout(400); // Settle the navigation indicator's 360ms transition.
    await page.screenshot({ path: `test-results/${info.project.name}-mobile-focus.png`, fullPage: true });
    await page.locator("#focus-timer").tap();
    await expect(page.getByRole("dialog", { name: "Why are you stopping?" })).toBeInViewport({ ratio: 1 });
    await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Stretch break");
    await page.getByRole("button", { name: "Save reason", exact: true }).tap();
    await expect(page.locator("#focus-timer")).toHaveClass(/is-paused/);
    await visitProfile(page);
    await expect(page.locator(".profile-page")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
