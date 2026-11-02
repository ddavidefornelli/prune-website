import { test, expect, AUTH_KEY, openSignIn, showSignIn, session } from "./helpers/browser";
import { PRIVACY_POLICY_VERSION, PRIVACY_ACKNOWLEDGEMENT_KEY } from "../src/planner/privacy-state";

test("home opens the guest planner; sign-in requires an unchecked notice", async ({ page, backend }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("prune — Your day. Three priorities.");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email address" })).toHaveCount(0);
  expect(backend.requests).toEqual([]);
  await showSignIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("DO LESS.ACHIEVE MORE.");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeVisible();
  // Google sign-in now exists on purpose, but only on the onboarding survey's
  // Save screen (tests/survey.spec.ts). Overview's sign-in stays email-only.
  await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
  expect(backend.requests).toEqual([]);
  expect(await page.locator("script[src*='googletagmanager'],script[src*='goatcounter'],script[src*='vercel-scripts']").count()).toBe(0);
});

test("email-code sign-in handles invalid codes then restores the session without another email", async ({ page, backend }) => {
  await openSignIn(page);
  await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Email me a sign-in code", exact: true }).click();
  expect(backend.requests).toHaveLength(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email me a sign-in code", exact: true }).click();
  const code = page.getByLabel("Email code", { exact: true });
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.locator(".email-code-digit")).toHaveCount(8);
  await expect(page.locator("#signup-title")).toBeHidden();
  await expect(page.locator(".auth-description")).toBeHidden();
  await code.fill("00000000");
  await expect(page.locator(".email-code-digit")).toHaveText(Array(8).fill("0"));
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Check your email and code");
  await expect(page.getByRole("alert")).not.toContainText("private upstream error");
  await code.fill("12345678");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  const requests = backend.requests.filter((request) => request.path === "/auth/v1/verify");
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toMatchObject({ email: "user@example.com", token: "12345678", type: "email" });
  // Signing in returns to the page it started from, here Overview.
  await expect(page.getByRole("main", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Signed in." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  expect(backend.requests.filter((request) => request.path === "/auth/v1/otp")).toHaveLength(1);
  const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  expect(saved).not.toContain("12345678");
  const plannerRequests = backend.requests.filter((request) => request.path.includes("/rpc/") || request.path.includes("/functions/"));
  expect(JSON.stringify(plannerRequests.map((request) => request.body))).not.toContain("12345678");
});

test("an existing Google callback exchanges the code and removes it from the URL", async ({ page, backend }) => {
  await page.addInitScript(({ key, version }) => {
    localStorage.setItem(key, JSON.stringify({ version, acknowledgedAt: new Date().toISOString() }));
  }, { key: PRIVACY_ACKNOWLEDGEMENT_KEY, version: PRIVACY_POLICY_VERSION });
  await page.addInitScript((authKey) => {
    localStorage.setItem(`${authKey}-code-verifier`, JSON.stringify("fixture-pkce-verifier"));
  }, AUTH_KEY);
  await page.goto("/?oauth=google&code=fixture-oauth-code");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  expect(backend.requests.some((request) => request.path === "/auth/v1/token?grant_type=pkce" && request.body.auth_code === "fixture-oauth-code")).toBe(true);
  expect(backend.requests.some((request) => request.path === "/auth/v1/user")).toBe(true);
});

test("callback cancellation clears private parameters and leaves guest planning usable", async ({ page, backend }) => {
  await page.addInitScript(({ key, version }) => {
    localStorage.setItem(key, JSON.stringify({ version, acknowledgedAt: new Date().toISOString() }));
  }, { key: PRIVACY_ACKNOWLEDGEMENT_KEY, version: PRIVACY_POLICY_VERSION });
  await page.goto("/?oauth=google&error=access_denied&error_description=private-diagnostic");
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await showSignIn(page);
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  await expect(page.locator("body")).not.toContainText("private-diagnostic");
  expect(backend.requests).toHaveLength(0);
});

test("privacy storage failure sends no account request and does not claim signup succeeded", async ({ page, backend }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "prune:privacy:acknowledgement") throw new DOMException("Storage denied", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await openSignIn(page);
  await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByRole("alert")).toContainText("No sign-in request was sent");
  expect(backend.requests).toHaveLength(0);
});

test("an outdated notice gates saved sessions and the full policy is available before sign-in", async ({ page, backend }) => {
  await page.addInitScript(({ authKey, savedSession, privacyKey }) => {
    localStorage.setItem(authKey, JSON.stringify(savedSession));
    localStorage.setItem(privacyKey, JSON.stringify({ version: "privacy-old", acknowledgedAt: new Date().toISOString() }));
  }, { authKey: AUTH_KEY, savedSession: session(), privacyKey: PRIVACY_ACKNOWLEDGEMENT_KEY });
  await openSignIn(page);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "Terms & Privacy", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText("browser's localStorage");
  await expect(page.getByRole("dialog")).toContainText("not macOS Keychain");
  await page.getByRole("button", { name: "Close privacy policy" }).click();
  expect(backend.requests).toHaveLength(0);
});

test("failed sign-in stays on the email form without exposing upstream errors", async ({ page, backend }) => {
  backend.failSignIn = true;
  await openSignIn(page);
  await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByRole("alert")).toContainText(/unavailable|Could not reach/);
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeEnabled();
});

test("the existing direct download page works without account services", async ({ page, backend }) => {
  const downloadPromise = page.waitForEvent("download");
  await page.goto("/download");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("prune.dmg");
  expect(await download.failure()).toBeNull();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("THANK YOU FOR INSTALLING");
  expect(backend.requests).toHaveLength(0);
});

test("signup fits narrow phones and scrolls naturally in short landscape windows", async ({ page }) => {
  await openSignIn(page);
  for (const viewport of [
    { width: 280, height: 568 }, { width: 320, height: 568 }, { width: 375, height: 667 },
    { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 568, height: 320 },
    { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `No overflow at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("button", { name: "Email me a sign-in code" }).evaluate((button) => button.scrollIntoView({ block: "center" }));
    await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeInViewport({ ratio: 1 });
    expect(await page.getByRole("textbox", { name: "Email address" }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});
