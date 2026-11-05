import { test as cspTest } from "@playwright/test";
import { integrity, securityHeaders } from "../scripts/security-policy.ts";
import { test, expect, openPlanner, visitProfile, addTask, synced, AUTH_KEY, QUEUE_KEY, USER_ID, PROJECT, dashboard, review } from "./helpers/browser";

test.use({ signedIn: true });

// Check the DOM as well as execution: CSP must not conceal unsafe rendering.
test("stored task titles and AI output render as text, never executable HTML", async ({ page, backend }) => {
  const payload = '<img src="/xss-probe" onerror="globalThis.__pruneXss = true">';
  await openPlanner(page);
  await addTask(page, payload);
  await synced(page);
  await page.reload();
  await expect(page.getByRole("button", { name: `Edit task title: ${payload}`, exact: true })).toBeVisible();
  await expect(page.locator(".task img, .task [onerror]")).toHaveCount(0);

  const saved = review();
  saved.analysis.improvements = [payload];
  saved.analysis.mainReasons = [{ reason: payload, evidenceStopIds: [1] }];
  saved.activity.tasks = [{ id: "evidence-task", outcome: payload, plannedFor: saved.weekStart, completedOn: null, status: "planned", estimatedMinutes: 30, actualSeconds: 0 }];
  saved.activity.stops = [{ id: 1, taskId: "evidence-task", reason: payload, stoppedOn: saved.weekStart }];
  saved.activity.totalStops = 1;
  backend.weekly.reviews = [saved];
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".weekly-improvements")).toContainText(payload);
  await page.getByText("View 1 supporting stop entry", { exact: true }).click();
  await expect(page.locator(".review-evidence")).toContainText(payload);
  await expect(page.locator(".weekly-report img, .weekly-report [onerror]")).toHaveCount(0);
  expect(await page.evaluate(() => "__pruneXss" in globalThis)).toBe(false);
});

test("normal planner, calendar and profile workflows do not violate CSP", async ({ page }) => {
  const violations: string[] = [];
  await page.exposeFunction("__reportCsp", (directive: string) => violations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (globalThis as typeof globalThis & { __reportCsp: (directive: string) => Promise<void> }).__reportCsp(event.effectiveDirective);
    });
  });
  await openPlanner(page);
  await addTask(page, "Hash-locked planner workflow");
  await synced(page);
  await page.locator(".task").first().getByRole("button", { name: "Start focus", exact: true }).click();
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await synced(page);
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".activity-calendar")).toBeVisible();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.locator(".profile-page")).toBeVisible();
  expect(violations).toEqual([]);
});

cspTest("every document alias has enforced security headers on GET and HEAD, including query strings", async ({ request }) => {
  const expected = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
    "strict-transport-security": "max-age=31536000",
  };
  let policy: string | undefined;
  for (const path of ["/", "/download", "/download/", "/index.html", "/?security=1", "/download/?security=1"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request.fetch(path, { method, maxRedirects: 0 });
      expect(response.status(), `${method} ${path}`).toBe(200);
      const headers = response.headers();
      for (const [name, value] of Object.entries(expected)) expect(headers[name], `${method} ${path}: ${name}`).toBe(value);
      expect(headers["content-type"]).toMatch(/^text\/html/);
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["content-security-policy"]).toMatch(/script-src 'sha384-[A-Za-z0-9+/]{64}'/);
      policy ??= headers["content-security-policy"];
      expect(headers["content-security-policy"]).toBe(policy);
      if (method === "HEAD") expect(await response.body()).toHaveLength(0);
    }
  }
});

// Deliberate attack probes use the plain browser fixture: unlike normal app
// tests, these intentionally provoke CSP/SRI errors and blocked requests.
cspTest("production CSP blocks injected code, styles and unapproved backend connections", async ({ page, context }) => {
  const escapedRequests: string[] = [];
  await context.route("**/csp-untrusted.js", async (route) => {
    escapedRequests.push(route.request().url());
    await route.fulfill({ contentType: "text/javascript", body: "globalThis.__cspExecuted = true" });
  });
  const response = await page.goto("/");
  expect(response!.headers()["content-security-policy"]).toContain("default-src 'none'");
  const policy = response!.headers()["content-security-policy"]!;
  expect(policy).toMatch(/script-src 'sha384-[A-Za-z0-9+/]{64}'/);
  expect(policy).not.toContain("script-src 'self'");
  // Optional, consent-gated analytics has narrowly reviewed domain wildcards;
  // no unrestricted source or backend wildcard may enter the policy.
  expect([...new Set(policy.split(/[;\s]+/).filter((source) => source.includes("*")))].sort()).toEqual([
    "https://*.contentsquare.com", "https://*.contentsquare.net",
  ]);
  expect(response!.headers()["cache-control"]).toContain("no-store");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", policy.replace("; frame-ancestors 'none'", ""));
  await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
    Object.assign(globalThis, { __cspViolations: violations });
    const script = document.createElement("script");
    script.textContent = "globalThis.__cspExecuted = true";
    document.head.append(script);
    // Even a same-origin script is untrusted without build-approved SRI.
    for (const src of ["/csp-untrusted.js", "https://security-fixture.invalid/csp-untrusted.js"]) {
      const external = document.createElement("script");
      external.src = src;
      document.head.append(external);
    }
    const missingIntegrity = document.createElement("script");
    missingIntegrity.type = "module";
    missingIntegrity.src = document.querySelector<HTMLScriptElement>("script[integrity]")!.src;
    document.head.append(missingIntegrity);
    const button = document.createElement("button");
    button.setAttribute("onclick", "globalThis.__cspExecuted = true");
    button.setAttribute("style", "position: fixed");
    button.id = "csp-probe";
    document.body.append(button);
    button.click();
    const style = document.createElement("style");
    style.textContent = "#csp-probe { position: absolute; }";
    document.head.append(style);
    // A different Supabase tenant is also blocked, not just unrelated domains.
    await Promise.all([
      "https://security-fixture.invalid", "https://other-project.supabase.co",
      "/csp-exfil", "https://web-fixture.supabase.co/storage/v1/object/probe",
      "https://web-fixture.supabase.co/rest/v1/planner_tasks",
    ].map(async (url) => {
      try { await fetch(url); } catch { /* Expected CSP rejection. */ }
    }));
  });
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __cspViolations?: string[] }).__cspViolations)).toEqual(
    expect.arrayContaining(["script-src-elem", "script-src-attr", "style-src-attr", "style-src-elem", "connect-src"]),
  );
  expect(await page.evaluate(() => "__cspExecuted" in globalThis)).toBe(false);
  expect(escapedRequests).toEqual([]);
  expect(await page.locator("#csp-probe").evaluate((element) => getComputedStyle(element).position)).toBe("static");
  // Property-level CSSOM writes used for the timer/calendar remain supported.
  await page.locator("#csp-probe").evaluate((element) => { element.style.width = "37px"; });
  expect(await page.locator("#csp-probe").evaluate((element) => getComputedStyle(element).width)).toBe("37px");
});

cspTest("CSP denies frames, workers, native form submissions and base overrides", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
    Object.assign(globalThis, { __cspViolations: violations });
    const base = document.createElement("base");
    base.href = "https://security-fixture.invalid/";
    document.head.append(base);
    const frame = document.createElement("iframe");
    frame.src = "/";
    document.body.append(frame);
    const form = document.createElement("form");
    form.action = "/?csp-form-probe";
    form.method = "POST";
    document.body.append(form);
    form.submit();
    try { new Worker("/csp-worker.js"); } catch { /* Expected CSP rejection. */ }
  });
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __cspViolations?: string[] }).__cspViolations)).toEqual(
    expect.arrayContaining(["base-uri", "frame-src", "form-action", "worker-src"]),
  );
  expect(await page.evaluate(() => document.baseURI)).toBe(page.url());
  expect(page.url()).not.toContain("csp-form-probe");
});

cspTest("modified JavaScript fails integrity verification instead of running", async ({ page, context }) => {
  const requests: string[] = [];
  await context.route(`${PROJECT}/**`, async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await context.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    const body = `globalThis.__cspTampered = true;\n${await response.text()}`;
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  expect(await page.evaluate(() => "__cspTampered" in globalThis)).toBe(false);
  await expect(page.locator("#root")).toBeEmpty();
  expect(requests).toEqual([]);
});

cspTest("modified CSS fails integrity verification while the trusted application still starts", async ({ page, context }) => {
  await context.route("**/assets/*.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nbody { --csp-tampered: yes; }` });
  });
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--csp-tampered"))).toBe("");
});

cspTest("HTTP framing protections block even a same-origin parent without its own CSP", async ({ page, context }) => {
  await context.route("**/csp-framing-parent", (route) => route.fulfill({
    contentType: "text/html",
    body: '<html><body><iframe src="/" onload="document.body.dataset.frameLoaded = \'true\'"></iframe></body></html>',
  }));
  const childResponse = page.waitForResponse("http://127.0.0.1:4173/");
  await page.goto("/csp-framing-parent");
  expect((await childResponse).headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.locator("body")).toHaveAttribute("data-frame-loaded", "true");
  expect(await page.evaluate(() => !!document.querySelector("iframe")?.contentDocument?.getElementById("root"))).toBe(false);
});

cspTest("hash-approved code still cannot use eval, Function or string timers", async ({ page, context }) => {
  const script = `
    globalThis.__cspApproved = true;
    globalThis.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", event => globalThis.__cspViolations.push(event.effectiveDirective));
    try { eval("globalThis.__cspExecuted = true"); } catch {}
    try { new Function("globalThis.__cspExecuted = true")(); } catch {}
    try { setTimeout("globalThis.__cspExecuted = true", 0); } catch {}
  `;
  const hash = integrity(script);
  const headers = securityHeaders(PROJECT, [hash]);
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"]!.replace("; upgrade-insecure-requests", "");
  await context.route("**/assets/csp-eval.js", (route) => route.fulfill({ contentType: "text/javascript", body: script }));
  await context.route("http://127.0.0.1:4173/", (route) => route.fulfill({
    contentType: "text/html",
    headers,
    body: `<html><head><script type="module" integrity="${hash}" src="/assets/csp-eval.js"></script></head><body></body></html>`,
  }));
  await page.goto("/");
  expect(await page.evaluate(() => "__cspApproved" in globalThis)).toBe(true);
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __cspViolations?: string[] }).__cspViolations)).toEqual(
    expect.arrayContaining(["script-src"]),
  );
  expect(await page.evaluate(() => "__cspExecuted" in globalThis)).toBe(false);
});

test("a tampered local session identity cannot unlock another account's cached planner", async ({ page, backend }) => {
  const otherId = "22222222-2222-4222-8222-222222222222";
  const privateTitle = "Never expose this cached outcome";
  const cached = dashboard();
  cached.todayTasks.push({ id: "private-task", outcome: privateTitle, isPriority: true, plannedFor: cached.today, estimatedMinutes: 30, actualSeconds: 0, status: "planned", startedAt: null, completedOn: null, createdAt: cached.serverNow, resources: [] });
  await page.addInitScript(({ authKey, queueKey, otherId, cached }) => {
    const session = JSON.parse(localStorage.getItem(authKey)!);
    session.user.id = otherId; // The fixture Auth server still verifies USER_ID.
    localStorage.setItem(authKey, JSON.stringify(session));
    localStorage.setItem(queueKey, JSON.stringify({ version: 1, base: cached, savedAt: Date.now() / 1000, pending: [], blocked: null }));
  }, { authKey: AUTH_KEY, queueKey: QUEUE_KEY.replace(USER_ID, otherId), otherId, cached });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(privateTitle);
  expect(backend.requests.some((request) => request.path === "/auth/v1/user")).toBe(true);
  expect(backend.requests.some((request) => request.path.includes("/rpc/"))).toBe(false);
});

test("a server-rejected saved session never displays the account cache", async ({ page, context, backend }) => {
  await openPlanner(page);
  await addTask(page, "A private cached outcome");
  await synced(page);
  await context.route(`${PROJECT}/auth/v1/user`, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ msg: "Sensitive upstream diagnostic", code: "bad_jwt" }) }));
  backend.requests.length = 0;
  await page.reload();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("A private cached outcome");
  await expect(page.locator("body")).not.toContainText("Sensitive upstream diagnostic");
  expect(backend.requests.some((request) => request.path.includes("/rpc/"))).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
});

test("sign-out and browser back do not restore the planner or credentials", async ({ page }) => {
  await openPlanner(page);
  await addTask(page, "A private signed-out task");
  await synced(page);
  await page.goto("/?history=1");
  await expect(page.getByRole("navigation")).toBeVisible();
  await visitProfile(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("A private signed-out task");
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_KEY)).toBeNull();
  // This is intentional recovery behavior, not encryption/erasure of site data.
  expect(await page.evaluate((key) => localStorage.getItem(key), QUEUE_KEY)).toContain("A private signed-out task");
});

test("focus scratchpad stays in memory and planner credentials stay out of the outbox", async ({ page, backend }) => {
  await openPlanner(page);
  await addTask(page, "Keep notes local");
  await synced(page);
  await page.locator(".task").first().getByRole("button", { name: "Start focus", exact: true }).click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Highly private scratchpad marker");
  await page.getByRole("button", { name: "Complete task", exact: true }).click();
  await synced(page);
  expect(JSON.stringify(backend.requests)).not.toContain("Highly private scratchpad marker");
  const persisted = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(persisted)).not.toContain("Highly private scratchpad marker");
  const outbox = persisted[QUEUE_KEY]!;
  expect(outbox).not.toContain("access_token");
  expect(outbox).not.toContain("refresh_token");
  for (const request of backend.requests.filter((request) => request.path.includes("/rpc/") || request.path.includes("/functions/"))) {
    expect(request.authorization).toMatch(/^Bearer /);
    expect(JSON.stringify(request.body)).not.toContain("fixture-refresh");
    expect(request.body).not.toHaveProperty("code");
    expect(request.body).not.toHaveProperty("token");
  }
});
