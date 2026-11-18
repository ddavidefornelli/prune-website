import { test, expect, synced, type Backend } from "./helpers/browser";

function seedYesterdayStreak(backend: Backend): void {
  const yesterday = new Date(Date.parse(`${backend.data.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  backend.data.completions = [{ day: yesterday, count: 1 }];
  backend.data.todayTasks = [{
    id: "party-task",
    outcome: "Write the intro",
    isPriority: false,
    plannedFor: backend.data.today,
    estimatedMinutes: 25,
    actualSeconds: 0,
    status: "planned",
    startedAt: null,
    completedOn: null,
    createdAt: backend.data.serverNow,
    resources: [],
  }];
}

for (const width of [390, 1280]) {
  test.describe(`streak party at ${width}px`, () => {
    test.use({ signedIn: true, viewport: { width, height: 844 } });

    test("finishing today's first task throws the party once, and it gets out of the way", async ({ page, backend }) => {
      seedYesterdayStreak(backend);
      await page.goto("/");
      await expect(page.locator(".streak-party")).toHaveCount(0);
      await page.getByRole("button", { name: "Start focus", exact: true }).click();
      await synced(page);
      // Starting alone doesn't keep the streak: only a finished task does.
      await expect(page.locator(".streak-party")).toHaveCount(0);
      await page.getByRole("button", { name: "Complete task", exact: true }).click();
      await synced(page);
      const party = page.getByRole("dialog", { name: /.+/ }).and(page.locator(".streak-party"));
      await expect(party).toBeVisible();
      await expect(party.locator(".party-count strong")).toHaveText("2");
      await expect(party.locator(".party-plum")).toBeVisible();
      const box = await party.boundingBox();
      expect(box?.width).toBe(width);
      await expect(party.getByRole("button", { name: "Keep going" })).toBeFocused();
      await party.getByRole("button", { name: "Keep going" }).click();
      await expect(page.locator(".streak-party")).toHaveCount(0);
      // Already lit: a reload doesn't throw it again.
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      await expect(page.locator(".streak-party")).toHaveCount(0);
    });
  });
}
