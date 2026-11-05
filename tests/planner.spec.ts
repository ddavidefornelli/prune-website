import { test, expect, openPlanner, visitProfile, addTask, synced, pendingCount, QUEUE_KEY, AUTH_KEY } from "./helpers/browser";

test.use({ signedIn: true });

test("empty plans stay minimal with a single planner navigation", async ({ page }) => {
  await openPlanner(page);
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.locator(".site-header, .account-bar")).toHaveCount(0);
  for (const view of ["Today", "Tomorrow"]) {
    await page.getByRole("navigation").getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("main", { name: view, exact: true })).toBeVisible();
    await expect(page.locator(".empty-plan")).toHaveCount(0);
    await expect(page.getByText("Choose up to three outcomes.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add task", exact: true })).toBeVisible();
  }
});

test("task entry uses an inline desktop estimate and a cancellable mobile estimate dialog", async ({ page, backend }) => {
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await openPlanner(page);
    const form = page.locator(".task-form");
    const input = (await form.locator("input").boundingBox())!;
    const add = (await form.getByRole("button", { name: "Add task", exact: true }).boundingBox())!;
    expect(input.x + input.width).toBeLessThanOrEqual(add.x);
    expect(Math.abs(input.y - add.y)).toBeLessThanOrEqual(2);
    if (width >= 760) {
      const dial = (await form.getByRole("slider").boundingBox())!;
      expect(dial.x).toBeGreaterThanOrEqual(input.x + input.width);
      expect(dial.x + dial.width).toBeLessThanOrEqual(add.x);
      expect(Math.abs(dial.y - add.y)).toBeLessThanOrEqual(2);
    } else {
      await expect(form.getByRole("slider")).toHaveCount(0);
      await form.getByRole("textbox", { name: "Outcome", exact: true }).fill("Keep my draft");
      await form.getByRole("button", { name: "Add task", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "How much time will this task take to complete?" });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await dialog.getByRole("slider").press("ArrowUp");
      await expect(dialog.getByRole("slider")).toHaveAttribute("aria-valuenow", "35");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(form.getByRole("textbox", { name: "Outcome", exact: true })).toHaveValue("Keep my draft");
      expect(backend.requests.filter((request) => request.body.p_action === "create_task")).toHaveLength(0);
      await form.getByRole("button", { name: "Add task", exact: true }).click();
      await dialog.getByRole("button", { name: "Add task", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit task title: Keep my draft" })).toBeVisible();
      await synced(page);
      expect(backend.data.todayTasks[0]!.estimatedMinutes).toBe(35);
    }
  }
});

test("equal tasks can start in any order without choosing a main task", async ({ page, backend }) => {
  await openPlanner(page);
  for (const title of ["First equal task", "Second equal task", "Third equal task"]) {
    await addTask(page, title);
    await synced(page);
  }
  await expect(page.locator(".task-crown, .task.is-priority")).toHaveCount(0);
  for (const start of await page.getByRole("button", { name: "Start focus", exact: true }).all()) {
    await expect(start).toBeEnabled();
  }
  await page.locator(".task").filter({ hasText: "Second equal task" })
    .getByRole("button", { name: "Start focus", exact: true }).click();
  await synced(page);
  await expect(page.locator("#focus-timer")).toBeVisible();
  expect(backend.data.activeTask?.outcome).toBe("Second equal task");
  expect(backend.requests.some((request) => request.body.p_action === "prioritize_task")).toBe(false);
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await synced(page);
  await expect(page.getByRole("button", { name: "Start focus", exact: true })).toHaveCount(2);
  await expect(page.locator(".crown-celebration")).toHaveCount(0);
});

test("plans three equal tasks, starts the second, pauses with a reason and completes", async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlanner(page);
  for (const title of ["Write the proposal", "Ship the update", "Read a chapter"]) { await addTask(page, title); await synced(page); }
  await expect(page.getByRole("button", { name: "Add task", exact: true })).toHaveCount(0);
  const second = page.locator(".task").filter({ hasText: "Ship the update" });
  await expect(page.locator(".task-crown, .task.is-priority")).toHaveCount(0);
  for (const start of await page.getByRole("button", { name: "Start focus", exact: true }).all()) {
    await expect(start).toBeEnabled();
  }
  await second.getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(page.locator("#focus-timer")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Today", exact: true })).toBeDisabled();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Profile", exact: true })).toHaveCount(0);
  await expect(page.locator("#focus-timer")).toBeEnabled();
  await page.locator("#focus-timer").click();
  await expect(page.getByRole("dialog", { name: "Why are you stopping?" })).toBeVisible();
  await page.getByRole("textbox", { name: "Why are you stopping?" }).fill("Taking a proper break");
  await page.getByRole("button", { name: "Save reason", exact: true }).click();
  await expect(page.locator(".pause-dialog")).toHaveCount(0);
  await expect(page.locator("#focus-timer")).toHaveClass(/is-paused/);
  await expect.poll(() => backend.stops).toContain("Taking a proper break");
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Private scratchpad, not synced");
  await page.locator("#focus-timer").click();
  await expect(page.locator("#focus-timer")).not.toHaveClass(/is-paused/);
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await expect(page.getByRole("main", { name: "Today", exact: true })).toBeVisible();
  await synced(page);
  await expect(page.locator(".task").filter({ hasText: "Ship the update" })).toContainText("completed");
  expect(JSON.stringify(backend.requests)).not.toContain("Private scratchpad");
  expect(backend.data.completions).toEqual([{ day: backend.data.today, count: 1 }]);
});

test("Tomorrow is available immediately; titles and estimates persist through reload", async ({ page }) => {
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await addTask(page, "Prepare tomorrow");
  await synced(page);
  await page.getByRole("button", { name: "Edit task title: Prepare tomorrow" }).click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill("Prepare a calmer tomorrow");
  await page.getByRole("textbox", { name: "Task title", exact: true }).press("Enter");
  await synced(page);
  const slider = page.locator(".task").getByRole("slider");
  await slider.focus();
  await slider.press("ArrowUp");
  await expect(slider).toHaveAttribute("aria-valuenow", "35");
  await synced(page);
  await page.reload();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit task title: Prepare a calmer tomorrow" })).toBeVisible();
  await expect(page.locator(".task").getByRole("slider")).toHaveAttribute("aria-valuenow", "35");
});

test("Mac resource metadata remains inert and is preserved when editing a task on the web", async ({ page, backend }) => {
  const resources = [
    { id: "local-file", kind: "file" as const, label: "Notes.pdf", target: "/Users/me/Notes.pdf" },
    { id: "hostile-link", kind: "link" as const, label: "Untrusted link", target: "javascript:alert(document.cookie)" },
  ];
  backend.data.todayTasks.push({ id: "local-task", outcome: "Read a trusted document", plannedFor: backend.data.today, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: backend.data.serverNow, isPriority: true, resources: structuredClone(resources) });
  await openPlanner(page);
  await expect(page.locator('a[href^="file:"], a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText("/Users/me/Notes.pdf", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Add a link; press Enter to save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach file", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit task title: Read a trusted document" }).click();
  await page.getByRole("textbox", { name: "Task title", exact: true }).fill("Read it in the Mac app");
  await page.getByRole("textbox", { name: "Task title", exact: true }).press("Enter");
  await synced(page);
  expect(backend.data.todayTasks[0]!.resources).toEqual(resources);
});

test("offline actions survive reload and sync in order without storing tokens in the outbox", async ({ page, backend }) => {
  await openPlanner(page);
  await synced(page);
  backend.offline = true;
  await addTask(page, "Work through a connection loss");
  await expect.poll(() => pendingCount(page)).toBe(1);
  expect(backend.data.todayTasks).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit task title: Work through a connection loss" })).toBeVisible();
  const raw = await page.evaluate((key) => localStorage.getItem(key)!, QUEUE_KEY);
  expect(raw).not.toContain("access_token");
  expect(raw).not.toContain("refresh_token");
  backend.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await synced(page);
  expect(backend.data.todayTasks).toHaveLength(1);
  expect(backend.data.todayTasks[0]!.outcome).toBe("Work through a connection loss");
});

test("a lost response retries the same mutation identity without creating a duplicate task", async ({ page, backend }) => {
  await openPlanner(page);
  backend.loseNextAcknowledgement = true;
  await addTask(page, "Only once");
  await expect.poll(() => backend.data.todayTasks.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await synced(page);
  const writes = backend.requests.filter((request) => request.body.p_action === "create_task");
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(new Set(writes.map((request) => request.body.p_args._requestId)).size).toBe(1);
  expect(backend.data.todayTasks).toHaveLength(1);
});

test("a broken success response cannot erase a pending action", async ({ page, backend }) => {
  await openPlanner(page);
  backend.malformedAcknowledgement = true;
  await addTask(page, "Keep the outbox safe");
  await expect.poll(() => backend.data.todayTasks.length).toBe(1);
  await expect.poll(() => pendingCount(page)).toBe(1);
  backend.malformedAcknowledgement = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await synced(page);
  expect(backend.data.todayTasks).toHaveLength(1);
});

test("rejected cross-device changes stay visible until explicitly discarded", async ({ page, backend }) => {
  await openPlanner(page);
  backend.rejectWrites = true;
  await addTask(page, "A conflicting edit");
  await expect(page.locator(".sync-bar")).toBeVisible();
  await expect.poll(() => pendingCount(page)).toBe(1);
  expect(backend.data.todayTasks).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard rejected changes", exact: true }).click();
  await expect(page.locator(".sync-bar")).toBeHidden();
  await expect.poll(() => pendingCount(page)).toBe(0);
  await expect(page.locator(".task")).toHaveCount(0);
});

test("weekly reviews are automatic, cannot be turned off, and have no manual preview", async ({ page, backend }) => {
  await openPlanner(page);
  expect(backend.requests.filter((request) => request.path.includes("/functions/v1/weekly-review"))).toHaveLength(0);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  expect(backend.weekly.settings.enabled).toBe(true);
  await expect(page.locator(".review-countdown")).toBeVisible();
  await expect(page.getByRole("button", { name: /weekly reviews/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.locator(".profile-page").getByText(/weekly review/i)).toHaveCount(0);
  await expect(page.locator(".profile-page").getByRole("button", { name: "Terms & Privacy", exact: true })).toBeVisible();
  expect(backend.requests.some((request) => request.body.p_action === "set_weekly_ai_enabled")).toBe(false);
  await expect(page.getByRole("button", { name: "Preview this week", exact: true })).toHaveCount(0);
  await expect(page.locator(".review-preview")).toHaveCount(0);
  expect(backend.requests.filter((request) => request.path.includes("/functions/") && request.body.preview)).toHaveLength(0);
  expect(backend.weekly.reviews).toHaveLength(0);
  await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
  await addTask(page, "AI outages do not block work");
  await synced(page);
});

test("an account that turned reviews off earlier can turn them back on, but not off again", async ({ page, backend }) => {
  backend.weekly.settings.enabled = false;
  backend.weekly.status = "disabled";
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Weekly reviews are off for this account.")).toBeVisible();
  await expect(page.getByText("Once on, they can’t be turned off.")).toBeVisible();
  await expect(page.locator(".review-countdown")).toHaveCount(0);
  await page.getByRole("button", { name: "Turn on weekly reviews", exact: true }).click();
  await expect.poll(() => backend.weekly.settings.enabled).toBe(true);
  await expect(page.locator(".review-countdown")).toBeVisible();
  await expect(page.getByRole("button", { name: /weekly reviews/ })).toHaveCount(0);
});

test("profile stats and local-only sign-out preserve pending work and sign out other web tabs", async ({ page, context, backend }) => {
  await openPlanner(page);
  await addTask(page, "Remember this task");
  await synced(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("button", { name: "Edit task title: Remember this task" })).toBeVisible();
  const requests = backend.requests.length;
  await page.waitForTimeout(300);
  expect(backend.requests.length - requests, "Storage updates must not cause a cross-tab request loop").toBeLessThan(10);
  backend.offline = true;
  await addTask(page, "Unsynced work is retained");
  await expect.poll(() => pendingCount(page)).toBe(1);
  await visitProfile(page);
  await expect(page.locator(".profile-email")).toHaveText("user@example.com");
  await expect(page.getByRole("heading", { name: "All time", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Unsynced work is retained");
  await expect(second.locator("body")).not.toContainText("Remember this task");
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), QUEUE_KEY))!).pending).toHaveLength(1);
  expect(backend.requests.some((request) => request.path === "/auth/v1/logout?scope=local")).toBe(true);
  await second.close();
});

test("mobile task, focus, profile and overview layouts have no page-level horizontal overflow", async ({ page }) => {
  await openPlanner(page);
  for (const title of ["A task with a deliberately long outcome that wraps gracefully on a small phone", "Second meaningful task", "Third meaningful task"]) { await addTask(page, title); await synced(page); }
  for (const viewport of [{ width: 280, height: 568 }, { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    for (const view of ["Overview", "Tomorrow", "Today"]) {
      await page.getByRole("navigation").getByRole("button", { name: view, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${view} at ${viewport.width}`).toBeLessThanOrEqual(viewport.width);
    }
    await visitProfile(page);
    await expect(page.locator(".profile-page")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator(".task").first().getByRole("button", { name: "Start focus", exact: true }).click();
  await expect(page.locator("#focus-timer")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Complete task", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Complete task", exact: true })).toBeInViewport({ ratio: 1 });
});

test.describe("expired browser sessions", () => {
  test.use({ expired: true });
  test("refreshes the session before loading the planner without another Google sign-in", async ({ page, backend }) => {
    await openPlanner(page);
    expect(backend.requests.some((request) => request.path === "/auth/v1/token?grant_type=refresh_token")).toBe(true);
    expect(backend.requests.some((request) => request.path.startsWith("/auth/v1/authorize"))).toBe(false);
    const rpc = backend.requests.find((request) => request.path.includes("/rpc/"))!;
    expect(rpc.authorization).toMatch(/^Bearer /);
  });
});
