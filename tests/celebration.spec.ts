import { test, expect, synced, type Backend } from "./helpers/browser";

function seedFinalTask(backend: Backend): void {
  backend.data.todayTasks = ["First outcome", "Second outcome", "Final outcome"].map((outcome, i) => ({
    id: `completion-task-${i}`,
    outcome,
    plannedFor: backend.data.today,
    estimatedMinutes: 30,
    actualSeconds: i < 2 ? 1800 : 0,
    status: i < 2 ? "completed" : "planned",
    startedAt: null,
    completedOn: i < 2 ? backend.data.today : null,
    createdAt: backend.data.serverNow,
  }));
  backend.data.completions = [{ day: backend.data.today, count: 2 }];
}

for (const width of [390, 1440]) {
  test.describe(`quiet day completion at ${width}px`, () => {
    test.use({ signedIn: true, viewport: { width, height: 900 } });

    test("finishing the day has no crown or overlay and keeps navigation usable", async ({ page, backend }) => {
      seedFinalTask(backend);
      await page.goto("/");
      await expect(page.locator(".task-crown, .task.is-priority")).toHaveCount(0);
      await page.getByRole("button", { name: "Start focus", exact: true }).click();
      await synced(page);
      await page.getByRole("button", { name: "Complete task", exact: true }).click();
      await synced(page);
      await expect(page.locator(".task.is-completed")).toHaveCount(3);
      await expect(page.locator(".crown-celebration, .completion-moment, .diamond-rain")).toHaveCount(0);
      const today = page.getByRole("navigation").getByRole("button", { name: "Today", exact: true });
      await expect(today).toHaveClass(/day-complete/);
      await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
      await expect(page.getByRole("main", { name: "Tomorrow", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      await expect(page.locator(".crown-celebration, .task-crown")).toHaveCount(0);
    });
  });
}
