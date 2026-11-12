import { test, expect, openPlanner, synced, finishTour } from "./helpers/browser";

test.describe("first run", () => {
  test.use({ signedIn: true, firstVisit: true });

  for (const width of [1100, 390]) {
    test(`the first task comes from the tour, then focus is taught just in time at ${width}px`, async ({ page, backend }) => {
      await page.setViewportSize({ width, height: 844 });
      await openPlanner(page);
      // The tour opens first and ends by creating the first task (tests/tour.spec.ts).
      await finishTour(page);
      await synced(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(backend.data.todayTasks).toHaveLength(1);
      expect(backend.data.todayTasks[0]!.estimatedMinutes).toBe(30);
      expect(backend.data.activeTask).toBeNull();
      await expect(page.locator(".starters")).toHaveCount(0);
      const next = page.locator(".task.is-next");
      await expect(next).not.toContainText("Up next");
      const tip = page.getByRole("complementary", { name: "Tip" });
      await expect(tip).toContainText("Start when you’re ready.");
      await page.reload();
      await expect(page.locator(".starters")).toHaveCount(0);
      await next.getByRole("button", { name: "Start focus", exact: true }).click();
      await expect(page.locator("#focus-timer")).toBeVisible();
      await expect(page).toHaveTitle(/· Plan the week ahead$/);
      await page.locator("#focus-timer").click();
      await expect(page.getByRole("dialog")).toContainText("Why are you stopping?");
      await expect(page.getByRole("dialog")).not.toContainText("The timer is paused");
    });
  }

  test("existing history skips the first plan", async ({ page, backend }) => {
    backend.data.completions = [{ day: backend.data.today, count: 1 }];
    await openPlanner(page);
    await expect(page.locator(".starters")).toHaveCount(0);
  });
});

test.describe("returning visits", () => {
  test.use({ signedIn: true });

  test("an empty new day recalls yesterday instead of onboarding", async ({ page, backend }) => {
    const yesterday = new Date(Date.parse(`${backend.data.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    backend.data.completions = [{ day: yesterday, count: 2 }];
    await openPlanner(page);
    await expect(page.locator(".plan-summary")).toHaveText("2 down yesterday. Today’s three?");
    // No onboarding starters or tips. After 17:00 the evening "plan tomorrow"
    // card may also appear; it is not onboarding, so it is left out.
    await expect(page.locator(".starters, .hint-card:not(.evening-card)")).toHaveCount(0);
  });
});

