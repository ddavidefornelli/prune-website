import type { Page } from "@playwright/test";
import {
  addTask,
  dayKey,
  EVENING,
  expect,
  nav,
  openPlanner,
  ORIGIN,
  pauseDialogReady,
  review,
  steadyFocus,
  synced,
  task,
  test,
} from "./backend.ts";

const DAY = 86_400_000;
const TOKEN = "22222222-2222-4222-8222-222222222222";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const outcome = (page: Page) => page.getByRole("textbox", { name: "Outcome", exact: true });
const addButton = (page: Page) =>
  page.locator(".task-form").getByRole("button", { name: "Add task", exact: true });
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test.describe("signed out", () => {
  test.use({ cookieChoice: false });

  test("landing and login", async ({ page, snap }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    const banner = page.getByRole("region", { name: "Cookie preferences" });
    await expect(banner).toBeVisible();
    await snap("landing-first-visit");
    await banner.getByRole("button", { name: "Read our privacy policy" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await snap("privacy-dialog");
    await page.getByRole("button", { name: "Close privacy policy" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await snap("privacy-dialog-closed");
    await banner.getByRole("button", { name: "Reject optional", exact: true }).click();
    await expect(banner).toHaveCount(0);
    await snap("cookies-rejected");
    const tabs = page.getByRole("tablist", { name: "App screens" });
    for (const name of ["Focus", "Tomorrow", "Overview", "Today"]) {
      await tabs.getByRole("tab", { name, exact: true }).click();
      await snap(`preview-${name.toLowerCase()}`);
    }
    await tabs.getByRole("tab", { name: "Today", exact: true }).press("ArrowLeft");
    await snap("preview-arrow-left");
    await page.keyboard.press("Home");
    await snap("preview-home");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await snap("preview-wrapped");

    await page.getByRole("link", { name: "Get started", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("SIGN IN");
    await expect(page).toHaveURL(`${ORIGIN}/login`);
    await snap("login");
    await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
    await expect(banner).toBeVisible();
    await snap("login-cookie-settings");
    await banner.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Terms of Service" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await snap("login-terms-dismissed");
    await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
    await snap("login-email-typed");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    const code = page.getByRole("textbox", { name: "Email code" });
    await expect(code).toBeFocused();
    await snap("login-code");
    await code.fill("1234");
    await snap("login-code-partial");
    await code.fill("00000000");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect(page.locator(".auth-panel .error")).toContainText("Check your email and code");
    await snap("login-code-invalid");
    await page.getByRole("button", { name: "Use a different email", exact: true }).click();
    await snap("login-different-email");
    await page.getByRole("link", { name: "← Back" }).click();
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await snap("landing-again");

    await page.getByRole("link", { name: "Get started", exact: true }).click();
    await page.getByRole("textbox", { name: "Email address" }).fill("user@example.com");
    await page.getByRole("button", { name: "Email me a code", exact: true }).click();
    await code.fill("12345678");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect(page.locator(".plan-summary")).toBeVisible();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await snap("signed-in-with-code");
  });

  test("landing with reduced motion", async ({ page, snap }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await snap("landing");
    const tabs = page.getByRole("tablist", { name: "App screens" });
    for (const name of ["Focus", "Tomorrow", "Overview"]) {
      await tabs.getByRole("tab", { name, exact: true }).click();
      await snap(`preview-${name.toLowerCase()}`);
    }
  });

  test("sign-in problems", async ({ page, snap, backend }) => {
    backend.googleDisabled = true;
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
    await expect(page.locator(".auth-panel .error")).toContainText("Google sign-in isn't available");
    await steadyFocus(page);
    await snap("google-unavailable");
    // Returning from Google after backing out on its consent screen.
    await page.goto("/?oauth=google&error=access_denied&error_description=private");
    await expect(page.locator(".auth-panel .error")).toContainText("Sign-in was cancelled");
    await expect(page).toHaveURL(`${ORIGIN}/login`);
    await snap("google-cancelled");
  });

  test("download page", async ({ page, snap }) => {
    await page.goto("/download");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await snap("download");
  });

  test("unsubscribe page", async ({ page, snap, backend }) => {
    await page.goto(`/?unsubscribe=${TOKEN}&kind=daily`);
    await expect(page.getByRole("heading", { name: "Stop daily reminder emails?" })).toBeVisible();
    await snap("ask-daily");
    backend.unsubscribeStatus = 500;
    await page.getByRole("button", { name: "Stop these emails", exact: true }).click();
    await expect(page.locator(".unsubscribe-page .error")).toBeVisible();
    await steadyFocus(page);
    await snap("failed");
    backend.unsubscribeStatus = 204;
    await page.getByRole("button", { name: "Stop these emails", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Done." })).toBeVisible();
    await snap("done");
    await page.goto(`/?unsubscribe=${TOKEN}&kind=comeback`);
    await expect(page.getByRole("heading", { name: "Stop come-back emails?" })).toBeVisible();
    await snap("ask-comeback");
    await page.goto("/?unsubscribe=not-a-token&kind=daily");
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await snap("malformed-link");
  });
});

test.describe("signed out on a phone", () => {
  test.use(PHONE);

  test("phone landing and login", async ({ page, snap }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await page.getByRole("tablist", { name: "App screens" }).getByRole("tab", { name: "Today", exact: true }).click();
    await snap("landing");
    await page.getByRole("link", { name: "Get started", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("SIGN IN");
    await snap("login");
  });
});

test.describe("a restored session that cannot load", () => {
  test.use({ signedIn: true });

  test("offline restore", async ({ page, snap, backend }) => {
    backend.offline = true;
    await page.goto("/");
    await expect(page.locator(".auth-panel .error")).toContainText("Could not reach Supabase");
    await snap("restore-failed");
  });

  test("planner load failure and retry", async ({ page, snap, backend }) => {
    backend.failDashboard = true;
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await snap("load-failed");
    backend.failDashboard = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".plan-summary")).toBeVisible();
    await steadyFocus(page);
    await snap("loaded-after-retry");
  });
});

test.describe("first visit", () => {
  test.use({ signedIn: true, firstVisit: true });

  test("empty tour then first plan and focus", async ({ page, snap }) => {
    await page.goto("/");
    const popup = page.locator(".tour-popup");
    await expect(popup).toBeVisible();
    const titles = ["Three tasks a day", "Plan ahead", "See your progress", "Add your first task"];
    for (const [index, title] of titles.entries()) {
      await expect(popup.getByRole("heading")).toHaveText(title);
      await snap(`tour-${index + 1}`);
      if (index === 1) {
        await popup.getByRole("button", { name: "Back", exact: true }).click();
        await expect(popup.getByRole("heading")).toHaveText(titles[0]!);
        await snap("tour-back");
        await popup.getByRole("button", { name: "Next", exact: true }).click();
        await expect(popup.getByRole("heading")).toHaveText(title);
      }
      if (index < 3) await popup.getByRole("button", { name: "Next", exact: true }).click();
    }
    await popup.getByRole("button", { name: "Add my first task" }).click();
    await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
    await expect(outcome(page)).toBeFocused();
    await snap("first-run");
    await page.getByRole("region", { name: "Starting ideas" }).getByRole("button", { name: /Plan the week ahead/ }).click();
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("first-task-start-hint");
    await page.reload();
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("first-task-after-reload");
    await page.getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await snap("focus-running");
    await page.locator("#focus-timer").click();
    const dialog = page.locator(".pause-dialog");
    await pauseDialogReady(page);
    await snap("pause-dialog-first-time");
    await dialog.getByRole("button", { name: "Save reason", exact: true }).click();
    await snap("pause-dialog-empty-reason");
    await dialog.locator("textarea").fill("Coffee break");
    await snap("pause-dialog-typed");
    await dialog.getByRole("button", { name: "Save reason", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await synced(page);
    await snap("focus-paused");
    await page.locator("#focus-timer").click();
    await synced(page);
    await expect(page.locator("#focus-timer")).not.toHaveClass(/is-paused/);
    await snap("focus-resumed");
    await page.locator(".focus-notes textarea").fill("Intro done. Next: examples");
    await snap("focus-notes");
    await page.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(page.locator(".task.is-completed")).toHaveCount(1);
    await synced(page);
    await snap("first-completion-progress-hint");
    await page.getByRole("button", { name: "Open Overview", exact: true }).click();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await expect(page.locator(".review-countdown")).toBeVisible();
    await snap("overview-after-first-completion");
  });

  test("tour with a planned task", async ({ page, snap, backend }) => {
    backend.data.todayTasks = [task(backend.data, { id: "existing" })];
    backend.data.completions = [{ day: backend.data.today, count: 3 }];
    await page.goto("/");
    const popup = page.locator(".tour-popup");
    await expect(popup).toBeVisible();
    const titles = ["Your task is here", "Adjust your estimate", "Plan ahead", "See your progress", "Ready to focus?"];
    for (const [index, title] of titles.entries()) {
      await expect(popup.getByRole("heading")).toHaveText(title);
      await snap(`tour-${index + 1}`);
      if (index < 4) await popup.getByRole("button", { name: "Next", exact: true }).click();
    }
    await popup.getByRole("button", { name: "Start focusing" }).click();
    await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await snap("focus-started-from-tour");
  });

  test("leaving the tour early", async ({ page, snap, backend }) => {
    backend.data.todayTasks = [task(backend.data, { id: "existing" })];
    await page.goto("/");
    const popup = page.locator(".tour-popup");
    await expect(popup).toBeVisible();
    await popup.getByRole("button", { name: "Next", exact: true }).click();
    await popup.getByRole("button", { name: "Next", exact: true }).click();
    await expect(popup.getByRole("heading")).toHaveText("Plan ahead");
    await page.keyboard.press("Escape");
    await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
    await expect(page.locator("#app")).toHaveAttribute("data-view", "today");
    await snap("escaped");
    await page.reload();
    await expect(page.locator(".plan-summary")).toBeVisible();
    await snap("not-offered-again");
  });

  test("declining the last tour step", async ({ page, snap, backend }) => {
    backend.data.todayTasks = [task(backend.data, { id: "existing" })];
    await page.goto("/");
    const popup = page.locator(".tour-popup");
    await expect(popup).toBeVisible();
    for (let step = 0; step < 4; step++)
      await popup.getByRole("button", { name: "Next", exact: true }).click();
    await popup.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(page.locator(".planner-tour-dialog")).toHaveCount(0);
    await snap("declined");
  });
});

test.describe("planner", () => {
  test.use({ signedIn: true });

  test("planning a day on a laptop", async ({ page, snap, backend }) => {
    backend.data.completions = [{ day: dayKey(backend.now - DAY), count: 2 }];
    backend.suggestions = [
      { outcome: "Finish the slides", estimatedMinutes: 25, basis: "carry_over" },
      { outcome: "Send the recap", estimatedMinutes: 15, basis: "follow_up" },
    ];
    await openPlanner(page);
    await expect(page.locator(".suggestions")).toBeVisible();
    await snap("today-empty");
    await outcome(page).fill("Write the brief 45m");
    await snap("quick-entry-chip");
    await outcome(page).press("Enter");
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("one-task");
    await page.getByRole("region", { name: "Suggested from yesterday" }).getByRole("button", { name: /Finish the slides/ }).click();
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(2);
    await snap("two-tasks");
    await outcome(page).fill("Review pull requests");
    const formDial = page.locator(".task-form").getByRole("slider");
    await formDial.focus();
    await formDial.press("ArrowUp");
    await formDial.press("PageDown");
    await formDial.press("End");
    await formDial.press("ArrowLeft");
    await snap("form-dial-adjusted");
    await addButton(page).click();
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(3);
    await snap("three-tasks");

    await page.getByRole("button", { name: "Edit task title: Finish the slides" }).click();
    const title = page.getByRole("textbox", { name: "Task title" });
    await expect(title).toBeFocused();
    await snap("title-editing");
    await title.fill("Finish the keynote slides");
    await title.press("Enter");
    await synced(page);
    await expect(page.getByRole("button", { name: "Edit task title: Finish the keynote slides" })).toBeVisible();
    await snap("title-renamed");
    await page.getByRole("button", { name: "Edit task title: Finish the keynote slides" }).click();
    await page.getByRole("textbox", { name: "Task title" }).press("Escape");
    await snap("title-edit-cancelled");
    const dial = page.locator(".task").first().getByRole("slider");
    await dial.press("ArrowDown");
    await synced(page);
    await expect(dial).toHaveAttribute("aria-valuenow", "40");
    await snap("estimate-changed");

    await nav(page, "Tomorrow").click();
    await expect(page.locator(".suggestions")).toBeVisible();
    await snap("tomorrow-empty");
    await addTask(page, "Plan the offsite");
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("tomorrow-one-task");
    await page.keyboard.press("t");
    await expect(page.locator("#app")).toHaveAttribute("data-view", "today");
    await snap("key-today");
    await page.keyboard.press("?");
    await expect(page.locator(".shortcut-sheet")).toBeVisible();
    await snap("shortcut-sheet");
    await page.keyboard.press("Escape");
    await expect(page.locator(".shortcut-sheet")).toHaveCount(0);
    await page.keyboard.press("m");
    await expect(page.locator("#app")).toHaveAttribute("data-view", "tomorrow");
    await page.keyboard.press("n");
    await expect(outcome(page)).toBeFocused();
    await snap("key-new-outcome");
    await blur(page);
    await page.keyboard.press("f");
    await expect(page.locator("#app")).toHaveAttribute("data-view", "focus");
    await snap("focus-without-task");
    await page.keyboard.press("o");
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await expect(page.locator(".review-countdown")).toBeVisible();
    await snap("key-overview");
    await page.keyboard.press("t");

    await page.locator(".task").nth(1).getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await snap("focus-second-task");
    await page.locator("#focus-timer").click();
    const dialog = page.locator(".pause-dialog");
    await pauseDialogReady(page);
    await dialog.getByRole("button", { name: "Resume focusing", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await synced(page);
    await snap("resumed-without-reason");
    await blur(page);
    await page.keyboard.press("Space");
    await pauseDialogReady(page);
    await page.keyboard.press("Escape");
    await snap("pause-dialog-ignores-escape");
    await dialog.locator("textarea").fill("Handling an interruption");
    await dialog.getByRole("button", { name: "Save reason", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await synced(page);
    await nav(page, "Today").click();
    await expect(page.getByRole("button", { name: "Return to focus", exact: true })).toBeVisible();
    await snap("today-with-paused-task");
    await page.getByRole("button", { name: "Return to focus", exact: true }).click();
    await page.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(page.locator(".task.is-completed")).toHaveCount(1);
    await synced(page);
    await snap("today-one-completed");
    await page.getByRole("complementary", { name: "Tip" }).getByRole("button", { name: "Got it", exact: true }).click();
    await snap("progress-hint-dismissed");
  });

  test("focus states", async ({ page, snap, backend }) => {
    const seconds = backend.data.serverNow;
    const active = task(backend.data, { id: "active", outcome: "Write the first draft", status: "active", startedAt: seconds - 600, actualSeconds: 300, estimatedMinutes: 45 });
    backend.data.todayTasks = [
      task(backend.data, { id: "done", outcome: "Call the accountant", status: "completed", completedOn: backend.data.today, actualSeconds: 1500, estimatedMinutes: 20 }),
      active,
      task(backend.data, { id: "planned", outcome: "Ship the small update", estimatedMinutes: 25 }),
    ];
    backend.data.tomorrowTasks = [
      task(backend.data, { id: "later", outcome: "Outline the talk", plannedFor: backend.data.tomorrow, estimatedMinutes: 60 }),
    ];
    backend.data.activeTask = structuredClone(active);
    backend.data.completions = [{ day: backend.data.today, count: 1 }, { day: dayKey(backend.now - DAY), count: 3 }];
    await page.goto("/");
    await expect(page.locator("#focus-timer")).toBeVisible();
    await snap("running-and-locked");
    await page.locator("#focus-timer").click();
    const dialog = page.locator(".pause-dialog");
    await pauseDialogReady(page);
    await dialog.locator("textarea").fill("Interrupted");
    await dialog.getByRole("button", { name: "Save reason", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await synced(page);
    await snap("paused");
    await nav(page, "Today").click();
    await expect(page.locator(".task")).toHaveCount(3);
    await snap("today-mixed");
    await nav(page, "Tomorrow").click();
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("tomorrow-while-paused");
    await nav(page, "Focus").click();
    await page.getByRole("button", { name: "Edit task title: Write the first draft" }).click();
    await page.getByRole("textbox", { name: "Task title" }).fill("Write the second draft");
    await page.getByRole("textbox", { name: "Task title" }).blur();
    await synced(page);
    await snap("focus-title-renamed");
    await page.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(page.locator(".task.is-completed")).toHaveCount(2);
    await synced(page);
    await snap("two-completed");
    await page.getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await page.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(page.locator(".task.is-completed")).toHaveCount(3);
    await synced(page);
    await snap("day-complete");
    await nav(page, "Tomorrow").click();
    await snap("tomorrow-after-day-complete");
    await nav(page, "Overview").click();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /Daily reminder/ })).toBeVisible();
    await snap("profile-after-day-complete");
  });

  test("an overdue timer", async ({ page, snap, backend }) => {
    const seconds = backend.data.serverNow;
    const active = task(backend.data, { id: "late", outcome: "Reply to the client", status: "active", startedAt: seconds - 10, actualSeconds: 400, estimatedMinutes: 5 });
    backend.data.todayTasks = [active];
    backend.data.activeTask = structuredClone(active);
    await page.goto("/");
    await expect(page.locator("#focus-timer")).toHaveClass(/is-overdue/);
    await snap("overdue");
  });

  test("no shortcut tip on early visits", async ({ page, snap }) => {
    await openPlanner(page);
    await snap("without-tip");
  });

  test("sync conflict", async ({ page, snap, backend }) => {
    await openPlanner(page);
    backend.rejectWrites = true;
    await outcome(page).fill("A change the server rejects");
    await addButton(page).click();
    await expect(page.locator(".sync-bar")).toBeVisible();
    await steadyFocus(page);
    await snap("sync-blocked");
    await outcome(page).fill("Blocked while unresolved");
    await addButton(page).click();
    await expect(page.locator("#app > .error")).toContainText("Resolve the sync conflict");
    await steadyFocus(page);
    await snap("blocked-second-change");
    backend.rejectWrites = false;
    await page.getByRole("button", { name: "Discard rejected changes", exact: true }).click();
    await expect(page.locator(".sync-bar")).toBeHidden();
    await expect(page.locator(".task")).toHaveCount(0);
    await steadyFocus(page);
    await snap("discarded");
  });

  test("overview and weekly reviews", async ({ page, snap, backend }) => {
    const now = backend.now;
    backend.data.completions = [
      { day: dayKey(now), count: 2 },
      { day: dayKey(now - DAY), count: 3 },
      { day: dayKey(now - 2 * DAY), count: 1 },
      { day: dayKey(now - 5 * DAY), count: 4 },
      { day: dayKey(now - 20 * DAY), count: 1 },
      { day: dayKey(now - 45 * DAY), count: 2 },
      { day: dayKey(now - 400 * DAY), count: 3 },
    ];
    const open = async (text: string | RegExp) => {
      await openPlanner(page);
      await nav(page, "Overview").click();
      await expect(page.locator(".weekly-overview")).toContainText(text);
    };
    await open("Next review");
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await snap("no-data");
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await snap("previous-month");
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await page.locator('.activity-grid [tabindex="0"]').focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await snap("two-months-back-keyboard");
    await page.keyboard.press("Home");
    await snap("grid-home");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await snap("grid-end");
    for (let month = 0; month < 9; month++)
      await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.getByRole("button", { name: "Previous month" })).toBeDisabled();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await snap("earliest-month");
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await snap("next-month");

    backend.monthStats = null;
    await open("Next review");
    await expect(page.locator(".activity-calendar:not(.has-stats)")).toBeVisible();
    await snap("stats-unavailable");
    backend.monthStats = { planned: 0, completed: 0, focusSeconds: 0 };
    await open("Next review");
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await snap("stats-nothing-planned");
    backend.monthStats = { planned: 9, completed: 7, focusSeconds: 13_500 };

    backend.weekly = { ...backend.weekly, status: "up_to_date", reviews: [review(now, 1), review(now, 2), review(now, 3)] };
    await open("What to improve on this week");
    await snap("review-ready");
    await page.locator(".weekly-history > summary").first().click();
    await snap("review-history-open");
    await page.locator(".review-evidence > summary").first().click();
    await snap("review-evidence-open");

    backend.weekly = { ...backend.weekly, status: "pending", reviews: [] };
    await open("is queued");
    await snap("review-pending");
    backend.weekly = { ...backend.weekly, status: "running" };
    await open("You can keep using prune");
    await snap("review-running");
    backend.weekly = { ...backend.weekly, status: "failed", error: "The AI was unavailable." };
    await open("We’ll retry automatically");
    await snap("review-failed");
    backend.weekly = { ...backend.weekly, status: "failed", error: null };
    await open("could not be generated");
    await snap("review-failed-without-reason");
    backend.weekly = { ...backend.weekly, status: "unavailable", available: false, error: null };
    await open("temporarily unavailable");
    await snap("review-unavailable");
    backend.weekly = { ...backend.weekly, status: "disabled", available: true, settings: { enabled: false } };
    await open("Weekly reviews are off");
    await snap("review-disabled");
    await page.getByRole("button", { name: "Turn on weekly reviews", exact: true }).click();
    await expect(page.locator(".review-countdown")).toBeVisible();
    await steadyFocus(page);
    await snap("review-turned-on");

    backend.failWeekly = true;
    await openPlanner(page);
    await nav(page, "Overview").click();
    await expect(page.getByRole("button", { name: "Retry loading", exact: true })).toBeVisible();
    await snap("review-load-failed");
    backend.failWeekly = false;
    await page.getByRole("button", { name: "Retry loading", exact: true }).click();
    await expect(page.locator(".review-countdown")).toBeVisible();
    await steadyFocus(page);
    await snap("review-loaded-after-retry");
  });

  test("profile", async ({ page, snap, backend }) => {
    const now = backend.now;
    backend.data.todayTasks = [
      task(backend.data, { id: "done", outcome: "Call the accountant", status: "completed", completedOn: backend.data.today, actualSeconds: 4500, estimatedMinutes: 20 }),
      task(backend.data, { id: "planned", outcome: "Ship the small update", estimatedMinutes: 50 }),
    ];
    backend.data.completions = [
      { day: dayKey(now), count: 1 },
      { day: dayKey(now - DAY), count: 3 },
      { day: dayKey(now - 2 * DAY), count: 2 },
      { day: dayKey(now - 9 * DAY), count: 1 },
      { day: dayKey(now - 10 * DAY), count: 1 },
      { day: dayKey(now - 11 * DAY), count: 2 },
      { day: dayKey(now - 12 * DAY), count: 3 },
      { day: dayKey(now - 60 * DAY), count: 1 },
    ];
    await openPlanner(page);
    await nav(page, "Overview").click();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    const daily = page.getByRole("checkbox", { name: /Daily reminder/ });
    const comeback = page.getByRole("checkbox", { name: /Come-back reminder/ });
    await expect(daily).toBeVisible();
    await snap("profile");
    await daily.uncheck();
    await expect.poll(() => backend.emailPreferences.daily).toBe(false);
    await expect(daily).toBeEnabled();
    await steadyFocus(page);
    await snap("daily-reminder-off");
    backend.offline = true;
    await comeback.click();
    await expect(page.getByText("Could not save.")).toBeVisible();
    await steadyFocus(page);
    await snap("reminder-save-failed");
    backend.offline = false;
    await page.locator(".profile-links").getByRole("button", { name: "Terms & Privacy", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close privacy policy" }).click();
    await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
    const banner = page.getByRole("region", { name: "Cookie preferences" });
    await expect(banner).toBeVisible();
    await snap("cookie-settings");
    await banner.getByRole("button", { name: "Accept optional", exact: true }).click();
    await expect(banner).toHaveCount(0);
    await snap("cookies-accepted");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await snap("signed-out");
  });

  test("deleting the account", async ({ page, snap }) => {
    await openPlanner(page);
    await nav(page, "Overview").click();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(page.getByRole("link", { name: "Get started", exact: true })).toBeVisible();
    await snap("deleted");
  });
});

test.describe("returning often", () => {
  test.use({ signedIn: true, visits: 5 });

  test("keyboard shortcut tip", async ({ page, snap }) => {
    await openPlanner(page);
    await expect(page.locator(".shortcut-hint")).toBeVisible();
    await snap("tip");
    await page.getByRole("button", { name: /keyboard shortcuts/ }).click();
    await expect(page.locator(".shortcut-sheet")).toBeVisible();
    await snap("sheet-from-tip");
    await page.locator(".shortcut-sheet").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".shortcut-sheet")).toHaveCount(0);
    await snap("sheet-closed");
    await page.getByRole("button", { name: "Hide shortcut tip", exact: true }).click();
    await expect(page.locator(".shortcut-hint")).toHaveCount(0);
    await snap("tip-hidden");
  });
});

test.describe("evening", () => {
  test.use({ signedIn: true, now: EVENING });

  test("evening planning card", async ({ page, snap, backend }) => {
    backend.data.todayTasks = [task(backend.data, { id: "open" })];
    backend.data.completions = [{ day: dayKey(backend.now - DAY), count: 3 }];
    await openPlanner(page);
    await expect(page.locator(".evening-card")).toBeVisible();
    await snap("evening-card");
    await page.getByRole("button", { name: "Not tonight", exact: true }).click();
    await expect(page.locator(".evening-card")).toHaveCount(0);
    await snap("not-tonight");
    await page.reload();
    await expect(page.locator(".plan-summary")).toBeVisible();
    await snap("stays-dismissed");
  });

  test("evening card opens tomorrow", async ({ page, snap, backend }) => {
    backend.data.todayTasks = [task(backend.data, { id: "open" })];
    backend.data.completions = [{ day: dayKey(backend.now - DAY), count: 3 }];
    await openPlanner(page);
    await page.getByRole("button", { name: "Plan tomorrow", exact: true }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-view", "tomorrow");
    await snap("tomorrow");
  });
});

test.describe("phone", () => {
  test.use({ signedIn: true, ...PHONE });

  test("planning and focusing on a phone", async ({ page, snap }) => {
    await openPlanner(page);
    await snap("today-empty");
    await outcome(page).fill("Keep my draft");
    await addButton(page).click();
    const dialog = page.getByRole("dialog", { name: "How much time will this task take to complete?" });
    await expect(dialog).toBeVisible();
    await snap("estimate-dialog");
    await dialog.getByRole("slider").press("ArrowUp");
    await snap("estimate-dialog-adjusted");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await snap("estimate-cancelled");
    await addButton(page).click();
    await dialog.getByRole("button", { name: "Add task", exact: true }).click();
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(1);
    await snap("one-task");
    await outcome(page).fill("Quick call 20m");
    await addButton(page).click();
    await synced(page);
    await expect(page.locator(".task")).toHaveCount(2);
    await snap("two-tasks");
    await page.getByRole("button", { name: "Start focus", exact: true }).first().click();
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await snap("focus");
    await page.locator("#focus-timer").click();
    await pauseDialogReady(page);
    await snap("pause-dialog");
    await page.locator(".pause-dialog textarea").fill("On the move");
    await page.locator(".pause-dialog").getByRole("button", { name: "Save reason", exact: true }).click();
    await expect(page.locator(".pause-dialog")).toHaveCount(0);
    await synced(page);
    await nav(page, "Overview").click();
    await expect(page.locator(".activity-stats:not([aria-busy])")).toBeVisible();
    await expect(page.locator(".review-countdown")).toBeVisible();
    await snap("overview");
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /Daily reminder/ })).toBeVisible();
    await snap("profile");
  });
});

test.describe("pixel background", () => {
  test.use({ signedIn: true });

  test("artwork per completion level", async ({ page, snap, backend }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const level of [0, 1, 2]) {
      backend.data.completions = level ? [{ day: backend.data.today, count: level }] : [];
      await page.goto("/");
      await expect(page.locator(`#app[data-completion-level="${level}"]`)).toBeVisible();
      await page.waitForTimeout(250);
      await snap(`level-${level}`, { canvas: true });
    }
    // Finishing a task in the page lights the last tier without a reload.
    await addTask(page, "Light the last tier");
    await page.getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.locator("#focus-timer")).toBeVisible();
    await synced(page);
    await page.getByRole("button", { name: "Complete task", exact: true }).click();
    await expect(page.locator('#app[data-completion-level="3"]')).toBeVisible();
    await synced(page);
    await page.waitForTimeout(250);
    await snap("level-3-live", { canvas: true });
    await page.reload();
    await expect(page.locator('#app[data-completion-level="3"]')).toBeVisible();
    await page.waitForTimeout(250);
    await snap("level-3-reloaded", { canvas: true });
  });
});
