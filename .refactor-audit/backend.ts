import { Buffer } from "node:buffer";
import { test as base, expect, type Page } from "@playwright/test";
import { PORT } from "./audit.config.ts";
import type { QueuedAction } from "./oracle/commands.ts";
import { project } from "./oracle/task-projection.ts";
import type {
  Dashboard,
  MonthStats,
  Task,
  TaskSuggestion,
  WeeklyOverview,
  WeeklyReview,
} from "./oracle/types.ts";
import { snapper, type Snap } from "./snapshot.ts";

export { expect };
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const PROJECT = "https://web-fixture.supabase.co";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT = `${PROJECT}:${USER_ID}`;
export const AUTH_KEY = `prune:auth:${PROJECT}`;
export const QUEUE_KEY = `pro:planner:v1:${ACCOUNT}`;
const PRIVACY_KEY = "prune:privacy:acknowledgement";
const PRIVACY_VERSION = "privacy-web-v15";
const DAY = 86_400_000;

/** Wednesday morning; every clock in the page and the fixture reads this. */
export const MORNING = Date.UTC(2026, 10, 11, 10, 0, 0);
export const EVENING = Date.UTC(2026, 10, 11, 18, 30, 0);

export const user = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00Z",
  is_anonymous: false,
};

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function session(now: number) {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    access_token: `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER_ID, aud: "authenticated", role: "authenticated", exp: seconds + 3600, iat: seconds, email: user.email })}.fixture`,
    refresh_token: "fixture-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: seconds + 3600,
    user,
  };
}

export function emptyDashboard(now: number): Dashboard {
  return {
    revision: 0,
    today: dayKey(now),
    tomorrow: dayKey(now + DAY),
    todayTasks: [],
    tomorrowTasks: [],
    activeTask: null,
    canPlanTomorrow: true,
    completions: [],
    serverNow: Math.floor(now / 1000),
  };
}

export function task(data: Dashboard, overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    outcome: "Write the first draft",
    isPriority: false,
    plannedFor: data.today,
    estimatedMinutes: 30,
    actualSeconds: 0,
    status: "planned",
    startedAt: null,
    completedOn: null,
    createdAt: data.serverNow,
    resources: [],
    ...overrides,
  };
}

function overview(now: number): WeeklyOverview {
  return {
    settings: { enabled: true },
    model: "gpt-4.1-mini",
    available: true,
    week: {
      start: dayKey(now - 2 * DAY),
      end: dayKey(now + 4 * DAY),
      nextUpdate: dayKey(now + 4 * DAY),
      nextUpdateAt: new Date(now + 4 * DAY + 6 * 3_600_000).toISOString(),
    },
    status: "no_data",
    error: null,
    reviews: [],
  };
}

/** A full report: stop patterns with evidence, timings in and outside margin. */
export function review(now: number, weeksAgo = 1): WeeklyReview {
  const start = now - (weeksAgo * 7 + 2) * DAY;
  const day = (offset: number) => dayKey(start + offset * DAY);
  return {
    weekStart: day(0),
    weekEnd: day(6),
    generatedAt: Math.floor((start + 6 * DAY) / 1000),
    model: "gpt-4.1-mini",
    activity: {
      tasks: [
        { id: "a", outcome: "Outline the talk", plannedFor: day(0), completedOn: day(0), status: "completed", estimatedMinutes: 30, actualSeconds: 2700 },
        { id: "b", outcome: "Book the dentist", plannedFor: day(1), completedOn: day(2), status: "completed", estimatedMinutes: 10, actualSeconds: 480 },
        { id: "c", outcome: "Ship the small update", plannedFor: day(3), completedOn: day(3), status: "completed", estimatedMinutes: 45, actualSeconds: 0 },
        { id: "d", outcome: "Clear my inbox", plannedFor: day(4), completedOn: null, status: "planned", estimatedMinutes: 20, actualSeconds: 300 },
      ],
      stops: [
        { id: 1, taskId: "a", reason: "Phone call from the office", stoppedOn: day(0) },
        { id: 2, taskId: "a", reason: "Slack kept pinging", stoppedOn: day(0) },
        { id: 3, taskId: "b", reason: "Lunch", stoppedOn: day(1) },
        { id: 4, taskId: "zz", reason: "Chat notifications again", stoppedOn: day(3) },
      ],
      totalStops: 6,
      omittedStops: 2,
    },
    analysis: {
      summary: "Interruptions from messages cut two sessions short.",
      mainReasons: [
        { reason: "Lunch breaks are normal; plan around them. (stop ids: 3)", evidenceStopIds: [3] },
        { reason: "Messages interrupted focus; mute chat while the timer runs.", evidenceStopIds: [2, 4, 2, 99, 1] },
      ],
      improvements: [
        "Mute notifications during focus sessions (stop IDs: 1, 2).",
        "Add ten minutes to writing estimates.",
      ],
    },
  };
}

export interface Backend {
  now: number;
  data: Dashboard;
  weekly: WeeklyOverview;
  requests: { path: string; body: Record<string, any> }[];
  stops: string[];
  offline: boolean;
  failDashboard: boolean;
  failWeekly: boolean;
  rejectWrites: boolean;
  isDeleted: boolean;
  googleDisabled: boolean;
  unsubscribeStatus: number;
  suggestions: TaskSuggestion[];
  monthStats: Omit<MonthStats, "month"> | null;
  emailPreferences: { daily: boolean; comeback: boolean };
  receipts: Map<string, unknown>;
  inFlight: number;
  /** Resolves once no fixture request has been in flight for a moment. */
  idle(): Promise<void>;
}

interface Options {
  /** The instant every clock reports. */
  now: number;
  signedIn: boolean;
  /** No tour/onboarding flags: the account looks new on this device. */
  firstVisit: boolean;
  /** A saved cookie choice hides the banner. */
  cookieChoice: boolean;
  /** Saved privacy acknowledgement without a session (signed-out visitors). */
  acknowledged: boolean;
  /** Page loads counted so far, for the shortcut hint. */
  visits: number;
}

export const test = base.extend<
  { backend: Backend; snap: Snap } & { [Key in keyof Options]: Options[Key] }
>({
  now: [MORNING, { option: true }],
  signedIn: [false, { option: true }],
  firstVisit: [false, { option: true }],
  cookieChoice: [true, { option: true }],
  acknowledged: [false, { option: true }],
  visits: [0, { option: true }],
  backend: async (
    { context, now, signedIn, firstVisit, cookieChoice, acknowledged, visits },
    use,
  ) => {
    await context.clock.setFixedTime(now);
    const state: Backend = {
      now,
      data: emptyDashboard(now),
      weekly: overview(now),
      requests: [],
      stops: [],
      offline: false,
      failDashboard: false,
      failWeekly: false,
      rejectWrites: false,
      isDeleted: false,
      googleDisabled: false,
      unsubscribeStatus: 204,
      suggestions: [],
      monthStats: { planned: 4, completed: 3, focusSeconds: 5400 },
      emailPreferences: { daily: true, comeback: true },
      receipts: new Map(),
      inFlight: 0,
      async idle() {
        let quiet = 0;
        while (quiet < 3) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          quiet = state.inFlight === 0 ? quiet + 1 : 0;
        }
      },
    };
    await context.addInitScript(
      (seed) => {
        if (localStorage.getItem("prune:test:seeded")) return;
        localStorage.setItem("prune:test:seeded", "true");
        if (seed.cookieChoice)
          localStorage.setItem(
            "prune:cookies:v1",
            JSON.stringify({ choice: "rejected", at: seed.now }),
          );
        if (!seed.firstVisit) {
          localStorage.setItem(`prune:onboarding:v1:${seed.account}`, "done");
          localStorage.setItem(`prune:tour:v1:${seed.account}`, "done");
        }
        if (seed.visits)
          localStorage.setItem(`prune:visits:v1:${seed.account}`, String(seed.visits));
        if (seed.signedIn || seed.acknowledged)
          localStorage.setItem(
            seed.privacyKey,
            JSON.stringify({
              version: seed.privacyVersion,
              acknowledgedAt: new Date(seed.now).toISOString(),
            }),
          );
        if (seed.signedIn)
          localStorage.setItem(seed.authKey, JSON.stringify(seed.session));
      },
      {
        now,
        signedIn,
        firstVisit,
        cookieChoice,
        acknowledged,
        visits,
        account: ACCOUNT,
        authKey: AUTH_KEY,
        privacyKey: PRIVACY_KEY,
        privacyVersion: PRIVACY_VERSION,
        session: session(now),
      },
    );
    await context.route(`${PROJECT}/**`, async (route) => {
      state.inFlight += 1;
      try {
        const request = route.request();
        const url = new URL(request.url());
        const headers = {
          "Access-Control-Allow-Origin": ORIGIN,
          "Access-Control-Allow-Headers":
            "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        };
        const send = (value: unknown, status = 200) =>
          route.fulfill({
            status,
            headers,
            contentType: "application/json",
            body: JSON.stringify(value),
          });
        if (request.method() === "OPTIONS")
          return await route.fulfill({ status: 204, headers });
        const body = request.postDataJSON() ?? {};
        state.requests.push({ path: url.pathname + url.search, body });
        switch (url.pathname) {
          case "/auth/v1/otp":
            return await send({});
          case "/auth/v1/verify": {
            const valid =
              body.email === user.email &&
              body.token === "12345678" &&
              body.type === "email";
            return await send(
              valid
                ? session(now)
                : { msg: "private upstream error", error_code: "invalid_credentials" },
              valid ? 200 : 400,
            );
          }
          case "/auth/v1/settings":
            return await send({
              external: { email: true, google: !state.googleDisabled },
            });
          case "/auth/v1/user":
            return await send(user);
          case "/auth/v1/token":
            return await send(session(now));
          case "/auth/v1/logout":
            return await route.fulfill({ status: 204, headers });
          case "/functions/v1/weekly-review":
            return await send({});
          case "/functions/v1/task-suggestions":
            return await send({
              day: body.target === "tomorrow" ? state.data.tomorrow : state.data.today,
              suggestions: state.suggestions,
            });
          case "/functions/v1/email-unsubscribe":
            return await route.fulfill({ status: state.unsubscribeStatus, headers });
          case "/rest/v1/rpc/planner_call":
            break;
          default:
            return await send({ error: "Unexpected fixture route" }, 404);
        }
        if (state.offline) return await route.abort("internetdisconnected");
        const action = body.p_action;
        const args = body.p_args ?? {};
        switch (action) {
          case "account_status":
            return await send({ isDeleted: state.isDeleted });
          case "delete_account":
            state.isDeleted = true;
            state.weekly.settings.enabled = false;
            return await send({ isDeleted: true });
        }
        if (state.isDeleted)
          return await send(
            { code: "PT403", message: "This account has been marked for deletion." },
            403,
          );
        switch (action) {
          case "queue_protocol":
            return await send({ version: 1 });
          case "dashboard":
            if (state.failDashboard) return await route.abort("internetdisconnected");
            return await send(state.data);
          case "weekly_overview":
            if (state.failWeekly) return await route.abort("internetdisconnected");
            return await send(state.weekly);
          case "email_preferences":
            return await send(state.emailPreferences);
          case "set_email_preferences":
            state.emailPreferences = {
              daily: args.daily === true,
              comeback: args.comeback === true,
            };
            return await send(state.emailPreferences);
          case "month_stats":
            if (!state.monthStats)
              return await send({ code: "PT400", message: "Unknown action." }, 400);
            return await send({ month: args.month, ...state.monthStats });
          case "set_weekly_ai_enabled":
            state.weekly.settings.enabled = true;
            state.weekly.status = "up_to_date";
            return await send(state.weekly);
        }
        if (state.rejectWrites)
          return await send(
            { code: "PT409", message: "Another device changed your plan." },
            409,
          );
        if (state.receipts.has(args._requestId))
          return await send(state.receipts.get(args._requestId));
        if (args._revision !== state.data.revision)
          return await send({ code: "PT409", message: "Planner revision changed." }, 409);
        const command: QueuedAction = {
          requestId: args._requestId,
          action,
          args,
          timezone: body.p_timezone,
          at: args._at,
          revision: args._revision,
        };
        const previousTask = state.data.activeTask;
        state.data = project(state.data, command);
        const saved =
          [
            ...state.data.todayTasks,
            ...state.data.tomorrowTasks,
            ...(state.data.activeTask ? [state.data.activeTask] : []),
          ].find(
            (item) =>
              item.id === (action === "create_task" ? args._requestId : args.id),
          ) ?? previousTask;
        if (action === "save_pause_reason") state.stops.push(args.reason);
        const result = { ...saved, serverRevision: state.data.revision };
        state.receipts.set(args._requestId, structuredClone(result));
        return await send(result);
      } finally {
        state.inFlight -= 1;
      }
    });
    await use(state);
  },
  page: async ({ page, backend }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => void dialog.accept());
    await use(page);
    expect(errors, "No uncaught browser exceptions").toEqual([]);
    void backend;
  },
  snap: async ({ page, backend }, use, testInfo) => {
    await use(snapper(page, testInfo, () => backend.idle()));
  },
});

export async function openPlanner(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible();
  await expect(page.locator("#planner-content > *").first()).toBeVisible();
}

/** Every queued change was acknowledged. */
export async function queueEmpty(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = localStorage.getItem(key);
        return saved ? JSON.parse(saved).pending.length : -1;
      }, QUEUE_KEY),
    )
    .toBe(0);
}

/** The pause dialog is open and its buttons are usable again. */
export async function pauseDialogReady(page: Page): Promise<void> {
  await expect(page.locator(".pause-dialog")).toBeVisible();
  await queueEmpty(page);
  await expect(page.locator(".pause-dialog button:disabled")).toHaveCount(0);
}

/**
 * WebKit drops focus from a control that is disabled while a change is being
 * saved, but only if a frame happens to render in that short window. That
 * race exists in the app before and after the refactor, so the audit takes
 * focus out of the picture there instead of recording a coin toss.
 */
export async function steadyFocus(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() !== "webkit") return;
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest("dialog")) active.blur();
  });
}

export async function synced(page: Page): Promise<void> {
  await queueEmpty(page);
  await expect(
    page.locator(
      'main .add-task:disabled, main .estimate-dial[aria-disabled="true"], #focus-timer:disabled',
    ),
  ).toHaveCount(0);
  await steadyFocus(page);
}

export const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true });

export async function addTask(page: Page, outcome: string): Promise<void> {
  await page.getByRole("textbox", { name: "Outcome", exact: true }).fill(outcome);
  await page
    .locator(".task-form")
    .getByRole("button", { name: "Add task", exact: true })
    .click();
  if (await page.evaluate(() => window.matchMedia("(max-width: 759px)").matches))
    await page
      .getByRole("dialog", { name: "How much time will this task take to complete?" })
      .getByRole("button", { name: "Add task", exact: true })
      .click();
  await synced(page);
}
