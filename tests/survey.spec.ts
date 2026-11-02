import type { Page } from "@playwright/test";
import { test, expect, AUTH_KEY } from "./helpers/browser";

const SURVEY_BUILD = "http://127.0.0.1:4174";
const SURVEY_KEY = "prune:survey:v1";

async function choose(page: Page, question: string, answer: string) {
  await expect(page.getByRole("heading", { level: 1, name: question, exact: true })).toBeVisible();
  await page.getByRole("group", { name: question, exact: true }).getByRole("button", { name: answer, exact: true }).click();
}

/** Ada: ship a project, engineer, mornings, 60 minutes, phone, 2 hours. */
async function answerEverything(page: Page, outcome = "Launch the new homepage") {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("textbox", { name: "First, what should we call you?" }).fill("Ada");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await choose(page, "Ada, what are you here to do?", "Ship a project");
  await choose(page, "What do you do?", "Engineer");
  await choose(page, "When do you focus best?", "Morning");
  await choose(page, "How long can you focus before you drift?", "60 min");
  await expect(page.getByRole("heading", { level: 1, name: "3 tasks a day. That’s the whole rule." })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await choose(page, "Ada, what derails you most?", "My phone");
  await choose(page, "How many hours of deep work do you want each day?", "2 hours");
  await page.getByRole("textbox", { name: "One outcome you want this week?" }).fill(outcome);
  await page.getByRole("button", { name: "Build my plan", exact: true }).click();
}

const PLAN = [
  "Build the next feature, phone in another room",
  "List what's left before it ships",
  "Share progress with one person",
];

test.describe("survey flag on", () => {
  test.use({ baseURL: SURVEY_BUILD, firstVisit: true });

  test("questions lead to a plan, then Continue with Google signs in and lands the plan in Today", async ({ page, backend }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("DO LESS.ACHIEVE MORE.");
    await answerEverything(page);
    // The checklist echoes what was computed from these answers, then shows the plan within 3 s.
    await expect(page.getByRole("heading", { name: "Building your plan…" })).toBeVisible();
    await expect(page.getByText("Matching 60-minute blocks to your mornings")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ada, here’s your focus plan." })).toBeVisible({ timeout: 3500 });
    const plan = page.getByRole("list", { name: "Today’s three tasks" });
    await expect(plan.getByRole("listitem")).toHaveText([`${PLAN[0]}60 min`, `${PLAN[1]}15 min`, `${PLAN[2]}10 min`]);
    await expect(page.getByText("Mornings, 60-minute blocks")).toBeVisible();
    await expect(page.getByText("Launch the new homepage")).toBeVisible();
    expect(backend.requests, "Nothing is sent before sign-in").toEqual([]);

    await page.getByRole("button", { name: "Save my plan →" }).click();
    await expect(page.getByRole("heading", { name: "SAVE YOUR PLAN." })).toBeVisible();
    const notice = page.getByRole("checkbox");
    await expect(notice).not.toBeChecked();
    const google = page.getByRole("button", { name: "Continue with Google" });
    await google.click();
    // The unchecked notice blocks sign-in, exactly like the email form.
    await expect(page).toHaveURL(`${SURVEY_BUILD}/`);
    expect(backend.requests).toEqual([]);
    await notice.check();
    await google.click();

    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page).toHaveURL(`${SURVEY_BUILD}/`);
    await expect(page.getByRole("status").filter({ hasText: "Signed in." })).toBeVisible();
    const paths = backend.requests.map((request) => request.path);
    expect(paths[0]).toBe("/auth/v1/settings");
    const authorize = new URL(`https://fixture.test${paths.find((path) => path.startsWith("/auth/v1/authorize"))}`);
    expect(authorize.searchParams.get("provider")).toBe("google");
    expect(authorize.searchParams.get("redirect_to")).toBe(`${SURVEY_BUILD}/?oauth=google`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
    expect(backend.requests.some((request) => request.path === "/auth/v1/token?grant_type=pkce" && request.body.auth_code === "fixture-oauth-code")).toBe(true);
    // Answers ride along with the guest import, without the name.
    expect(backend.imports).toHaveLength(1);
    expect(backend.imports[0]).toMatchObject({ tasks: [], stops: [] });
    expect(backend.imports[0].survey).toEqual({
      goal: "ship", role: "engineer", focusWindow: "morning", focusMinutes: 60, derailer: "phone", deepWorkHours: 2,
      weekGoal: "Launch the new homepage", weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(JSON.stringify(backend.requests.map((request) => request.body))).not.toContain("Ada");
    // The kept plan lands in the account's Today.
    for (const outcome of PLAN) await expect(page.getByRole("button", { name: `Edit task title: ${outcome}` })).toBeVisible();
    await expect.poll(() => backend.data.todayTasks.map((task) => [task.outcome, task.estimatedMinutes])).toEqual([[PLAN[0], 60], [PLAN[1], 15], [PLAN[2], 10]]);
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), SURVEY_KEY);
    expect(saved).toMatchObject({ status: "done", plan: "applied", synced: true });
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(backend.imports).toHaveLength(1);
    expect(backend.data.todayTasks).toHaveLength(3);
  });

  test("skip opens today's guest planner and the questions never come back", async ({ page, backend }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Skip, just let me plan" }).click();
    await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
    await expect(page.getByRole("region", { name: "Starting ideas" }).getByRole("button")).toHaveText(["Clear my inbox20 min", "Deep work on my main project60 min", "Plan the week ahead30 min"]);
    await page.reload();
    await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    expect(backend.requests).toEqual([]);
  });

  test("Not now keeps planning as a guest with the plan's tasks in Today", async ({ page, backend }) => {
    await page.goto("/");
    await answerEverything(page, "");
    await page.getByRole("button", { name: "Save my plan →" }).click();
    await page.getByRole("button", { name: "Not now, start planning" }).click();
    for (const outcome of PLAN) await expect(page.getByRole("button", { name: `Edit task title: ${outcome}` })).toBeVisible();
    await expect(page.locator(".starters")).toHaveCount(0);
    await expect(page.locator(".task.is-next")).toContainText(PLAN[0]);
    await page.reload();
    await expect(page.locator(".task")).toHaveCount(3);
    // Focus length set the default estimate for new tasks.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole("navigation").getByRole("button", { name: "Tomorrow", exact: true }).click();
    await expect(page.locator(".task-form .estimate-dial")).toHaveAttribute("aria-valuenow", "60");
    expect(backend.requests, "Guest planning stays on this device").toEqual([]);
  });

  test("Use email instead opens the code form; leaving it keeps the plan as a guest", async ({ page, backend }) => {
    await page.goto("/");
    await answerEverything(page);
    await page.getByRole("button", { name: "Save my plan →" }).click();
    await page.getByRole("button", { name: "Use email instead" }).click();
    await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeVisible();
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await expect(page.locator(".task")).toHaveCount(3);
    expect(backend.requests).toEqual([]);
  });

  test("back keeps every answer, and a reload resumes the same step", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("textbox", { name: "First, what should we call you?" }).fill("Ada");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await choose(page, "Ada, what are you here to do?", "Study");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Step 3 of 9");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("button", { name: "Study", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Step 2 of 9");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("textbox", { name: "First, what should we call you?" })).toHaveValue("Ada");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run my business", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What do you do?" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "What do you do?" })).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("button", { name: "Run my business", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("a disabled Google provider fails with a clear message instead of leaving the site", async ({ page, backend }) => {
    backend.googleDisabled = true;
    await page.goto("/");
    await answerEverything(page);
    await page.getByRole("button", { name: "Save my plan →" }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByRole("alert")).toHaveText("Google sign-in isn't available right now. Use email instead.");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await expect(page).toHaveURL(`${SURVEY_BUILD}/`);
    expect(backend.requests.map((request) => request.path)).toEqual(["/auth/v1/settings"]);
  });

  test("a cancelled Google sign-in returns to the Save screen with the plan still kept", async ({ page, backend }) => {
    backend.googleCancelled = true;
    await page.goto("/");
    await answerEverything(page);
    await page.getByRole("button", { name: "Save my plan →" }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByRole("heading", { name: "SAVE YOUR PLAN." })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
    await expect(page.locator("body")).not.toContainText("private-diagnostic");
    await expect(page).toHaveURL(`${SURVEY_BUILD}/`);
    // The notice was accepted on the way out, so only the actions remain.
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Today’s three tasks" }).getByRole("listitem")).toHaveCount(3);
    expect(backend.requests.filter((request) => request.path.startsWith("/auth/v1/token"))).toEqual([]);
  });

  test("returning visitors with guest plans or an earlier sign-in skip the questions", async ({ page }) => {
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem("returning-seeded")) {
        sessionStorage.setItem("returning-seeded", "true");
        localStorage.setItem(key, JSON.stringify({ version: "privacy-web-v9", acknowledgedAt: new Date().toISOString() }));
      }
    }, "prune:privacy:acknowledgement");
    await page.goto("/");
    await expect(page.locator(".plan-summary")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  });
});

test.describe("survey on a phone", () => {
  test.use({ baseURL: SURVEY_BUILD, firstVisit: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("one-tap answers fit narrow phones with thumb-sized targets", async ({ page }, info) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start", exact: true }).tap();
    const name = page.getByRole("textbox", { name: "First, what should we call you?" });
    expect(await name.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await name.fill("Ada");
    await page.getByRole("button", { name: "Continue", exact: true }).tap();
    for (const width of [280, 320, 390]) {
      await page.setViewportSize({ width, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `No overflow at ${width}px`).toBeLessThanOrEqual(width);
      for (const height of await page.locator(".survey-options button, .survey-back").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height)))
        expect(height).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `test-results/${info.project.name}-survey-question.png`, animations: "disabled" });
    for (const [question, answer] of [
      ["Ada, what are you here to do?", "Ship a project"],
      ["What do you do?", "Engineer"],
      ["When do you focus best?", "Morning"],
      ["How long can you focus before you drift?", "60 min"],
    ]) {
      await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
      await page.getByRole("button", { name: answer, exact: true }).tap();
    }
    await page.getByRole("button", { name: "Continue", exact: true }).tap();
    await page.getByRole("button", { name: "My phone", exact: true }).tap();
    await page.getByRole("button", { name: "2 hours", exact: true }).tap();
    await page.getByRole("button", { name: "Build my plan", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Save my plan →" })).toBeInViewport({ timeout: 3500 });
    await page.screenshot({ path: `test-results/${info.project.name}-survey-plan.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Save my plan →" }).tap();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `test-results/${info.project.name}-survey-save.png`, animations: "disabled" });
  });
});

test.describe("survey flag off", () => {
  test.use({ firstVisit: true });

  test("fresh visitors get today's guest planner and nothing is stored for the survey", async ({ page, backend }) => {
    await page.goto("/");
    await expect(page.locator(".plan-summary")).toHaveText("What would make today count?");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Starting ideas" }).getByRole("button")).toHaveText(["Clear my inbox20 min", "Deep work on my main project60 min", "Plan the week ahead30 min"]);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
    expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [SURVEY_KEY, AUTH_KEY])).toEqual([null, null]);
    expect(backend.requests).toEqual([]);
  });
});
