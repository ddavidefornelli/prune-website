import { test, expect, openPlanner, visitProfile, PROJECT } from "./helpers/browser";

const TOKEN = "22222222-2222-4222-8222-222222222222";

test.describe("signed in", () => {
  test.use({ signedIn: true });

  test("Profile turns each reminder email on or off and restores the switch when saving fails", async ({ page, backend }) => {
    await openPlanner(page);
    await visitProfile(page);
    const daily = page.getByRole("checkbox", { name: /Daily reminder/ });
    const comeback = page.getByRole("checkbox", { name: /Come-back reminder/ });
    await expect(daily).toBeChecked();
    await expect(comeback).toBeChecked();

    await daily.uncheck();
    await expect.poll(() => backend.emailPreferences).toEqual({ daily: false, comeback: true });
    await expect(daily).not.toBeChecked();
    await expect(comeback).toBeChecked();

    backend.offline = true;
    await comeback.click();
    await expect(page.getByText("Could not save.")).toBeVisible();
    await expect(comeback).toBeChecked();
    expect(backend.emailPreferences).toEqual({ daily: false, comeback: true });
  });
});

test("the unsubscribe link asks first, then turns that email off without signing in", async ({ page }) => {
  const calls: string[] = [];
  await page.route(`${PROJECT}/functions/v1/email-unsubscribe**`, async (route) => {
    calls.push(`${route.request().method()} ${new URL(route.request().url()).search}`);
    await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto(`/?unsubscribe=${TOKEN}&kind=daily`);
  await expect(page.getByRole("heading", { name: "Stop daily reminder emails?" })).toBeVisible();
  expect(calls).toEqual([]);
  await page.getByRole("button", { name: "Stop these emails", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Done." })).toBeVisible();
  expect(calls).toEqual([`POST ?token=${TOKEN}&kind=daily`]);
});

test("a malformed unsubscribe link opens the normal site", async ({ page }) => {
  await page.goto("/?unsubscribe=not-a-token&kind=daily");
  await expect(page.getByRole("heading", { name: /Stop .* emails\?/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Get started", exact: true }).first()).toBeVisible();
});
