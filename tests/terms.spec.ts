import { test, expect, openSignIn } from "./helpers/browser";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../src/planner/privacy-state";

test("one agreement line covers the combined document, and pressing Google remembers it on this browser", async ({ page, backend }) => {
  await openSignIn(page);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  const hero = page.locator(".landing-hero");
  await expect(hero.getByText("By signing up, you agree to our Terms of Service and Privacy Policy.")).toBeVisible();
  await expect(page.getByText("Free to use. Automatic weekly reviews", { exact: false })).toHaveCount(0);
  // Both links open the same combined document.
  for (const name of ["Terms of Service", "Privacy Policy"]) {
    await hero.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Terms of use", exact: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeAttached();
    await expect(dialog).toContainText("There are no subscription fees or in-app purchases.");
    await expect(dialog).toContainText("Nothing in these terms excludes liability");
    await page.getByRole("button", { name: "Close privacy policy" }).click();
  }
  expect(backend.requests).toHaveLength(0);
  // Press Google, then back out there: the acceptance is still remembered.
  backend.googleCancelled = true;
  const google = page.getByRole("button", { name: "Continue with Google", exact: true }).first();
  await google.click();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  const record = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRIVACY_ACKNOWLEDGEMENT_KEY);
  expect(record.version).toBe(PRIVACY_POLICY_VERSION);
  await page.reload();
  await expect(google).toBeVisible();
  expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/authorize"))).toHaveLength(1);
});

test("the Google button at the bottom of the preview signs in the same way", async ({ page, backend }) => {
  await openSignIn(page);
  const bottom = page.locator(".preview-signup");
  await expect(bottom.getByText("By signing up, you agree to our Terms of Service and Privacy Policy.")).toBeAttached();
  await bottom.getByRole("button", { name: "Continue with Google", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  const record = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRIVACY_ACKNOWLEDGEMENT_KEY);
  expect(record.version).toBe(PRIVACY_POLICY_VERSION);
  expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/authorize"))).toHaveLength(1);
});
