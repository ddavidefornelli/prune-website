import { test, expect, openPlanner } from "./helpers/browser";

test.use({ signedIn: true });

test("calendar preserves accessible labels and roving focus across Overview and Profile", async ({ page, backend }) => {
  backend.data.completions = [{ day: backend.data.today, count: 4 }];
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Task completion history" });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole("heading")).toContainText("4 tasks completed");
  await expect(calendar.locator(".activity-weekday")).toHaveCount(7);
  const today = calendar.locator('[aria-current="date"]');
  await expect(today).toHaveClass(/activity-level-3/);
  await expect(today).toHaveAttribute("aria-label", /^4 tasks completed on /);
  const tabStop = calendar.locator('[tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await today.focus();
  await today.press("Home");
  const pastDays = calendar.locator('[role="listitem"][tabindex]');
  await expect(pastDays.first()).toBeFocused();
  await pastDays.first().press("ArrowRight");
  // The first of the month may also be today: navigation must clamp safely.
  const next = Math.min(1, await pastDays.count() - 1);
  await expect(pastDays.nth(next)).toBeFocused();
  await pastDays.nth(next).press("End");
  await expect(today).toBeFocused();
  await today.press("ArrowDown");
  await expect(today).toBeFocused();
  await expect(tabStop).toHaveCount(1);
  await expect(calendar.locator('.is-future[tabindex]')).toHaveCount(0);

  // Earlier months page back, then return to the current one.
  const nextMonth = calendar.getByRole("button", { name: "Next month" });
  await expect(nextMonth).toBeDisabled();
  await calendar.getByRole("button", { name: "Previous month" }).click();
  await expect(calendar.getByRole("heading")).toContainText("0 tasks completed");
  await expect(calendar.locator('[aria-current="date"]')).toHaveCount(0);
  await nextMonth.click();
  await expect(calendar.getByRole("heading")).toContainText("4 tasks completed");

  for (let index = 0; index < 2; index++) {
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(calendar).toHaveCount(1);
    await expect(calendar.getByRole("list")).toHaveAccessibleName(/4 tasks completed/);
    await expect(tabStop).toHaveCount(1);
    await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
    await expect(calendar).toHaveCount(1);
  }
});

test("Overview shows the month's finished share, focus time and active days, and pages with the calendar", async ({ page, backend }) => {
  backend.data.completions = [{ day: backend.data.today, count: 2 }];
  backend.monthStats = { planned: 4, completed: 3, focusSeconds: 5400 };
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Task completion history" });
  const stats = calendar.locator(".activity-stats");
  await expect(stats).toContainText("75%");
  await expect(stats).toContainText("3 of 4 planned");
  await expect(stats).toContainText("1 h 30 min");
  await expect(stats.locator(".activity-stat").nth(2).locator("strong")).toHaveText("1");
  const month = backend.data.today.slice(0, 7);
  expect(backend.requests.some((request) => request.body.p_action === "month_stats" && request.body.p_args.month === month)).toBe(true);
  backend.monthStats = { planned: 0, completed: 0, focusSeconds: 0 };
  await calendar.getByRole("button", { name: "Previous month" }).click();
  await expect(stats).toContainText("Nothing planned yet");
  await expect(stats.locator(".activity-stat").nth(2).locator("strong")).toHaveText("0");
});

test("Overview leaves the stats out when the backend has no month_stats yet", async ({ page, backend }) => {
  backend.monthStats = null;
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Task completion history" });
  await expect(calendar.locator('[aria-current="date"]')).toBeVisible();
  await expect(calendar.locator(".activity-stats")).toHaveCount(0);
  await expect(calendar).not.toHaveClass(/has-stats/);
});
