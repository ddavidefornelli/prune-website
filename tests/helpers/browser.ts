import { Buffer } from "node:buffer";
import { test as base, expect, type Page } from "@playwright/test";
import { project } from "../../src/planner/task-projection";
import type { QueuedAction } from "../../src/planner/commands";
import type { Dashboard, TaskSuggestion, WeeklyOverview, WeeklyReview } from "../../src/planner/types";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../../src/planner/privacy-state";

export const PROJECT = "https://web-fixture.supabase.co";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const AUTH_KEY = `prune:auth:${PROJECT}`;
export const QUEUE_KEY = `pro:planner:v1:${PROJECT}:${USER_ID}`;
export const user = { id: USER_ID, aud: "authenticated", role: "authenticated", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: { provider: "google", providers: ["google"] }, user_metadata: {}, identities: [], created_at: "2026-01-01T00:00:00Z", is_anonymous: false };
export function session(expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return { access_token: `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER_ID, aud: "authenticated", role: "authenticated", exp: now + expiresIn, iat: now, email: user.email })}.fixture`, refresh_token: `fixture-refresh-${expiresIn}`, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, user };
}
const day = () => new Date().toISOString().slice(0, 10);
export function dashboard(): Dashboard {
  return { revision: 0, today: day(), tomorrow: new Date(Date.now() + 86400000).toISOString().slice(0, 10), todayTasks: [], tomorrowTasks: [], activeTask: null, canPlanTomorrow: true, completions: [], serverNow: Math.floor(Date.now() / 1000) };
}
function overview(): WeeklyOverview {
  return { settings: { enabled: true }, model: "gpt-4.1-mini", available: true, week: { start: day(), end: day(), nextUpdate: day(), nextUpdateAt: new Date(Date.now() + 5 * 86400000).toISOString() }, status: "no_data", error: null, reviews: [] };
}
export function review(): WeeklyReview {
  return { weekStart: day(), weekEnd: day(), generatedAt: Math.floor(Date.now() / 1000), model: "gpt-4.1-mini", activity: { tasks: [], stops: [], totalStops: 0, omittedStops: 0 }, analysis: { summary: "A steady start.", mainReasons: [], improvements: ["Keep your first focus session small."] } };
}
export interface RequestLog { path: string; body: Record<string, any>; authorization: string | undefined }
export interface Backend {
  data: Dashboard;
  weekly: WeeklyOverview;
  requests: RequestLog[];
  stops: string[];
  offline: boolean;
  rejectWrites: boolean;
  isDeleted: boolean;
  loseNextAcknowledgement: boolean;
  malformedAcknowledgement: boolean;
  /** The Google provider is switched off in the fixture project's Auth settings. */
  googleDisabled: boolean;
  /** The visitor backs out on Google's consent screen. */
  googleCancelled: boolean;
  previewStatus: number;
  suggestions: TaskSuggestion[];
  protocolVersion: number;
  receipts: Map<string, unknown>;
}

export const test = base.extend<{ backend: Backend; signedIn: boolean; expired: boolean; firstVisit: boolean }>({
  signedIn: [false, { option: true }],
  expired: [false, { option: true }],
  firstVisit: [false, { option: true }],
  backend: async ({ context, signedIn, expired, firstVisit }, use) => {
    const state: Backend = { data: dashboard(), weekly: overview(), requests: [], stops: [], offline: false, rejectWrites: false, isDeleted: false, loseNextAcknowledgement: false, malformedAcknowledgement: false, googleDisabled: false, googleCancelled: false, previewStatus: 200, suggestions: [], protocolVersion: 1, receipts: new Map() };
    // Seed once per browser context, not on reload/sign-out or each new tab.
    await context.addInitScript(({ signedIn, initialSession, authKey, privacyKey, version, firstVisit, onboardingKey, tourKey }) => {
      if (localStorage.getItem("prune:test:seeded")) return;
      localStorage.setItem("prune:test:seeded", "true");
      // Most workflows are returning visits. Dedicated cookie/onboarding specs
      // exercise the first-visit prompts without these fixture preferences.
      localStorage.setItem("prune:cookies:v1", JSON.stringify({ choice: "rejected", at: Date.now() }));
      if (!firstVisit) {
        localStorage.setItem(onboardingKey, "done");
        localStorage.setItem(tourKey, "done");
      }
      if (signedIn) {
        localStorage.setItem(privacyKey, JSON.stringify({ version, acknowledgedAt: new Date().toISOString() }));
        localStorage.setItem(authKey, JSON.stringify(initialSession));
      }
    }, { signedIn, initialSession: session(expired ? -10 : 3600), authKey: AUTH_KEY, privacyKey: PRIVACY_ACKNOWLEDGEMENT_KEY, version: PRIVACY_POLICY_VERSION, firstVisit, onboardingKey: `prune:onboarding:v1:${PROJECT}:${USER_ID}`, tourKey: `prune:tour:v1:${PROJECT}:${USER_ID}` });
    await context.route(`${PROJECT}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
      const send = async (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(value) });
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      const body = request.postDataJSON() ?? {};
      state.requests.push({ path: url.pathname + url.search, body, authorization: request.headers().authorization });
      if (url.pathname === "/auth/v1/settings") { await send({ external: { google: !state.googleDisabled } }); return; }
      if (url.pathname === "/auth/v1/authorize") {
        // Stand in for Google and Supabase: return straight to the PKCE callback.
        const callback = new URL(url.searchParams.get("redirect_to")!);
        if (state.googleCancelled) {
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("error_description", "private-diagnostic");
        } else callback.searchParams.set("code", "fixture-oauth-code");
        // WebKit cannot fulfill navigations with a 3xx; an immediate refresh is equivalent here.
        await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${callback.toString().replaceAll("&", "&amp;")}">` });
        return;
      }
      if (url.pathname === "/auth/v1/user") { await send(user); return; }
      if (url.pathname === "/auth/v1/token") { await send(session()); return; }
      if (url.pathname === "/auth/v1/logout") { await route.fulfill({ status: 204, headers }); return; }
      if (url.pathname === "/functions/v1/weekly-review") {
        if (state.previewStatus !== 200) { await send({ error: { code: "rate_limited", message: "untrusted provider text" } }, state.previewStatus); return; }
        await send(body.preview ? { review: review() } : {});
        return;
      }
      if (url.pathname === "/functions/v1/task-suggestions") { await send({ day: body.target === "tomorrow" ? state.data.tomorrow : state.data.today, suggestions: state.suggestions }); return; }
      if (url.pathname !== "/rest/v1/rpc/planner_call") { await send({ error: "Unexpected fixture route" }, 404); return; }
      if (state.offline) { await route.abort("internetdisconnected"); return; }
      const action = body.p_action;
      const args = body.p_args ?? {};
      if (action === "account_status") { await send({ isDeleted: state.isDeleted }); return; }
      if (action === "delete_account") {
        state.isDeleted = true;
        state.weekly.settings.enabled = false;
        await send({ isDeleted: true }); return;
      }
      if (state.isDeleted) { await send({ code: "PT403", message: "This account has been marked for deletion." }, 403); return; }
      if (action === "queue_protocol") { await send({ version: state.protocolVersion }); return; }
      if (action === "dashboard") { await send({ ...state.data, serverNow: Math.floor(Date.now() / 1000) }); return; }
      if (action === "weekly_overview") { await send(state.weekly); return; }
      if (action === "set_weekly_ai_enabled") {
        if (args.enabled !== true) { await send({ code: "PT400", message: "Weekly reviews are part of prune and cannot be turned off." }, 400); return; }
        state.weekly.settings.enabled = true;
        state.weekly.status = "up_to_date";
        await send(state.weekly);
        return;
      }
      if (state.rejectWrites) { await send({ code: "PT409", message: "Another device changed your plan." }, 409); return; }
      if (state.receipts.has(args._requestId)) { await send(state.receipts.get(args._requestId)); return; }
      if (args._revision !== state.data.revision) { await send({ code: "PT409", message: "Planner revision changed." }, 409); return; }
      if (action === "create_task" && [...state.data.todayTasks, ...state.data.tomorrowTasks].filter((task) => task.plannedFor === args.day).length >= 3) {
        await send({ code: "PT400", message: "Plan at most three tasks." }, 400); return;
      }
      const command: QueuedAction = { requestId: args._requestId, action, args, timezone: body.p_timezone, at: args._at, revision: args._revision };
      const previousTask = state.data.activeTask;
      state.data = project(state.data, command);
      const task = [...state.data.todayTasks, ...state.data.tomorrowTasks, ...(state.data.activeTask ? [state.data.activeTask] : [])].find((item) => item.id === (action === "create_task" ? args._requestId : args.id)) ?? previousTask;
      if (action === "save_pause_reason") state.stops.push(args.reason);
      const result = { ...task, serverRevision: state.data.revision };
      state.receipts.set(args._requestId, structuredClone(result));
      if (state.loseNextAcknowledgement) { state.loseNextAcknowledgement = false; await route.abort("connectionreset"); return; }
      await send(state.malformedAcknowledgement ? {} : result);
    });
    await use(state);
  },
  page: async ({ page, backend }, use) => {
    const errors: string[] = [];
    const unexpected: string[] = [];
    const sameOriginTracking: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["127.0.0.1", "web-fixture.supabase.co"].includes(url.hostname)) unexpected.push(url.hostname);
      if (/^\/_vercel\/(?:insights|speed-insights)(?:\/|$)/.test(url.pathname)) sameOriginTracking.push(url.pathname);
    });
    await use(page);
    expect(errors, "No uncaught browser exceptions").toEqual([]);
    expect(unexpected, "Private signup/planner must not load third-party trackers").toEqual([]);
    expect(sameOriginTracking, "Private signup/planner must not send same-origin Vercel analytics").toEqual([]);
    void backend;
  },
});
export { expect };
export async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible();
  await expect(page.locator(".plan-summary")).toBeVisible();
  await expect(page.locator(".task-form .add-task")).toBeEnabled();
}
/** Signed-out visitors land on sign-in: Google is the only way in. */
export async function openSignIn(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google", exact: true }).first()).toBeVisible();
}
export async function visitProfile(page: Page) {
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
}
export async function addTask(page: Page, outcome: string) {
  await page.getByRole("textbox", { name: "Outcome", exact: true }).fill(outcome);
  await page.locator(".task-form").getByRole("button", { name: "Add task", exact: true }).click();
  if (await page.evaluate(() => window.matchMedia("(max-width: 759px)").matches)) {
    await page.getByRole("dialog", { name: "How much time will this task take to complete?" })
      .getByRole("button", { name: "Add task", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: `Edit task title: ${outcome}`, exact: true })).toBeVisible();
}
export async function pendingCount(page: Page) {
  return page.evaluate((key) => {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved).pending.length : -1;
  }, QUEUE_KEY);
}
export async function synced(page: Page) {
  await expect.poll(() => pendingCount(page)).toBe(0);
  await expect(page.locator('main .add-task:disabled, main .estimate-dial[aria-disabled="true"], #focus-timer:disabled')).toHaveCount(0);
}
