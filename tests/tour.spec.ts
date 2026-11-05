import { test, expect, openPlanner, synced } from "./helpers/browser";

test.use({ signedIn: true, firstVisit: true });

for (const width of [1100, 390]) {
  test(`the first task opens an anchored tour, not focus, at ${width}px`, async ({ page, backend }) => {
    await page.setViewportSize({ width, height: 844 });
    await openPlanner(page);
    await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Outcome", exact: true }).fill("Write a first draft");
    await page.locator(".task-form").getByRole("button", { name: "Add task", exact: true }).click();
    // Phones confirm the estimate in a sheet before the task is created.
    if (width < 760) await page.getByRole("dialog", { name: /How much time/ }).getByRole("button", { name: "Add task" }).click();
    const tour = page.locator(".planner-tour-dialog");
    const popup = page.locator(".tour-popup");
    await expect(popup).toBeVisible();
    await synced(page);
    await expect.poll(() => backend.data.todayTasks.length).toBe(1);
    for (const [index, view] of ["today", "today", "tomorrow", "habits", "today"].entries()) {
      await expect(page.locator("#app")).toHaveAttribute("data-view", view);
      await expect(popup).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".tour-highlight")).toBeInViewport({ ratio: 1 });
      await expect(tour).not.toContainText("Profile");
      expect(backend.data.activeTask).toBeNull();
      expect(backend.requests.filter((request) => request.body.p_action === "start_task")).toHaveLength(0);
      if (index === 1) {
        await popup.getByRole("button", { name: "Back", exact: true }).click();
        await expect(popup.getByRole("heading")).toHaveText("Your task is here");
        await popup.getByRole("button", { name: "Next", exact: true }).click();
      }
      if (index < 4) {
        await expect(popup.getByRole("button", { name: "Start focusing" })).toHaveCount(0);
        await popup.getByRole("button", { name: "Next", exact: true }).click();
      }
    }
    await popup.getByRole("button", { name: "Not now" }).click();
    await expect(tour).toHaveCount(0);
    await expect(page.locator("#app")).toHaveAttribute("data-view", "today");
    expect(backend.data.activeTask).toBeNull();
    await page.reload();
    await expect(page.locator(".task")).toHaveCount(1);
    await expect(tour).toHaveCount(0);
  });
}

test("the tour's last stop starts the first task", async ({ page, backend }) => {
  await openPlanner(page);
  await page.getByRole("region", { name: "Starting ideas" })
    .getByRole("button", { name: /Plan the week ahead/ }).click();
  const popup = page.locator(".tour-popup");
  for (let step = 0; step < 4; step++) await popup.getByRole("button", { name: "Next", exact: true }).click();
  await popup.getByRole("button", { name: "Start focusing" }).click();
  await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expect.poll(() => backend.data.activeTask).not.toBeNull();
});
