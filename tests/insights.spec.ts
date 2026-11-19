import { test, expect, synced } from "./helpers/browser";
import type { Page } from "@playwright/test";

/** The streak and the check-in meter live on Overview. */
const visit = (page: Page, name: "Overview" | "Today") =>
  page.getByRole("navigation").getByRole("button", { name, exact: true }).click();

const SHOTS = process.env.INSIGHT_SHOTS;
const dayBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

for (const [width, height] of [[320, 568], [390, 844], [1280, 800]] as const) {
  test.describe(`insight drop at ${width}px`, () => {
    test.use({ signedIn: true, viewport: { width, height } });

    test("a finished task can drop a fact about the owner's own streak", async ({ page, backend }) => {
      // Always drop, and always the first insight the data supports.
      await page.addInitScript(() => { Math.random = () => 0; });
      const today = backend.data.today;
      backend.data.completions = [1, 2, 3].map((days) => ({ day: dayBefore(today, days), count: 1 }));
      backend.data.todayTasks = [{ id: "insight-task", outcome: "Write the report", plannedFor: today, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: backend.data.serverNow }];
      await page.goto("/");
      await expect(page.locator(".insight-drop")).toHaveCount(0);
      // Today keeps to the plan: the streak and check-in are on Overview.
      await expect(page.locator(".review-meter")).toHaveCount(0);

      await page.getByRole("button", { name: "Start focus", exact: true }).click();
      await synced(page);
      await page.getByRole("button", { name: "Complete task", exact: true }).click();
      await synced(page);

      const drop = page.locator(".insight-drop");
      await expect(drop).toBeVisible();
      await expect(drop).toContainText("4 days in a row. That’s your longest streak yet.");
      // Nothing spills past the viewport on a small phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const box = (await drop.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The log holds numbers only, never the task's title.
      const log = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("prune:insights:v1:"))?.[1] ?? "");
      expect(JSON.parse(log).log).toHaveLength(1);
      expect(log).not.toContain("report");
      if (SHOTS) {
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${SHOTS}/insight-${width}.png` });
      }

      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(drop).toHaveCount(0);
    });

    test("Overview counts down to the check-in day, and Today announces a landed check-in", async ({ page, backend }) => {
      const meter = page.locator(".review-meter .check-in-meter");
      const shift = (days: number) => new Date(Date.parse(`${backend.data.today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      backend.weekly.week.nextUpdate = shift(3);
      backend.weekly.checkIn = { day: 3, plan: null };
      await page.goto("/");
      await visit(page, "Overview");
      await expect(meter).toContainText("Weekly check-in · Wednesday");
      await expect(meter).toContainText("In 3 days");
      await expect(meter.locator(".check-in-week")).toHaveAttribute("aria-label", "4 of 7 days until your check-in.");
      await expect(meter.locator(".check-in-week .is-past")).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (SHOTS) {
        await page.waitForTimeout(1300);
        await page.screenshot({ path: `${SHOTS}/check-in-meter-${width}.png` });
      }

      await visit(page, "Today");
      await expect(page.locator(".review-unlocked")).toHaveCount(0);
      backend.weekly.reviews = [{ weekStart: shift(-7), weekEnd: shift(-1), model: "gpt-4.1-mini", generatedAt: Math.floor(Date.now() / 1000), activity: { tasks: [], stops: [], totalStops: 0, omittedStops: 0 }, analysis: { summary: "A steady week.", mainReasons: [], improvements: ["Start earlier."] } }];
      backend.weekly.status = "up_to_date";
      backend.weekly.week.nextUpdate = shift(7);
      // Returning to the tab re-reads the check-in.
      await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
      const card = page.locator(".review-unlocked");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Your trends and next week’s plan are ready.");
      await card.getByRole("button", { name: "Open it", exact: true }).click();
      await expect(page.locator(".check-in")).toBeVisible();
      await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.locator(".review-unlocked")).toHaveCount(0);
      // On Overview, the meter leads down to the check-in itself.
      await visit(page, "Overview");
      await meter.click();
      await expect(page.locator(".weekly-overview")).toBeInViewport();
    });

    test("a check-in shows smoothed trends and a plan that sets Today's target and estimate", async ({ page, backend }) => {
      const shift = (days: number) => new Date(Date.parse(`${backend.data.today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      // Three weeks: tasks run long (60m on 30m estimates), about 3 finished a day over 2 days.
      const week = (ago: number, generatedAt: number) => {
        const start = shift(-7 * ago - 7);
        const end = shift(-7 * ago - 1);
        const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `w${ago}-${i}`, outcome: `Task ${i}`, plannedFor: start, completedOn: i < 6 ? (i < 3 ? start : shift(-7 * ago - 6)) : null, status: "completed" as const, estimatedMinutes: 30, actualSeconds: 3600 }));
        return { weekStart: start, weekEnd: end, model: "gpt-4.1-mini", generatedAt, activity: { tasks, stops: [], totalStops: 0, omittedStops: 0 }, analysis: { summary: `Week ${ago} summary.`, mainReasons: [], improvements: ["Split long tasks."] } };
      };
      const now = Math.floor(Date.now() / 1000);
      backend.weekly.reviews = [week(0, now), week(1, now - 604800), week(2, now - 1209600)];
      backend.weekly.status = "up_to_date";
      await page.goto("/");
      await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
      const checkIn = page.locator(".check-in");
      await expect(checkIn.locator(".check-in-eyebrow")).toContainText("Check-in ·");
      const trends = checkIn.locator(".check-in-trend");
      await expect(trends.nth(0)).toContainText("100% over");
      await expect(trends.nth(1)).toContainText("3.0");
      await expect(trends.nth(2)).toContainText("3 h");
      const plan = checkIn.locator(".check-in-plan");
      await expect(plan).toContainText("New tasks start at");
      await expect(plan.locator("s").first()).toHaveText("30 min");
      await expect(plan.locator("strong").first()).toHaveText("1 h");
      await expect(plan.locator("strong").nth(1)).toHaveText("3");
      await expect(checkIn.locator(".check-in-coach")).toContainText("Week 0 summary.");
      await expect(page.locator(".weekly-history")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (SHOTS) {
        await checkIn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${SHOTS}/check-in-${width}.png`, fullPage: true });
      }
      await plan.getByRole("button", { name: "Accept plan", exact: true }).click();
      await expect(plan).toContainText("Plan set.");
      expect(backend.weekly.checkIn?.plan).toEqual({ estimateFactor: 2, dailyTarget: 3, decidedFor: shift(-1) });
      await expect(plan.getByRole("button", { name: "Accept plan", exact: true })).toHaveCount(0);

      await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.locator(".plan-summary")).toContainText("Pick today’s three.");
      await expect(page.locator(".plan-slots .is-extra")).toHaveCount(2);
      if (width >= 760) await expect(page.locator(".task-estimate-inline")).toContainText("60");
    });

    test("a finished task with no insight shows nothing, and the streak counts it", async ({ page, backend }) => {
      // Never drop an insight.
      await page.addInitScript(() => { Math.random = () => 0.99; });
      const today = backend.data.today;
      backend.data.completions = [{ day: dayBefore(today, 1), count: 1 }];
      backend.data.todayTasks = ["Write the report", "Call the bank"].map((outcome, i) => ({ id: `message-task-${i}`, outcome, plannedFor: today, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: backend.data.serverNow })) as never;
      await page.goto("/");
      const streak = page.getByRole("region", { name: "Streak" });
      await visit(page, "Overview");
      await expect(streak).toContainText("1day streak");
      await expect(streak).toContainText("Finish one task today to keep it.");
      await visit(page, "Today");
      await page.getByRole("button", { name: "Start focus", exact: true }).first().click();
      await synced(page);
      await page.getByRole("button", { name: "Complete task", exact: true }).click();
      await synced(page);
      await expect(page.locator(".insight-drop")).toHaveCount(0);
      await visit(page, "Overview");
      await expect(streak).toContainText("2day streak");
      await expect(streak.locator('[data-state="done"]').last()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (SHOTS) {
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${SHOTS}/streak-${width}.png` });
      }
    });
  });
}
