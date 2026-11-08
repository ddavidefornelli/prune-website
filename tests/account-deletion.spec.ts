import { test, expect, AUTH_KEY, openPlanner } from "./helpers/browser";

test.use({ signedIn: true });

test("account deletion requires confirmation, flags the account and signs out", async ({ page, backend }) => {
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  expect(backend.isDeleted).toBe(false);
  expect(backend.requests.some((request) => request.body.p_action === "delete_account")).toBe(false);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
  await expect(page.locator(".profile-email")).toHaveCount(0);
  expect(backend.isDeleted).toBe(true);
  expect(backend.weekly.settings.enabled).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  const deletion = backend.requests.find((request) => request.body.p_action === "delete_account")!;
  expect(deletion.authorization).toMatch(/^Bearer /);
  expect(deletion.body.p_args._requestId).toBeUndefined();
});

test("a failed deletion keeps the user signed in and allows retry", async ({ page, backend }) => {
  await openPlanner(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  backend.offline = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeEnabled();
  expect(backend.isDeleted).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).not.toBeNull();
  backend.offline = false;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
  expect(backend.isDeleted).toBe(true);
});

test("a deleted account cannot restore a planner session", async ({ page, backend }) => {
  backend.isDeleted = true;
  await page.goto("/");
  await expect(page.getByText("This account has been marked for deletion and can no longer be used.", { exact: true })).toBeVisible();
  expect(backend.requests.some((request) => request.body.p_action === "dashboard")).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
});
