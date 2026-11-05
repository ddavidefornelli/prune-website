import { test, expect, openSignIn } from "./helpers/browser";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../src/planner/privacy-state";

test("one terms checkbox covers the combined document and is remembered on this browser", async ({ page, backend }) => {
  await openSignIn(page);
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByText("Free to use. Automatic weekly reviews", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Terms & Privacy", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Terms of use", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeAttached();
  await expect(dialog).toContainText("There are no subscription fees or in-app purchases.");
  await expect(dialog).toContainText("Nothing in these terms excludes liability");
  await page.getByRole("button", { name: "Close privacy policy" }).click();
  const google = page.getByRole("button", { name: "Continue with Google", exact: true });
  await google.click();
  expect(backend.requests).toHaveLength(0);
  // Accept, then back out at Google: the acceptance is still remembered.
  backend.googleCancelled = true;
  await page.getByRole("checkbox").check();
  await google.click();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  const record = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRIVACY_ACKNOWLEDGEMENT_KEY);
  expect(record.version).toBe(PRIVACY_POLICY_VERSION);
  await page.reload();
  await expect(google).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeHidden();
  expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/authorize"))).toHaveLength(1);
});
