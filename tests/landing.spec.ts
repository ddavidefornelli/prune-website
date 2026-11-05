import { test, expect, AUTH_KEY, openSignIn, session } from "./helpers/browser";
import { PRIVACY_POLICY_VERSION, PRIVACY_ACKNOWLEDGEMENT_KEY } from "../src/planner/privacy-state";

const GOOGLE = { name: "Continue with Google", exact: true } as const;

test("signed-out visitors land on Google sign-in, and nothing else lets them in", async ({ page, backend }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("prune — Your day. Three priorities.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("DO LESS.ACHIEVE MORE.");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByRole("button", GOOGLE)).toBeVisible();
  // Email codes and the guest planner are gone on purpose: Google is the only way in.
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /email|without an account/i })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  expect(backend.requests).toEqual([]);
  expect(await page.locator("script[src*='googletagmanager'],script[src*='goatcounter'],script[src*='vercel-scripts']").count()).toBe(0);
});

test.describe("a first sign-in", () => {
  test.use({ firstVisit: true });

  test("needs the notice, signs in with Google, then opens the tour before the first task", async ({ page, backend }) => {
    await openSignIn(page);
    const google = page.getByRole("button", GOOGLE);
    await google.click();
    // The unchecked notice blocks sign-in.
    await expect(page).toHaveURL("http://127.0.0.1:4173/");
    expect(backend.requests).toEqual([]);
    await page.getByRole("checkbox").check();
    await google.click();

    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page).toHaveURL("http://127.0.0.1:4173/");
    const paths = backend.requests.map((request) => request.path);
    expect(paths[0]).toBe("/auth/v1/settings");
    const authorize = new URL(`https://fixture.test${paths.find((path) => path.startsWith("/auth/v1/authorize"))}`);
    expect(authorize.searchParams.get("provider")).toBe("google");
    expect(authorize.searchParams.get("redirect_to")).toBe("http://127.0.0.1:4173/?oauth=google");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
    expect(backend.requests.some((request) => request.path === "/auth/v1/token?grant_type=pkce" && request.body.auth_code === "fixture-oauth-code")).toBe(true);

    // A new account lands in the tour, then on the first-task prompt behind it.
    const tour = page.locator(".tour-popup");
    await expect(tour.getByRole("heading")).toHaveText("Three tasks a day");
    await tour.getByRole("button", { name: "Skip tour" }).click();
    await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
    await page.getByRole("region", { name: "Starting ideas" }).getByRole("button", { name: /Plan the week ahead/ }).click();
    await expect(page.getByRole("button", { name: "Edit task title: Plan the week ahead" })).toBeVisible();
    await expect(tour).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/authorize"))).toHaveLength(1);
  });
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

test("a cancelled Google sign-in returns to sign-in without private parameters", async ({ page, backend }) => {
  backend.googleCancelled = true;
  await openSignIn(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", GOOGLE).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  await expect(page.locator("body")).not.toContainText("private-diagnostic");
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  // The notice was accepted on the way out, so only the button remains.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", GOOGLE)).toBeEnabled();
  expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/token"))).toEqual([]);
});

test("a disabled Google provider fails with a clear message instead of leaving the site", async ({ page, backend }) => {
  backend.googleDisabled = true;
  await openSignIn(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", GOOGLE).click();
  await expect(page.getByRole("alert")).toHaveText("Google sign-in isn't available right now. Please try again later.");
  await expect(page.getByRole("button", GOOGLE)).toBeEnabled();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  expect(backend.requests.map((request) => request.path)).toEqual(["/auth/v1/settings"]);
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
  await page.getByRole("checkbox").check();
  await page.getByRole("button", GOOGLE).click();
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
    const google = page.getByRole("button", GOOGLE);
    await google.evaluate((button) => button.scrollIntoView({ block: "center" }));
    await expect(google).toBeInViewport({ ratio: 1 });
    expect((await google.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});
