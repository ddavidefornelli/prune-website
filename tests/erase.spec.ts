import { test, expect, addTask, newTask, openList, openMenu, savedList, synced, AUTH_KEY, LIST_KEY, PROJECT } from "./helpers/browser";

const erase = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Delete everything", exact: true });

test("Delete everything asks first, then erases the list here and in the cloud, and the next task starts a new guest", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Something private");
  await synced(page);
  await openMenu(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await erase(page).click();
  expect(backend.tasks).toHaveLength(1);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("can't be undone");
    void dialog.accept();
  });
  await erase(page).click();
  await expect(page.getByRole("checkbox", { name: "Something private" })).toHaveCount(0);
  await expect(newTask(page)).toBeVisible();
  expect(backend.tasks).toEqual([]);
  expect(backend.requests.some((request) => request.body.p_action === "erase")).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  expect(await savedList(page)).toBeNull();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await addTask(page, "A fresh start");
  await synced(page);
  expect(backend.guests).toHaveLength(1);
  expect((await savedList(page))?.owner).toBe(`${PROJECT}:${backend.guests[0]}`);
});

test("a failed erase keeps everything and allows a retry", async ({ page, backend }) => {
  await openList(page);
  await addTask(page, "Keep me for now");
  await synced(page);
  await openMenu(page);
  backend.offline = true;
  page.once("dialog", (dialog) => dialog.accept());
  await erase(page).click();
  await expect(page.getByRole("dialog", { name: "Menu" }).getByRole("alert")).toHaveText("Couldn't delete right now. Check your connection and try again.");
  await expect(erase(page)).toBeEnabled();
  expect(await savedList(page)).not.toBeNull();
  backend.offline = false;
  page.once("dialog", (dialog) => dialog.accept());
  await erase(page).click();
  await expect(page.getByRole("checkbox", { name: "Keep me for now" })).toHaveCount(0);
  expect(backend.tasks).toEqual([]);
});

test.describe("a browser that never synced", () => {
  test.use({ visitor: "new" });

  test("Delete everything just clears this browser", async ({ page, backend }) => {
    backend.guestsDisabled = true;
    await page.goto("/");
    await addTask(page, "Only here");
    await openMenu(page);
    page.once("dialog", (dialog) => dialog.accept());
    await erase(page).click();
    await expect(page.getByRole("checkbox", { name: "Only here" })).toHaveCount(0);
    expect(backend.requests.some((request) => request.body.p_action === "erase")).toBe(false);
    expect(await page.evaluate((key) => localStorage.getItem(key), LIST_KEY)).toBeNull();
  });
});

test.describe("an account from before guests", () => {
  test.use({ visitor: "account" });

  test("Delete everything erases its list and marks the account for removal", async ({ page, backend }) => {
    await openList(page);
    await addTask(page, "Old account's task");
    await synced(page);
    await openMenu(page);
    page.once("dialog", (dialog) => dialog.accept());
    await erase(page).click();
    await expect(page.getByRole("checkbox", { name: "Old account's task" })).toHaveCount(0);
    expect(backend.isDeleted).toBe(true);
    expect(backend.tasks).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  });

  test("a list whose account was deleted on another device is cleared here, quietly", async ({ page, backend }) => {
    await openList(page);
    await addTask(page, "Seen elsewhere");
    await synced(page);
    backend.isDeleted = true;
    backend.deletedAt = Math.floor(Date.now() / 1000) + 60;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByRole("checkbox", { name: "Seen elsewhere" })).toHaveCount(0);
    await expect(page.getByText(/deleted/i)).toHaveCount(0);
    expect(await savedList(page)).toBeNull();
    expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  });
});
