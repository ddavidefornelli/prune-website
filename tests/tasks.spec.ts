import { test, expect, addTask, cloudTask, openList, savedList, synced, LIST_KEY } from "./helpers/browser";

// Most tests are a returning guest; the first visit has its own spec.

const input = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "New task", exact: true });
const todo = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "To do" });

test("a typed task goes to the top of the list and reaches the cloud", async ({ page, backend }) => {
  await openList(page);
  // On a laptop the page opens ready to type.
  await expect(input(page)).toBeFocused();
  await addTask(page, "Buy milk");
  await addTask(page, "  Call   the dentist  ");
  await expect(todo(page).locator(".task-title")).toHaveText(["Call the dentist", "Buy milk"]);
  await expect(input(page)).toBeFocused();
  // Nothing to add: Enter on an empty field does nothing.
  await input(page).press("Enter");
  await expect(todo(page).getByRole("listitem")).toHaveCount(2);
  await synced(page);
  expect(backend.tasks.map((task) => task.title).sort()).toEqual(["Buy milk", "Call the dentist"]);
});

test("ticking a task moves it to Done, and unticking brings it back", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Send the invoice");
  await page.getByRole("checkbox", { name: "Send the invoice" }).check();
  // It stays in place for a moment, ticked, then folds into Done.
  await expect(todo(page).getByRole("checkbox", { name: "Send the invoice" })).toBeChecked();
  await expect(todo(page).getByRole("listitem")).toHaveCount(0);
  const toggle = page.getByRole("button", { name: /^Done/ });
  await expect(toggle).toHaveText("Done 1");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await synced(page);
  expect(backend.tasks[0].done).toBe(true);
  expect(backend.tasks[0].doneAt).toEqual(expect.any(Number));

  await toggle.click();
  // Unticked, it goes straight back to the list (a click: the row moves away).
  await page.getByRole("list", { name: "Done tasks" }).getByRole("checkbox", { name: "Send the invoice" }).click();
  await expect(todo(page).getByRole("checkbox", { name: "Send the invoice" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /^Done/ })).toHaveCount(0);
  await synced(page);
  expect(backend.tasks[0]).toMatchObject({ done: false, doneAt: null });
});

test("tapping the words edits them: Enter saves, Escape cancels, empty deletes", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Book flights");
  await page.getByRole("button", { name: "Edit Book flights", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Task", exact: true });
  await expect(editor).toBeFocused();
  await editor.fill("Book flights to Lisbon");
  await editor.press("Enter");
  await expect(page.getByRole("button", { name: "Edit Book flights to Lisbon", exact: true })).toBeFocused();
  await synced(page);
  expect(backend.tasks[0].title).toBe("Book flights to Lisbon");

  await page.getByRole("button", { name: "Edit Book flights to Lisbon" }).click();
  await editor.fill("Something else");
  await editor.press("Escape");
  await expect(page.getByRole("checkbox", { name: "Book flights to Lisbon" })).toBeVisible();

  await page.getByRole("button", { name: "Edit Book flights to Lisbon" }).click();
  await editor.fill("");
  await editor.press("Enter");
  await expect(todo(page).getByRole("listitem")).toHaveCount(0);
  await expect(page.getByText("Task deleted")).toBeVisible();
});

test("delete offers Undo, which puts the task back as it was", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Water the plants");
  await addTask(page, "Pay rent");
  await page.getByRole("checkbox", { name: "Pay rent" }).hover();
  await page.getByRole("button", { name: "Delete Pay rent", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Pay rent" })).toHaveCount(0);
  await synced(page);
  expect(backend.tasks.map((task) => task.title)).toEqual(["Water the plants"]);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  // Back in its old place, on top.
  await expect(todo(page).locator(".task-title")).toHaveText(["Pay rent", "Water the plants"]);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await synced(page);
  expect(backend.tasks.map((task) => task.title).sort()).toEqual(["Pay rent", "Water the plants"]);
});

test.describe("with done tasks", () => {
  test.use({ seed: { tasks: [cloudTask("Open task"), cloudTask("Older done", { done: true, doneAt: Date.now() - 120_000 }), cloudTask("Newer done", { done: true, doneAt: Date.now() - 60_000 })] } });

  test("Done folds away, and Clear removes every done task with Undo", async ({ page, backend }) => {
    await openList(page);
    await expect(page.getByRole("list", { name: "Done tasks" })).toHaveCount(0);
    await page.getByRole("button", { name: "Done 2" }).click();
    const done = page.getByRole("list", { name: "Done tasks" });
    // Most recently finished first.
    await expect(done.locator(".task-title")).toHaveText(["Newer done", "Older done"]);
    await page.getByRole("button", { name: "Clear done tasks", exact: true }).click();
    await expect(page.getByText("2 tasks cleared")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Done/ })).toHaveCount(0);
    await synced(page);
    expect(backend.tasks.map((task) => task.title)).toEqual(["Open task"]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Done 2" })).toBeVisible();
    await synced(page);
    expect(backend.tasks).toHaveLength(3);
  });
});

test.describe("an existing list", () => {
  test.use({ seed: { tasks: [cloudTask("Older", {}, 30), cloudTask("Newer", {}, 5)] } });

  test("opens newest first, and edits from another device arrive", async ({ page, backend }) => {
    await openList(page);
    await expect(todo(page).locator(".task-title")).toHaveText(["Newer", "Older"]);
    // Elsewhere: one renamed, one ticked, one new.
    const [older, newer] = backend.tasks;
    backend.tasks = [
      { ...older, title: "Older, renamed", updatedAt: Date.now() },
      { ...newer, done: true, doneAt: Date.now(), updatedAt: Date.now() },
      cloudTask("From my phone", {}, 0),
    ];
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(todo(page).locator(".task-title")).toHaveText(["From my phone", "Older, renamed"]);
    await expect(page.getByRole("button", { name: "Done 1" })).toBeVisible();
  });

  test("works offline from this device and saves when the network is back", async ({ page, backend }) => {
    await openList(page);
    backend.offline = true;
    await addTask(page, "Written on the train");
    await page.getByRole("checkbox", { name: "Older" }).check();
    // Nothing to say about it: the list on this device is the one that counts.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/offline|not saved|could not/i)).toHaveCount(0);
    // A reload while offline still shows everything, from this device.
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Written on the train" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Done 1" })).toBeVisible();
    expect(backend.tasks.find((task) => task.title === "Written on the train")).toBeUndefined();
    backend.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await synced(page);
    expect(backend.tasks.map((task) => task.title).sort()).toEqual(["Newer", "Older", "Written on the train"]);
    expect(backend.tasks.find((task) => task.title === "Older")?.done).toBe(true);
  });

  test("two tabs share one list without losing each other's edits", async ({ page, context, backend }) => {
    await openList(page);
    const other = await context.newPage();
    await openList(other);
    await addTask(other, "Added in the second tab");
    await expect(page.getByRole("checkbox", { name: "Added in the second tab" })).toBeVisible();
    await addTask(page, "Added in the first tab");
    await expect(other.getByRole("checkbox", { name: "Added in the first tab" })).toBeVisible();
    await synced(page);
    expect(backend.tasks.map((task) => task.title).sort()).toEqual(["Added in the first tab", "Added in the second tab", "Newer", "Older"]);
    await other.close();
  });
});

test("a full list says so, and keeps what it already has", async ({ page, backend }) => {
  await openList(page);
  backend.full = true;
  await input(page).fill("One too many");
  await input(page).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Your list is full. Delete some tasks to add more." })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "One too many" })).toHaveCount(0);
  expect((await savedList(page))?.pending).toEqual({});
});

test("five open tasks at a time: a sixth waits until one is done", async ({ page }) => {
  await openList(page);
  for (const title of ["One", "Two", "Three", "Four", "Five"]) await addTask(page, title);
  await input(page).fill("Six");
  await input(page).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Five tasks at a time. Finish one to add another." })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Six", exact: true })).toHaveCount(0);
  await expect(input(page)).toHaveValue("Six");
  await page.getByRole("checkbox", { name: "One", exact: true }).click();
  await input(page).press("Enter");
  await expect(page.getByRole("checkbox", { name: "Six", exact: true })).toBeVisible();
  // A done task cannot come back while five are open.
  await page.getByRole("button", { name: "Done 1" }).click();
  await page.getByRole("checkbox", { name: "One", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Five tasks at a time." })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "One", exact: true })).toBeChecked();
});

test("a change the cloud refuses is dropped quietly, and the list carries on", async ({ page, backend }) => {
  await openList(page);
  backend.failSyncs = { status: 400, body: { code: "PT400", message: "Some changes could not be read. Reload and try again." } };
  await input(page).fill("Refused");
  await input(page).press("Enter");
  await expect.poll(async () => Object.keys((await savedList(page))?.pending ?? {}).length).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  backend.failSyncs = null;
  await addTask(page, "Accepted");
  await synced(page);
  expect(backend.tasks.map((task) => task.title)).toEqual(["Accepted"]);
});

test("titles are shown as text, never as markup", async ({ page, backend }) => {
  await openList(page);
  const title = `<img src=x onerror="window.__xss=1"><b>bold</b>`;
  await addTask(page, title);
  await expect(page.getByRole("button", { name: `Edit ${title}`, exact: true })).toHaveText(title);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator(".tasks img, .tasks b").count()).toBe(0);
  await synced(page);
  expect(backend.tasks[0].title).toBe(title);
});

test("the list is saved once per browser, and nothing older is kept", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pro:planner:v1:old", "{}");
    localStorage.setItem("prune:tour:v1:old", "done");
    localStorage.setItem("prune:tasks:v1:old", "{}");
  });
  await openList(page);
  await addTask(page, "Mine");
  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(keys).toContain(LIST_KEY);
  expect(keys.filter((key) => /^(pro:planner|prune:tour|prune:tasks):/.test(key))).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  test("everything fits a narrow screen and every control is easy to tap", async ({ page }) => {
    await openList(page);
    // A phone does not raise the keyboard on arrival.
    await expect(input(page)).not.toBeFocused();
    await addTask(page, "A long task title that keeps going well past the width of a small phone screen");
    await addTask(page, "Short");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    // Delete is hidden until the words are tapped.
    const remove = page.getByRole("button", { name: "Delete Short", exact: true });
    await expect(remove).toHaveCSS("opacity", "0");
    await page.getByRole("button", { name: "Edit Short", exact: true }).tap();
    await expect(remove).toHaveCSS("opacity", "1");
    for (const control of [page.getByRole("checkbox", { name: "Short" }), remove, page.getByRole("button", { name: "Menu" }), page.getByRole("button", { name: "Add task" })]) {
      const box = (await control.boundingBox())!;
      expect(Math.min(box.width, box.height), (await control.getAttribute("aria-label")) ?? "").toBeGreaterThanOrEqual(44);
    }
    await remove.tap();
    await expect(page.getByRole("checkbox", { name: "Short" })).toHaveCount(0);
  });
});
