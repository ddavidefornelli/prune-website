import { test, expect, openPlanner, visitProfile, addTask, synced, QUEUE_KEY } from "./helpers/browser";

test.use({ signedIn: true });

test("Overview contains the profile button without a separate account row", async ({ page }) => {
  await openPlanner(page);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  await expect(page.locator(".account-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Profile", exact: true })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  const overview = page.getByRole("main", { name: "Overview", exact: true });
  await expect(overview).toBeVisible();
  await overview.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("main", { name: "Profile", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(overview.getByRole("button", { name: "Profile", exact: true })).toBeVisible();
});

test("profile clock ticks do not reparse completion history", async ({ page, backend }) => {
  backend.data.completions = Array.from({ length: 200 }, (_, index) => ({
    day: new Date(Date.parse(`${backend.data.today}T00:00:00Z`) - index * 86_400_000).toISOString().slice(0, 10),
    count: 1,
  }));
  await page.clock.install();
  await openPlanner(page);
  await visitProfile(page);
  await expect(page.locator(".profile-stat").filter({ hasText: "Active days" })).toContainText("200");
  const audit = await page.evaluateHandle(() => {
    const originalParse = Date.parse;
    const originalNow = Date.now;
    let parses = 0;
    let ticks = 0;
    Date.parse = (value) => { parses++; return originalParse(value); };
    Date.now = () => { ticks++; return originalNow(); };
    return () => {
      Date.parse = originalParse;
      Date.now = originalNow;
      return { parses, ticks };
    };
  });
  await page.clock.fastForward(2_000);
  const result = await audit.evaluate((finish) => finish());
  expect(result.ticks).toBeGreaterThan(0);
  expect(result.parses).toBe(0);
});

test("background reconciliation keeps a title draft and its focused input mounted", async ({ page, backend }) => {
  await openPlanner(page);
  await addTask(page, "Original outcome");
  await synced(page);
  await page.getByRole("button", { name: "Edit task title: Original outcome" }).click();
  const input = page.getByRole("textbox", { name: "Task title", exact: true });
  await input.fill("An unsaved local draft");
  const original = await input.elementHandle();
  backend.data.todayTasks[0]!.outcome = "Changed on another device";
  backend.data.revision = (backend.data.revision ?? 0) + 1;
  backend.data.completions = [{ day: backend.data.today, count: 1 }];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#app")).toHaveAttribute("data-completion-level", "1");
  await expect(input).toHaveValue("An unsaved local draft");
  await expect(input).toBeFocused();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await input.press("Escape");
  await expect(page.getByRole("button", { name: "Edit task title: Changed on another device" })).toBeVisible();
});

test("background updates preserve task-form drafts", async ({ page, backend }) => {
  await openPlanner(page);
  const input = page.getByRole("textbox", { name: "Outcome", exact: true });
  await input.fill("Keep this while syncing");
  const original = await input.elementHandle();
  backend.data.completions = [{ day: backend.data.today, count: 2 }];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#app")).toHaveAttribute("data-completion-level", "2");
  await expect(input).toHaveValue("Keep this while syncing");
  await expect(input).toBeFocused();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
});

test("the stop dialog survives background updates and Escape cannot discard it", async ({ page, backend }) => {
  await openPlanner(page);
  await addTask(page, "Focus without losing the dialog");
  await synced(page);
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await page.locator("#focus-timer").click();
  const environment = page.getByRole("button", { name: "Environment", exact: true });
  await expect(page.getByRole("button", { name: "Social media", exact: true })).toBeFocused();
  const original = await environment.elementHandle();
  backend.data.completions = [{ day: backend.data.today, count: 1 }];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#app")).toHaveAttribute("data-completion-level", "1");
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Why are you stopping?" })).toBeVisible();
  await environment.click();
  await synced(page);
  expect(backend.stops).toContain("Environment");
});

test("failed durable estimate saves roll back the dial and allow retry", async ({ page, backend }) => {
  await openPlanner(page);
  await addTask(page, "Keep estimates honest");
  await synced(page);
  await page.evaluate((key) => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error("Fixture storage unavailable");
      return save.call(this, name, value);
    };
    Object.assign(window, { restoreStorage: () => { Storage.prototype.setItem = save; } });
  }, QUEUE_KEY);
  const slider = page.locator(".task").getByRole("slider");
  await slider.press("ArrowUp");
  await expect(page.getByRole("alert").filter({ hasText: "Fixture storage unavailable" })).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuenow", "30");
  expect(backend.data.todayTasks[0]!.estimatedMinutes).toBe(30);
  await page.evaluate(() => (window as typeof window & { restoreStorage: () => void }).restoreStorage());
  await slider.press("ArrowUp");
  await synced(page);
  await expect(slider).toHaveAttribute("aria-valuenow", "35");
  expect(backend.data.todayTasks[0]!.estimatedMinutes).toBe(35);
});
