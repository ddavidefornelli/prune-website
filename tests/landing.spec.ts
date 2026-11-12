import { test, expect, AUTH_KEY, openSignIn, session, finishTour } from "./helpers/browser";
import { PRIVACY_POLICY_VERSION, PRIVACY_ACKNOWLEDGEMENT_KEY } from "../src/planner/privacy-state";

const GOOGLE = { name: "Continue with Google", exact: true } as const;

test("the landing page is the title, subtitle, demonstration and one call to action", async ({ page, backend }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("prune — Your day. Three priorities.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("DO LESS. ACHIEVE MORE.");
  await expect(page.getByRole("heading")).toHaveCount(1);
  await expect(page.locator(".landing-subtitle")).toContainText("Time is limited.");
  await expect(page.getByRole("tablist", { name: "App screens" })).toBeVisible();
  const cta = page.getByRole("link", { name: "Get started", exact: true });
  await expect(cta).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", GOOGLE)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  expect(backend.requests).toEqual([]);
  expect(await page.locator("script[src*='googletagmanager'],script[src*='goatcounter'],script[src*='vercel-scripts']").count()).toBe(0);

  await cta.click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/login");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SIGN IN");
  await expect(page.getByRole("button", GOOGLE)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("By signing up, you agree to our Terms of Service and Privacy Policy.")).toBeVisible();
  expect(backend.requests).toEqual([]);

  await page.goBack();
  await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
});

test("opening /login directly shows the login page", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SIGN IN");
  await page.getByRole("link", { name: "← Back" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
});

test.describe("email sign-in", () => {
  test.use({ firstVisit: true });

  test("records the notice, sends a code, verifies it and opens the planner at the root", async ({ page, backend }) => {
    await openSignIn(page);
    await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await expect(page.getByText("user@example.com")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email code" })).toBeFocused();
    expect(await page.evaluate((key) => localStorage.getItem(key), PRIVACY_ACKNOWLEDGEMENT_KEY)).toContain(PRIVACY_POLICY_VERSION);

    await page.getByRole("textbox", { name: "Email code" }).fill("00000000");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Check your email and code");
    await expect(page.locator("body")).not.toContainText("private upstream error");

    await page.getByRole("textbox", { name: "Email code" }).fill("12345678");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page).toHaveURL("http://127.0.0.1:4173/");
    expect(backend.requests.some((request) => request.path.startsWith("/auth/v1/otp") && request.body.email === "user@example.com")).toBe(true);
  });

  test("a different email returns to the first step", async ({ page }) => {
    await openSignIn(page);
    await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await page.getByRole("button", { name: "Use a different email", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Email address" })).toBeFocused();
    await expect(page.getByRole("button", GOOGLE)).toBeVisible();
  });
});

test.describe("a first sign-in", () => {
  test.use({ firstVisit: true });

  test("records the notice, signs in with Google, then opens the tour before the first task", async ({ page, backend }) => {
    await openSignIn(page);
    await page.getByRole("button", GOOGLE).first().click();

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
    await finishTour(page);
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
  await page.getByRole("button", GOOGLE).first().click();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
  await expect(page.locator("body")).not.toContainText("private-diagnostic");
  await expect(page).toHaveURL("http://127.0.0.1:4173/login");
  await expect(page.getByRole("button", GOOGLE).first()).toBeEnabled();
  expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/token"))).toEqual([]);
});

test("a disabled Google provider fails with a clear message instead of leaving the site", async ({ page, backend }) => {
  backend.googleDisabled = true;
  await openSignIn(page);
  await page.getByRole("button", GOOGLE).first().click();
  await expect(page.getByRole("alert")).toHaveText("Google sign-in isn't available right now. Please try again later.");
  await expect(page.getByRole("button", GOOGLE).first()).toBeEnabled();
  await expect(page).toHaveURL("http://127.0.0.1:4173/login");
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
  await page.getByRole("button", GOOGLE).first().click();
  await expect(page.getByRole("alert")).toContainText("No sign-in request was sent");
  expect(backend.requests).toHaveLength(0);
});

test("an outdated notice gates saved sessions and the full policy is available before sign-in", async ({ page, backend }) => {
  await page.addInitScript(({ authKey, savedSession, privacyKey }) => {
    localStorage.setItem(authKey, JSON.stringify(savedSession));
    localStorage.setItem(privacyKey, JSON.stringify({ version: "privacy-old", acknowledgedAt: new Date().toISOString() }));
  }, { authKey: AUTH_KEY, savedSession: session(), privacyKey: PRIVACY_ACKNOWLEDGEMENT_KEY });
  await openSignIn(page);
  await page.getByRole("button", { name: "Privacy Policy", exact: true }).first().click();
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
  await page.goto("/");
  for (const viewport of [
    { width: 280, height: 568 }, { width: 320, height: 568 }, { width: 375, height: 667 },
    { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 568, height: 320 },
    { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `No overflow at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(viewport.width);
    const cta = page.getByRole("link", { name: "Get started", exact: true });
    await cta.evaluate((link) => link.scrollIntoView({ block: "center" }));
    await expect(cta).toBeInViewport({ ratio: 1 });
    expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});

for (const banner of [false, true]) {
  test(`on a phone everything fits one screen ${banner ? "with" : "without"} the cookie banner`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (banner) await page.addInitScript(() => localStorage.removeItem("prune:cookies:v1"));
    for (const viewport of [
      { width: 280, height: 568 }, { width: 320, height: 568 }, { width: 360, height: 640 },
      { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const cta = page.getByRole("link", { name: "Get started", exact: true });
      await expect(cta).toBeVisible();
      await expect(page.locator(".cookie-banner")).toHaveCount(banner ? 1 : 0);
      const size = `${viewport.width}×${viewport.height}`;
      const layout = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
        const link = box(".landing-cta")!;
        return {
          page: document.documentElement.scrollHeight,
          title: box("h1")!.top,
          subtitleBottom: box(".landing-subtitle")!.bottom,
          frame: box(".device-browser")!,
          ctaBottom: link.bottom,
          bannerBottom: box(".cookie-banner")?.bottom,
          bannerClipped: (() => {
            const element = document.querySelector(".cookie-banner");
            return !!element && element.scrollHeight > element.clientHeight;
          })(),
          onTop: document.elementFromPoint(link.left + link.width / 2, link.top + link.height / 2)?.className,
        };
      });
      expect(layout.page, `No page scroll at ${size}`).toBeLessThanOrEqual(viewport.height);
      expect(layout.title, `Title on screen at ${size}`).toBeGreaterThanOrEqual(0);
      expect(layout.frame.top, `Demo below the subtitle at ${size}`).toBeGreaterThanOrEqual(layout.subtitleBottom - 1);
      expect(layout.frame.height, `Demo still shows at ${size}`).toBeGreaterThanOrEqual(80);
      expect(layout.ctaBottom, `Button on screen at ${size}`).toBeLessThanOrEqual(viewport.height);
      expect(layout.onTop, `Nothing covers the button at ${size}`).toBe("landing-cta");
      expect(layout.bannerClipped, `Banner fully shown at ${size}`).toBe(false);
      if (banner) expect(layout.bannerBottom, `Banner on screen at ${size}`).toBeLessThanOrEqual(viewport.height + 1);
    }
  });
}

test("the cookie banner is a small corner card that never covers the button", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.removeItem("prune:cookies:v1"));
  for (const viewport of [
    { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 720 },
    { width: 1024, height: 768 }, { width: 1023, height: 768 }, { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const banner = page.getByRole("region", { name: "Cookie preferences" });
    await expect(banner).toBeVisible();
    const size = `${viewport.width}×${viewport.height}`;
    const link = page.getByRole("link", { name: "Get started", exact: true });
    await link.scrollIntoViewIfNeeded();
    const cta = (await link.boundingBox())!;
    const card = (await banner.boundingBox())!;
    const overlaps = cta.x < card.x + card.width && card.x < cta.x + cta.width && cta.y < card.y + card.height && card.y < cta.y + cta.height;
    expect(overlaps, `Banner clear of the button at ${size}`).toBe(false);
    if (viewport.width >= 1024) {
      expect(card.x + card.width, `Corner card at ${size}`).toBeGreaterThan(viewport.width - 24);
      expect(card.y + card.height, `Corner card at ${size}`).toBeGreaterThan(viewport.height - 24);
      expect(card.width, `Small card at ${size}`).toBeLessThanOrEqual(320);
      expect(card.height, `Small card at ${size}`).toBeLessThanOrEqual(200);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cookie preferences" })).toHaveCount(0);
});

test("the landing stays light: decodable compressed artwork, no planner mask", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await openSignIn(page);
  // An encoder can emit a file one engine decodes as solid black; check real pixels.
  const mean = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/prune-background.webp";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4);
  });
  expect(mean).toBeGreaterThan(40);
  await expect.poll(() => requested.includes("/prune-background.webp") || requested.includes("/prune-background.png")).toBe(true);
  expect(requested).not.toContain("/prune-background-mask.png");
  expect(requested.filter((path) => path.endsWith(".ttf"))).not.toContain("/fonts/space-grotesk-variable.ttf");
});
