import { test } from "./helpers/browser";

/**
 * Not a test: opens the onboarding as a brand-new account against the mock
 * backend and pauses so you can click through it by hand.
 *
 *   ONBOARDING_DEMO=1 npx playwright test tests/demo-onboarding.spec.ts --project=chromium --headed
 */
test.skip(!process.env.ONBOARDING_DEMO, "Manual demo; set ONBOARDING_DEMO=1.");
test.use({ signedIn: true, firstVisit: true });

test("onboarding demo", async ({ page }) => {
  test.setTimeout(0);
  await page.setViewportSize({ width: 1100, height: 844 });
  await page.goto("/");
  await page.pause();
});
