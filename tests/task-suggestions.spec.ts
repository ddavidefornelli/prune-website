import { test, expect, openPlanner } from "./helpers/browser";

test.describe("signed in", () => {
  test.use({ signedIn: true });

  test("proposes today's tasks from yesterday and adds one with its estimate", async ({ page, backend }) => {
    backend.suggestions = [
      { outcome: "Finish the quarterly report", estimatedMinutes: 25, basis: "carry_over" },
      { outcome: "Send the report to finance", estimatedMinutes: 15, basis: "follow_up" },
    ];
    await openPlanner(page);
    const section = page.getByRole("region", { name: "Suggested from yesterday" });
    await expect(section).toContainText("Unfinished · 25 min");
    await section.getByRole("button", { name: /Finish the quarterly report/ }).click();
    await expect(page.getByRole("button", { name: "Edit task title: Finish the quarterly report", exact: true })).toBeVisible();
    await expect.poll(() => backend.data.todayTasks.map((task) => [task.outcome, task.estimatedMinutes]))
      .toEqual([["Finish the quarterly report", 25]]);
    await expect(section.getByRole("button")).toHaveCount(1);
    const calls = backend.requests.filter((request) => request.path === "/functions/v1/task-suggestions");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ timezone: expect.any(String), target: "today" });
    // Reloading reuses the stored answer instead of spending the daily allowance.
    await page.reload();
    await expect(page.getByRole("region", { name: "Suggested from yesterday" })).toContainText("Send the report to finance");
    expect(backend.requests.filter((request) => request.path === "/functions/v1/task-suggestions")).toHaveLength(1);
  });

  test("proposes tomorrow's tasks from today and asks for the tomorrow target", async ({ page, backend }) => {
    backend.suggestions = [{ outcome: "Review the launch checklist", estimatedMinutes: 20, basis: "follow_up" }];
    await openPlanner(page);
    await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
    const section = page.getByRole("region", { name: "Suggested from today" });
    await section.getByRole("button", { name: /Review the launch checklist/ }).click();
    await expect.poll(() => backend.data.tomorrowTasks.map((task) => [task.outcome, task.estimatedMinutes]))
      .toEqual([["Review the launch checklist", 20]]);
    expect(backend.data.todayTasks).toEqual([]);
    const targets = backend.requests
      .filter((request) => request.path === "/functions/v1/task-suggestions")
      .map((request) => request.body.target);
    expect(targets).toEqual(["today", "tomorrow"]);
  });

  test("no section appears when there is nothing to propose", async ({ page }) => {
    await openPlanner(page);
    await expect(page.getByRole("region", { name: "Suggested from yesterday" })).toHaveCount(0);
  });
});
