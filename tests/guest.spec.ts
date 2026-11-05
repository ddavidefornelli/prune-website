import { test, expect } from "@playwright/test";

test("visitors can plan and reload without authentication or cloud requests", async ({ page }) => {
  const cloudRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("supabase.co")) cloudRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
  await expect(page.getByRole("textbox", { name: "Email address" })).toHaveCount(0);
  const outcome = page.getByRole("textbox", { name: "Outcome", exact: true });
  await expect(outcome).toBeFocused();
  await outcome.fill("Try prune without an account 45m");
  await expect(page.locator(".quick-entry-chip")).toHaveText("45 min");
  await outcome.press("Enter");
  await expect(page.getByText("Try prune without an account", { exact: true })).toBeVisible();
  await expect(page.locator(".starters")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Try prune without an account", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  expect(cloudRequests).toEqual([]);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeVisible();
  await page.getByRole("button", { name: "Continue without an account" }).click();
  await expect(page.getByText("Try prune without an account", { exact: true })).toBeVisible();
  expect(cloudRequests).toEqual([]);
});
