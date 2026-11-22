import { Buffer } from "node:buffer";
import { test as base, expect, type Page } from "@playwright/test";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PRIVACY_POLICY_VERSION } from "../../src/cloud/privacy-state";
import type { Task } from "../../src/tasks/types";

export const PROJECT = "https://web-fixture.supabase.co";
export const AUTH_KEY = `prune:auth:${PROJECT}`;
export const LIST_KEY = "prune:list:v1";
/** A returning guest's id, and the one an account from before guests has. */
export const GUEST_ID = "33333333-3333-4333-8333-333333333333";
export const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function user(id: string, guest: boolean) {
  return { id, aud: "authenticated", role: "authenticated", email: guest ? "" : "user@example.com", app_metadata: guest ? {} : { provider: "google", providers: ["google"] }, user_metadata: {}, identities: [], created_at: "2026-01-01T00:00:00Z", is_anonymous: guest };
}
/** `signedInAt`: when the session's sign-in happened (Supabase's amr claim), in seconds. */
export function session(id = GUEST_ID, guest = true, signedInAt = Math.floor(Date.now() / 1000), expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: id, aud: "authenticated", role: "authenticated", exp: now + expiresIn, iat: now, is_anonymous: guest, amr: [{ method: guest ? "anonymous" : "oauth", timestamp: signedInAt }], email: guest ? "" : "user@example.com" };
  return { access_token: `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.fixture`, refresh_token: `fixture-refresh-${id}`, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, user: user(id, guest) };
}
/** The claims inside a request's bearer token. */
function claims(authorization: string | undefined): { sub?: string; is_anonymous?: boolean; amr?: { timestamp: number }[] } {
  try {
    return JSON.parse(Buffer.from((authorization ?? "").split(".")[1] ?? "", "base64url").toString() || "{}");
  } catch {
    return {};
  }
}

let counter = 0;
/** A task already in the cloud, `minutesAgo` old. */
export function cloudTask(title: string, fields: Partial<Task> = {}, minutesAgo = 10): Task {
  counter += 1;
  const at = Date.now() - minutesAgo * 60_000 - counter;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return { id, title, done: false, createdAt: at, updatedAt: at, doneAt: null, ...fields };
}

export interface RequestLog { path: string; body: Record<string, any>; authorization: string | undefined }
export interface Backend {
  /** The list in the cloud, for whoever syncs. */
  tasks: Task[];
  requests: RequestLog[];
  /** Every planner_list sync body received, in order. */
  syncs: { save: Task[]; remove: string[] }[];
  /** Guest ids created (anonymous sign-ups), in order. */
  guests: string[];
  /** Anonymous sign-ins are switched off in the project. */
  guestsDisabled: boolean;
  /** Every backend call fails as if the network were down. */
  offline: boolean;
  /** List syncs answer with this HTTP error instead. */
  failSyncs: { status: number; body: unknown } | null;
  /** The account from before guests was deleted. */
  isDeleted: boolean;
  /** When it was deleted, in seconds: sessions signed in after it restore it. */
  deletedAt: number | null;
  /** New tasks are refused, as a full list would. */
  full: boolean;
  /** User ids the Auth server no longer knows (a cleaned-up guest). */
  removedUsers: string[];
  /** Whose sessions were refreshed, in order. */
  refreshes: string[];
  /** Refresh tokens are refused, as for a revoked session. */
  refreshRevoked: boolean;
  /** task-helper calls received, in order (the request body). */
  helperCalls: Record<string, any>[];
  /** Helper answers by task id; a working one is finished by the next "get". */
  helperRuns: Map<string, Record<string, any>>;
  /** Answers each user started. */
  helperStarts: Record<string, number>;
  /** Emails a sign-in code was sent to. */
  codesSent: string[];
  /** The list's share link token, once shared. */
  shareToken: string | null;
  /** How many people are in the shared list (the caller included); 1 while not shared. */
  people: number;
  /** The caller's role in the shared list, if any. */
  role: "owner" | "member" | null;
}

/** planner_list's merge: removals, then saves where the newest edit wins. */
function applySync(state: Backend, save: Task[], remove: string[]): string[] {
  const rejected: string[] = [];
  state.tasks = state.tasks.filter((task) => !remove.includes(task.id));
  for (const task of save) {
    const index = state.tasks.findIndex((saved) => saved.id === task.id);
    if (index === -1) {
      if (state.full) rejected.push(task.id);
      else state.tasks.push({ ...task, title: task.title.trim() });
    } else if (state.tasks[index].updatedAt <= task.updatedAt) {
      state.tasks[index] = { ...task, createdAt: state.tasks[index].createdAt };
    }
  }
  return rejected;
}

/**
 * Who opens the page: "new" (never used prune here), "guest" (a returning
 * guest who accepted the current notice) or "account" (signed in before
 * guests existed).
 */
type Visitor = "new" | "guest" | "account";

export const test = base.extend<{ backend: Backend; visitor: Visitor; seed: { tasks: Task[] } }>({
  visitor: ["guest", { option: true }],
  /** The cloud's list when the test starts (wrapped: test.use reads a bare array as [value, options]). */
  seed: [{ tasks: [] }, { option: true }],
  backend: async ({ context, visitor, seed }, use) => {
    const state: Backend = { tasks: structuredClone(seed.tasks), requests: [], syncs: [], guests: [], guestsDisabled: false, offline: false, failSyncs: null, isDeleted: false, deletedAt: null, full: false, removedUsers: [], refreshes: [], refreshRevoked: false, helperCalls: [], helperRuns: new Map(), helperStarts: {}, codesSent: [], shareToken: null, people: 1, role: null };
    const initial = visitor === "account" ? session(ACCOUNT_ID, false) : visitor === "guest" ? session(GUEST_ID, true) : null;
    // Seed once per browser context, not on reload or each new tab.
    await context.addInitScript(({ initialSession, authKey, privacyKey, version }) => {
      if (localStorage.getItem("prune:test:seeded")) return;
      localStorage.setItem("prune:test:seeded", "true");
      // Most workflows are returning visits; cookie specs exercise the banner.
      localStorage.setItem("prune:cookies:v1", JSON.stringify({ choice: "rejected", at: Date.now() }));
      if (initialSession) {
        localStorage.setItem(privacyKey, JSON.stringify({ version, acknowledgedAt: new Date().toISOString() }));
        localStorage.setItem(authKey, JSON.stringify(initialSession));
      }
    }, { initialSession: initial, authKey: AUTH_KEY, privacyKey: PRIVACY_ACKNOWLEDGEMENT_KEY, version: PRIVACY_POLICY_VERSION });
    await context.route(`${PROJECT}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
      const send = async (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(value) });
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      const body = request.postDataJSON() ?? {};
      const authorization = request.headers().authorization;
      state.requests.push({ path: url.pathname + url.search, body, authorization });
      if (state.offline) { await route.abort("internetdisconnected"); return; }
      const caller = claims(authorization).sub ?? "";
      if (url.pathname === "/auth/v1/signup") {
        if (state.guestsDisabled) { await send({ code: 422, error_code: "anonymous_provider_disabled", msg: "Anonymous sign-ins are disabled" }, 422); return; }
        const id = `44444444-4444-4444-8444-${String(state.guests.length + 1).padStart(12, "0")}`;
        state.guests.push(id);
        await send(session(id, true));
        return;
      }
      if (url.pathname === "/auth/v1/user") {
        if (state.removedUsers.includes(caller)) { await send({ code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" }, 403); return; }
        await send(user(caller, caller !== ACCOUNT_ID));
        return;
      }
      if (url.pathname === "/auth/v1/token") {
        // A refresh keeps the session's user, and its sign-in time.
        const id = String(body.refresh_token ?? "").replace("fixture-refresh-", "");
        if (state.refreshRevoked || !id) { await send({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }, 400); return; }
        state.refreshes.push(id);
        await send(session(id, id !== ACCOUNT_ID));
        return;
      }
      if (url.pathname === "/auth/v1/logout") { await route.fulfill({ status: 204, headers }); return; }
      if (url.pathname === "/auth/v1/otp") { state.codesSent.push(body.email); await send({}); return; }
      // The code 123456 signs in to the account from before guests.
      if (url.pathname === "/auth/v1/verify") {
        if (body.token !== "123456") { await send({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403); return; }
        await send(session(ACCOUNT_ID, false));
        return;
      }
      if (url.pathname === "/functions/v1/task-helper") {
        state.helperCalls.push(body);
        if (!caller) { await send({ code: "unauthorized", message: "Open prune again to continue." }, 401); return; }
        if (body.action === "classify") {
          // Errands get no help; everything else is something to write.
          await send({ kinds: Object.fromEntries(body.tasks.map((task: { id: string; title: string }) => [task.id, /milk|gym/i.test(task.title) ? null : "draft"])) });
          return;
        }
        if (body.action === "choices") { await send({ choices: [{ question: "How should it sound?", options: ["Warm", "Formal"] }] }); return; }
        if (body.action === "start") {
          const started = state.helperStarts[caller] ?? 0;
          if (caller !== ACCOUNT_ID && started >= 3) { await send({ code: "sign_in", message: "Sign in to keep going." }, 402); return; }
          state.helperStarts[caller] = started + 1;
          const run = { taskId: body.taskId, status: "working", answer: null, sources: [], turns: [], error: null, updatedAt: Date.now(), title: body.title };
          state.helperRuns.set(body.taskId, run);
          await send({ run });
          return;
        }
        if (body.action === "get") {
          const found = body.taskIds.map((id: string) => state.helperRuns.get(id)).filter(Boolean);
          for (const run of found)
            if (run.status === "working") Object.assign(run, { status: "done", answer: run.answer ? `${run.answer}\nShorter.` : `Hi Marco,\n- Friday works\n- See https://example.com/notes`, sources: [{ title: "Notes", url: "https://example.com/notes" }], updatedAt: Date.now() });
          await send({ runs: found });
          return;
        }
        if (body.action === "refine") {
          const run = state.helperRuns.get(body.taskId)!;
          Object.assign(run, { status: "working", turns: [...run.turns, { role: "user", text: body.message }] });
          await send({ run });
          return;
        }
        if (body.action === "discard") state.helperRuns.delete(body.taskId);
        if (body.action === "erase") state.helperRuns.clear();
        await send({});
        return;
      }
      const args = body.p_args ?? {};
      if (url.pathname === "/rest/v1/rpc/planner_list") {
        if (caller === ACCOUNT_ID && state.isDeleted) {
          // As planner_list: a sign-in after the deletion restores the account.
          const signedIn = Math.max(0, ...(claims(authorization).amr ?? []).map((method) => method.timestamp));
          if (state.deletedAt === null || signedIn <= state.deletedAt) { await send({ code: "PT403", message: "This account was deleted." }, 403); return; }
          state.isDeleted = false;
          state.deletedAt = null;
        }
        if (body.p_action === "erase") { state.tasks = []; await send({ tasks: [], rejected: [] }); return; }
        // Sharing: one fixture list; joining makes the caller a member of it.
        if (["share", "join", "leave"].includes(body.p_action) && claims(authorization).is_anonymous) { await send({ code: "PT400", message: "Sign in to share a list." }, 400); return; }
        if (body.p_action === "share") { state.shareToken ??= "0123456789abcdef0123456789abcdef"; await send({ token: state.shareToken }); return; }
        if (body.p_action === "join") {
          if (args.token !== state.shareToken) { await send({ code: "PT404", message: "This link doesn't work any more. Ask for a new one." }, 404); return; }
          state.role = "member";
          state.people = 2;
          await send({ joined: true });
          return;
        }
        if (body.p_action === "leave") { state.role = null; state.people = 1; state.tasks = []; await send({ left: true }); return; }
        if (state.failSyncs) { await send(state.failSyncs.body, state.failSyncs.status); return; }
        const save: Task[] = args.save ?? [];
        const remove: string[] = args.remove ?? [];
        state.syncs.push({ save, remove });
        const rejected = applySync(state, save, remove);
        await send({ tasks: [...state.tasks].sort((a, b) => b.createdAt - a.createdAt), rejected, shared: state.role ? { role: state.role, people: state.people } : null });
        return;
      }
      if (url.pathname !== "/rest/v1/rpc/planner_call") { await send({ error: "Unexpected fixture route" }, 404); return; }
      if (body.p_action === "delete_account" && caller === ACCOUNT_ID) {
        if (!state.isDeleted) state.deletedAt = Math.floor(Date.now() / 1000);
        state.isDeleted = true;
        await send({ isDeleted: true });
        return;
      }
      await send({ code: "PT400", message: "Unknown action." }, 400);
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
    expect(unexpected, "The list must not load third-party trackers").toEqual([]);
    expect(sameOriginTracking, "The list must not send same-origin Vercel analytics").toEqual([]);
    void backend;
  },
});
export { expect };

export const newTask = (page: Page) => page.getByRole("textbox", { name: "New task", exact: true });

/** Opens the list; a returning visitor's first sync finishes too. */
export async function openList(page: Page) {
  await page.goto("/");
  await expect(newTask(page)).toBeVisible();
  if (await page.evaluate((key) => localStorage.getItem(key) !== null, PRIVACY_ACKNOWLEDGEMENT_KEY)) await synced(page);
}
export async function addTask(page: Page, title: string) {
  await newTask(page).fill(title);
  await newTask(page).press("Enter");
  await expect(page.getByRole("checkbox", { name: title, exact: true })).toBeVisible();
  await expect(newTask(page)).toHaveValue("");
}
/** This browser's list, as saved in its storage. */
export async function savedList(page: Page): Promise<{ tasks: Task[]; pending: Record<string, number>; owner: string | null } | null> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LIST_KEY);
}
/** The list has synced with an account, and every change on this device has reached it. */
export async function synced(page: Page) {
  await expect.poll(async () => {
    const saved = await savedList(page);
    return saved?.owner ? Object.keys(saved.pending).length : -1;
  }).toBe(0);
}
export async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
}
