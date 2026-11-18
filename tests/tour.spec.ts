import { test, expect, openPlanner, synced } from "./helpers/browser";
import type { Page } from "@playwright/test";

/** The focus time lives on Overview, not Today. */
async function overview(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
}
import type { Task } from "../src/planner/types";

test.use({ signedIn: true, firstVisit: true });

const planned = (day: string, outcome: string): Task => ({ id: "existing", outcome, isPriority: false, plannedFor: day, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: Math.floor(Date.now() / 1000), resources: [] });

const TITLES = ["Five tasks a day", "Plan ahead", "Watch your progress"];

/** The three steps of the tour, each on its part of the app; ends on the first-task card. */
async function walkTour(page: Page) {
  const popup = page.locator(".tour-popup");
  for (const [index, view] of ["today", "tomorrow", "habits"].entries()) {
    await expect(popup.getByRole("heading")).toHaveText(TITLES[index]!);
    await expect(popup).toContainText(`${index + 1} / 6`);
    await expect(page.locator("#app")).toHaveAttribute("data-view", view);
    await expect(popup).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".tour-highlight")).toBeInViewport({ ratio: 1 });
    await popup.getByRole("button", { name: "Next", exact: true }).click();
  }
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
  const card = page.locator(".first-task-dialog");
  await expect(card).toContainText("4 / 6");
  await expect(page.locator("#app")).toHaveAttribute("data-view", "today");
  return card;
}

for (const width of [1100, 390]) {
  test(`a new account tours the app, adds a first task, then sets a focus time and reminders, at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const popup = page.locator(".tour-popup");
    await expect(popup.getByRole("heading")).toHaveText(TITLES[0]!);
    // It can't be skipped, and Back works.
    await expect(popup.getByRole("button", { name: /skip/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popup).toBeVisible();
    await popup.getByRole("button", { name: "Next", exact: true }).click();
    await popup.getByRole("button", { name: "Back", exact: true }).click();
    const card = await walkTour(page);

    // The first task: a question, a box and a tap for the estimate.
    await expect(card.getByRole("heading")).toHaveText("What’s the one thing you want done today?");
    await expect(card).toBeInViewport({ ratio: 1 });
    const add = card.getByRole("button", { name: "Add task", exact: true });
    await expect(add).toBeDisabled();
    await expect(card.getByRole("button", { name: "30 min" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(card).toBeVisible();
    await card.getByRole("textbox", { name: "Your first task" }).fill("Write the intro");
    await card.getByRole("button", { name: "45 min" }).click();
    await add.click();
    await expect(card).toHaveCount(0);
    await synced(page);
    expect(backend.data.todayTasks.map((task) => [task.outcome, task.estimatedMinutes])).toEqual([["Write the intro", 45]]);

    // Then the focus time, and what it gets you.
    const picker = page.locator(".focus-time-dialog");
    await expect(picker).toContainText("5 / 6");
    await expect(picker.getByRole("heading")).toHaveText("When do you want to focus each day?");
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect(picker.getByRole("button", { name: "Start now instead" })).toBeVisible();
    await picker.getByRole("button", { name: /Afternoon/ }).click();
    await expect(picker).toContainText("6 / 6");
    await expect(picker.getByRole("heading")).toHaveText("Every day at 14:00.");
    expect(backend.schedule).toEqual({ focusMinute: 14 * 60, weekdaysOnly: false, pushDevices: 0 });
    await expect(picker).toContainText("We’ll email you then");
    await expect(picker.getByRole("listitem").filter({ hasText: "Notification" })).toBeVisible();
    await expect(picker.getByRole("link", { name: "Google" })).toHaveAttribute("href", /calendar\.google\.com.*recur=RRULE%3AFREQ%3DDAILY/);
    await expect(picker.getByRole("button", { name: "Apple / Outlook" })).toBeVisible();
    await expect(picker).toBeInViewport({ ratio: 1 });
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await expect(picker).toHaveCount(0);

    // Every step lands in the account's history, without the task's title.
    await expect.poll(() => backend.journey.map(([event]) => event)).toEqual([
      "planner_opened", "tour_shown", "tour_finished", "first_task_shown", "first_task_added",
      "focus_time_shown", "focus_time_saved", "focus_time_closed",
    ]);
    expect(backend.journey[0]![1]).toMatchObject({ new_account: true, from: "app" });
    expect(backend.journey[4]![1]).toEqual({ minutes: 45 });
    expect(backend.journey[6]![1]).toMatchObject({ mode: "onboarding", minute: 14 * 60 });
    expect(JSON.stringify(backend.journey)).not.toContain("Write the intro");

    // Remembered: a reload brings back none of it; Overview shows the time and can change it.
    await page.reload();
    await expect(page.locator(".task")).toHaveCount(1);
    await expect(page.locator(".planner-tour-dialog, .first-task-dialog, .focus-time-dialog")).toHaveCount(0);
    await overview(page);
    const line = page.getByRole("complementary", { name: "Focus time" });
    await expect(line).toContainText("14:00 · every day");
    await line.getByRole("button", { name: "Change" }).click();
    await expect(picker.getByRole("button", { name: /Afternoon/ })).toHaveAttribute("aria-pressed", "true");
    await expect(picker).not.toContainText("/ 6");
    await expect(picker.getByRole("button", { name: "Start now instead" })).toHaveCount(0);
    await picker.getByRole("button", { name: /Other/ }).click();
    await picker.getByLabel("Your focus time").fill("07:45");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    await expect(picker.getByRole("heading")).toHaveText("Every day at 07:45.");
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await expect(line).toContainText("07:45");
    expect(backend.schedule!.focusMinute).toBe(7 * 60 + 45);
  });
}

test("Later skips the first task without a placeholder, and the focus time still follows", async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const card = await walkTour(page);
  await card.getByRole("button", { name: "Later", exact: true }).click();
  const picker = page.locator(".focus-time-dialog");
  await expect(picker).toContainText("5 / 6");
  // Nothing to start yet.
  await expect(picker.getByRole("button", { name: "Start now instead" })).toHaveCount(0);
  await picker.getByRole("button", { name: /Morning/ }).click();
  await expect(picker.getByRole("button", { name: "Start now" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  expect(backend.data.todayTasks).toHaveLength(0);
  await overview(page);
  await expect(page.getByRole("complementary", { name: "Focus time" })).toContainText("09:00");
  await page.reload();
  await expect(page.locator(".planner-tour-dialog, .first-task-dialog")).toHaveCount(0);
});

test("after the first task, Start now instead goes straight to the timer", async ({ page, backend }) => {
  await page.goto("/");
  const card = await walkTour(page);
  await card.getByRole("textbox", { name: "Your first task" }).fill("Write the intro");
  await card.getByRole("textbox", { name: "Your first task" }).press("Enter");
  await page.locator(".focus-time-dialog").getByRole("button", { name: "Start now instead" }).click();
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expect.poll(() => backend.data.activeTask).not.toBeNull();
  expect(backend.data.activeTask!.estimatedMinutes).toBe(30);
  expect(backend.schedule!.focusMinute).toBeNull();
});

test("accounts that already have tasks get no tour, and Overview offers the focus time", async ({ page, backend }) => {
  backend.data.todayTasks.push(planned(backend.data.today, "Write a first draft"));
  await openPlanner(page);
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Focus time" })).toHaveCount(0);
  await overview(page);
  const line = page.getByRole("complementary", { name: "Focus time" });
  await expect(line).toContainText("Set your focus time");
  await line.getByRole("button", { name: "Set time" }).click();
  await page.locator(".focus-time-dialog").getByRole("button", { name: /Evening/ }).click();
  await page.locator(".focus-time-dialog").getByRole("button", { name: "Done", exact: true }).click();
  await expect(line).toContainText("19:00");
});

test("coming back to a planner left open counts as another visit, a quick glance does not", async ({ page, backend }) => {
  backend.data.todayTasks.push(planned(backend.data.today, "Write a first draft"));
  await openPlanner(page);
  await expect.poll(() => backend.journey.map(([event]) => event)).toEqual(["planner_opened"]);
  // Hide the tab, move the clock on, show it again.
  const away = (minutes: number) => page.evaluate((ms) => {
    const set = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    set("hidden");
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + ms;
    set("visible");
    Date.now = realNow;
  }, minutes * 60_000);
  await away(5);
  await away(45);
  await expect.poll(() => backend.journey.map(([event]) => event)).toEqual(["planner_opened", "planner_opened"]);
  expect(backend.journey[1]![1]).toEqual({ new_account: false, from: "back", active_task: false, today_tasks: 1 });
});

test("a reminder link starts the next planned task", async ({ page, backend }) => {
  backend.data.todayTasks.push(planned(backend.data.today, "Write the intro"));
  await page.goto("/?start=next");
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
