import { test, expect, openPlanner, synced } from "./helpers/browser";
import type { Task } from "../src/planner/types";

test.use({ signedIn: true, firstVisit: true });

/** The navigation, plan and form render behind the modal tour. */
async function openWithTour(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".tour-popup")).toBeVisible();
}

for (const width of [1100, 390]) {
  test(`an empty account gets the tour on load, ending at the task form, at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 844 });
    await openWithTour(page);
    const tour = page.locator(".planner-tour-dialog");
    const popup = page.locator(".tour-popup");
    const titles = ["Three tasks a day", "Finish 10, get an AI review", "Plan ahead", "See your progress", "Add your first task"];
    for (const [index, view] of ["today", "today", "tomorrow", "habits", "today"].entries()) {
      await expect(popup.getByRole("heading")).toHaveText(titles[index]!);
      await expect(popup).toContainText(`${index + 1} / 5`);
      await expect(page.locator("#app")).toHaveAttribute("data-view", view);
      await expect(popup).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".tour-highlight")).toBeInViewport({ ratio: 1 });
      await expect(tour).not.toContainText("Profile");
      if (index === 1) {
        // The meter is on Today from the first visit.
        await expect(page.locator(".review-meter")).toContainText("3 / 10");
        await expect(page.locator(".tour-highlight")).toBeInViewport();
        await popup.getByRole("button", { name: "Back", exact: true }).click();
        await expect(popup.getByRole("heading")).toHaveText(titles[0]!);
        await popup.getByRole("button", { name: "Next", exact: true }).click();
      }
      if (index < 4) {
        await expect(popup.getByRole("button", { name: /Add my first task|Start focusing/ })).toHaveCount(0);
        await popup.getByRole("button", { name: "Next", exact: true }).click();
      }
    }
    await popup.getByRole("button", { name: "Add my first task" }).click();
    await expect(tour).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Outcome", exact: true })).toBeFocused();
    await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
    expect(backend.requests.filter((request) => request.body.p_action === "create_task")).toHaveLength(0);
    // Adding the first task afterwards does not bring the tour back, nor does a reload.
    await page.getByRole("region", { name: "Starting ideas" }).getByRole("button", { name: /Plan the week ahead/ }).click();
    await synced(page);
    await expect(tour).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".task")).toHaveCount(1);
    await expect(tour).toHaveCount(0);
  });
}

test("an account with a planned task tours it and can start its timer", async ({ page, backend }) => {
  const now = Math.floor(Date.now() / 1000);
  const task: Task = { id: "existing", outcome: "Write a first draft", isPriority: false, plannedFor: backend.data.today, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: now, resources: [] };
  backend.data.todayTasks.push(task);
  backend.data.completions = [{ day: backend.data.today, count: 3 }];
  await openWithTour(page);
  const popup = page.locator(".tour-popup");
  await expect(popup.getByRole("heading")).toHaveText("Your task is here");
  await expect(popup).toContainText("1 / 6");
  for (let step = 0; step < 5; step++) await popup.getByRole("button", { name: "Next", exact: true }).click();
  await expect(popup.getByRole("heading")).toHaveText("Ready to focus?");
  expect(backend.data.activeTask).toBeNull();
  await popup.getByRole("button", { name: "Start focusing" }).click();
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expect.poll(() => backend.data.activeTask).not.toBeNull();
});

test("skipping the tour is remembered for that account", async ({ page }) => {
  await openWithTour(page);
  await page.locator(".tour-popup").getByRole("button", { name: "Skip tour" }).click();
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-view", "today");
  await openPlanner(page);
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
});
