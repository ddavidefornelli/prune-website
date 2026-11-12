import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { buildReminderEmail } from "../server/reminders/email.ts";
import { sendWithBrevo } from "../server/reminders/brevo.ts";
import { createReminderHandler, createUnsubscribeHandler } from "../server/reminders/handler.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const SITE = "https://www.prune.win/";
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const as = (db, sub) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, role: "authenticated" })]);
const call = async (db, action, args = {}, timezone = "UTC") =>
  (await db.query("select public.planner_call($1, $2::jsonb, $3) as result", [action, JSON.stringify(args), timezone])).rows[0].result;
const claim = async (db, now, limit = 100) =>
  (await db.query("select * from public.planner_claim_reminders($1, $2::timestamptz) order by email", [limit, now])).rows;
// 10:05 UTC on a Thursday: inside the morning window for UTC and Europe/Rome.
const MORNING = "2026-11-12T10:05:00Z";

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    insert into auth.users values ('${owner}', 'owner@example.test'), ('${other}', 'other@example.test');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, ai_enabled boolean not null default true, ai_revision bigint not null default 0);
    create table public.planner_tasks(user_id uuid, planned_for date, status text, actual_seconds bigint not null default 0, outcome text, slot integer);
    create table public.planner_resources(user_id uuid);
    create table public.planner_stops(user_id uuid); create table public.planner_reviews(user_id uuid);
    create function public.planner_call(p_action text, p_args jsonb, p_timezone text) returns jsonb language plpgsql security definer as $$ begin
      return jsonb_build_object('action', p_action);
    end $$;
    insert into public.planner_accounts(user_id) values ('${owner}'), ('${other}');
  `);
  for (const name of ["20261024000200_soft_delete_accounts.sql", "20261103000100_weekly_reviews_always_on.sql", "20261106000100_month_stats.sql", "20261112000200_email_reminders.sql"])
    await db.exec(migration(name));
  return db;
}
const task = (db, user, day, status, outcome, slot) =>
  db.query("insert into public.planner_tasks(user_id, planned_for, status, outcome, slot) values ($1, $2, $3, $4, $5)", [user, day, status, outcome, slot]);

test("the daily reminder lists today's unfinished tasks once per local day", async () => {
  const db = await fixture();
  try {
    await task(db, owner, "2026-11-12", "planned", "Write report", 2);
    await task(db, owner, "2026-11-12", "active", "Call Ana", 1);
    await task(db, owner, "2026-11-12", "completed", "Done already", 3);
    await task(db, owner, "2026-11-13", "planned", "Tomorrow", 1);
    await task(db, other, "2026-11-12", "completed", "All done", 1);
    const rows = await claim(db, MORNING);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "owner@example.test");
    assert.equal(rows[0].kind, "daily");
    assert.deepEqual(rows[0].tasks, ["Call Ana", "Write report"]);
    assert.match(rows[0].unsubscribe_token, /^[0-9a-f-]{36}$/);
    // A retried or later run the same day sends nothing more.
    assert.deepEqual(await claim(db, MORNING), []);
    assert.deepEqual(await claim(db, "2026-11-12T11:05:00Z"), []);
    // A failed send is released and picked up by the next run.
    await db.query("select public.planner_release_reminder($1, 'daily')", [owner]);
    assert.equal((await claim(db, "2026-11-12T11:05:00Z")).length, 1);
  } finally { await db.close(); }
});

test("reminders follow the owner's morning, their switch and account deletion", async () => {
  const db = await fixture();
  try {
    await task(db, owner, "2026-11-12", "planned", "Write report", 1);
    // 02:05 and 13:05 UTC are outside 09:00-11:59 UTC.
    assert.deepEqual(await claim(db, "2026-11-12T02:05:00Z"), []);
    assert.deepEqual(await claim(db, "2026-11-12T13:05:00Z"), []);
    // The planner remembers the zone a client reports: 02:05 UTC is 11:05 in Tokyo.
    await as(db, owner);
    await call(db, "email_preferences", {}, "Asia/Tokyo");
    assert.equal((await db.query("select timezone from public.planner_email_reminders where user_id = $1", [owner])).rows[0].timezone, "Asia/Tokyo");
    // An unknown zone never replaces a known one.
    await call(db, "email_preferences", {}, "Not/AZone");
    assert.equal((await db.query("select timezone from public.planner_email_reminders where user_id = $1", [owner])).rows[0].timezone, "Asia/Tokyo");
    assert.deepEqual(await call(db, "set_email_preferences", { daily: false, comeback: true }, "Asia/Tokyo"), { daily: false, comeback: true });
    assert.deepEqual(await claim(db, "2026-11-12T02:05:00Z"), []);
    await assert.rejects(call(db, "set_email_preferences", { daily: "false", comeback: true }, "Asia/Tokyo"), (error) => error.code === "PT400");
    await call(db, "set_email_preferences", { daily: true, comeback: true }, "Asia/Tokyo");
    await call(db, "delete_account", {}, "Asia/Tokyo");
    assert.deepEqual(await claim(db, "2026-11-12T02:05:00Z"), []);
  } finally { await db.close(); }
});

test("the come-back email goes weekly to absent owners, four times at most, and stops on return", async () => {
  const db = await fixture();
  try {
    await db.query("update public.planner_email_reminders set last_seen_at = '2026-11-08T10:00:00Z'");
    assert.deepEqual(await claim(db, MORNING), [], "four days away is not enough");
    await db.query("update public.planner_email_reminders set last_seen_at = '2026-11-01T10:00:00Z' where user_id = $1", [owner]);
    await db.query("update public.planner_email_reminders set comeback_enabled = false where user_id = $1", [other]);
    const first = await claim(db, MORNING);
    assert.deepEqual(first.map((row) => [row.email, row.kind, row.tasks]), [["owner@example.test", "comeback", []]]);
    assert.deepEqual(await claim(db, "2026-11-13T10:05:00Z"), [], "not again the next day");
    for (const now of ["2026-11-19T10:05:00Z", "2026-11-26T10:05:00Z", "2026-12-03T10:05:00Z"])
      assert.equal((await claim(db, now)).length, 1);
    assert.deepEqual(await claim(db, "2026-12-10T10:05:00Z"), [], "capped at four in a row");
    // Coming back resets the count; pending tasks take priority over a come-back.
    await as(db, owner);
    await call(db, "email_preferences");
    assert.equal((await db.query("select comebacks_sent from public.planner_email_reminders where user_id = $1", [owner])).rows[0].comebacks_sent, 0);
    await db.query("update public.planner_email_reminders set last_seen_at = '2026-11-01T10:00:00Z' where user_id = $1", [owner]);
    await task(db, owner, "2026-12-17", "planned", "Still here", 1);
    assert.deepEqual((await claim(db, "2026-12-17T10:05:00Z")).map((row) => row.kind), ["daily"]);
  } finally { await db.close(); }
});

test("the batch limit holds and an unsubscribe token turns off one kind only", async () => {
  const db = await fixture();
  try {
    await task(db, owner, "2026-11-12", "planned", "A", 1);
    await task(db, other, "2026-11-12", "planned", "B", 1);
    assert.equal((await claim(db, MORNING, 1)).length, 1);
    assert.equal((await claim(db, MORNING, 1)).length, 1);
    assert.deepEqual(await claim(db, MORNING, 1), []);
    const token = (await db.query("select unsubscribe_token from public.planner_email_reminders where user_id = $1", [owner])).rows[0].unsubscribe_token;
    assert.equal((await db.query("select public.planner_unsubscribe($1, 'daily') as ok", [token])).rows[0].ok, true);
    assert.equal((await db.query("select public.planner_unsubscribe($1, 'everything') as ok", [token])).rows[0].ok, false);
    assert.equal((await db.query("select public.planner_unsubscribe($1, 'daily') as ok", [other])).rows[0].ok, false);
    assert.deepEqual((await db.query("select daily_enabled, comeback_enabled from public.planner_email_reminders order by user_id")).rows,
      [{ daily_enabled: false, comeback_enabled: true }, { daily_enabled: true, comeback_enabled: true }]);
    // Browser roles cannot reach the server-only functions or the table.
    for (const fn of ["planner_claim_reminders(integer, timestamptz)", "planner_release_reminder(uuid, text)", "planner_unsubscribe(uuid, text)"])
      for (const role of ["anon", "authenticated"])
        assert.equal((await db.query(`select has_function_privilege('${role}', 'public.${fn}', 'execute') as ok`)).rows[0].ok, false, `${role} ${fn}`);
    assert.equal((await db.query("select has_table_privilege('authenticated', 'public.planner_email_reminders', 'select') as ok")).rows[0].ok, false);
  } finally { await db.close(); }
});

const reminder = (overrides = {}) => ({ userId: owner, email: "owner@example.test", kind: "daily", tasks: ["Write report"], unsubscribeToken: other, ...overrides });

test("the email shows the tasks, a START NOW button and an unsubscribe link, with task text escaped", () => {
  const email = buildReminderEmail(reminder({ tasks: ['<img src=x onerror="alert(1)">', "Call Ana & Bo"] }), SITE);
  assert.equal(email.subject, "2 tasks waiting today");
  assert.ok(!email.html.includes("<img"));
  assert.ok(email.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(email.html.includes("Call Ana &amp; Bo"));
  assert.match(email.html, /bgcolor="#e5202b"[^>]*>\s*<a href="https:\/\/www\.prune\.win\/"[^>]*>START NOW<\/a>/);
  assert.ok(email.html.includes(`https://www.prune.win/?unsubscribe=${other}&amp;kind=daily`));
  assert.ok(email.text.includes("- Call Ana & Bo"));
  assert.equal(buildReminderEmail(reminder(), SITE).subject, "1 task waiting today");
  const comeback = buildReminderEmail(reminder({ kind: "comeback", tasks: [] }), SITE);
  assert.equal(comeback.subject, "Hop back in");
  assert.ok(email.html.includes("border-radius:0;"), "square corners, like the app's buttons");
  assert.ok(comeback.html.includes("START NOW"));
  assert.ok(comeback.html.includes("kind=comeback"));
});

function job(overrides = {}) {
  const sent = [];
  const released = [];
  const handler = createReminderHandler({
    secret: "s3cret-value",
    siteUrl: SITE,
    unsubscribeEndpoint: "https://project.supabase.co/functions/v1/email-unsubscribe",
    claim: async () => [reminder(), reminder({ userId: other, email: "other@example.test", kind: "comeback", tasks: [] })],
    release: async (userId, kind) => { released.push([userId, kind]); },
    send: async (email) => { sent.push(email); return "sent"; },
    ...overrides,
  });
  const run = (token = "s3cret-value", method = "POST") =>
    handler(new Request("https://project.supabase.co/functions/v1/daily-reminders", { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }));
  return { run, sent, released };
}

test("the job needs its secret, sends every claim and reports counts only", async () => {
  let claims = 0;
  const guarded = job({ claim: async () => { claims += 1; return []; } });
  assert.equal((await guarded.run("wrong")).status, 401);
  assert.equal((await guarded.run("")).status, 401);
  assert.equal((await guarded.run("s3cret-value", "GET")).status, 405);
  assert.equal(claims, 0);
  assert.equal((await job({ secret: "" }).run("")).status, 401, "an unset secret never authorizes");

  const { run, sent, released } = job();
  const response = await run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: 2, retry: 0, rejected: 0, released: 0 });
  assert.deepEqual(sent.map((email) => [email.to, email.kind]).sort(), [["other@example.test", "comeback"], ["owner@example.test", "daily"]]);
  assert.equal(sent.find((email) => email.kind === "daily").oneClickUrl, `https://project.supabase.co/functions/v1/email-unsubscribe?token=${other}&kind=daily`);
  assert.deepEqual(released, []);
});

test("only retryable failures release their claim", async () => {
  const { run, released } = job({ send: async (email) => { if (email.kind === "daily") throw new Error("network"); return "rejected"; } });
  assert.deepEqual(await (await run()).json(), { sent: 0, retry: 1, rejected: 1, released: 1 });
  assert.deepEqual(released, [[owner, "daily"]]);
  assert.equal((await job({ claim: async () => { throw new Error("db"); } }).run()).status, 500);
});

test("an account-level refusal stops the run and releases every unsent claim", async () => {
  const many = Array.from({ length: 6 }, (_, index) => reminder({ userId: `user-${index}`, email: `u${index}@example.test` }));
  let attempts = 0;
  const { run, released } = job({ concurrency: 1, claim: async () => many, send: async () => { attempts += 1; return attempts === 1 ? "sent" : "halt"; } });
  const response = await run();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider_refused", sent: 1, retry: 0, rejected: 0, released: 5 });
  assert.equal(attempts, 2, "no further sends after the refusal");
  assert.deepEqual(released.map(([userId]) => userId).sort(), ["user-1", "user-2", "user-3", "user-4", "user-5"]);
  // With parallel workers, every claim is still either sent or released.
  const parallel = job({ claim: async () => many, send: async () => "halt" });
  assert.equal((await parallel.run()).status, 502);
  assert.equal(parallel.released.length, 6);
});

test("Brevo gets the sender, content and one-click headers; failures are classified", async () => {
  const calls = [];
  const fetcher = (status) => async (url, init) => { calls.push({ url, init }); return new Response("{}", { status }); };
  const email = { ...buildReminderEmail(reminder(), SITE), to: "owner@example.test", kind: "daily", oneClickUrl: "https://project.supabase.co/functions/v1/email-unsubscribe?token=t&kind=daily" };
  const config = { apiKey: "test-key", fromEmail: "hello@prune.win" };
  assert.equal(await sendWithBrevo(email, { ...config, fetcher: fetcher(201) }), "sent");
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].init.headers["api-key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.sender, { name: "prune", email: "hello@prune.win" });
  assert.deepEqual(body.to, [{ email: "owner@example.test" }]);
  assert.equal(body.headers["List-Unsubscribe"], `<${email.oneClickUrl}>`);
  assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(await sendWithBrevo(email, { ...config, fetcher: fetcher(429) }), "retry");
  assert.equal(await sendWithBrevo(email, { ...config, fetcher: fetcher(503) }), "retry");
  assert.equal(await sendWithBrevo(email, { ...config, fetcher: fetcher(400) }), "rejected");
  for (const status of [401, 402, 403])
    assert.equal(await sendWithBrevo(email, { ...config, fetcher: fetcher(status) }), "halt");
  assert.equal(await sendWithBrevo(email, { ...config, fetcher: async () => { throw new Error("offline"); } }), "retry");
});

test("unsubscribe accepts POST with a valid token only, from mail providers or the website", async () => {
  const seen = [];
  const handler = createUnsubscribeHandler({ allowedOrigins: new Set(["https://www.prune.win"]), unsubscribe: async (token, kind) => { seen.push([token, kind]); } });
  const url = (token, kind) => `https://project.supabase.co/functions/v1/email-unsubscribe?token=${token}&kind=${kind}`;
  const post = (target, headers = {}, method = "POST") => handler(new Request(target, { method, headers }));
  assert.equal((await post(url(owner, "daily"), {}, "GET")).status, 405, "opening the link changes nothing");
  assert.equal((await post(url("nope", "daily"))).status, 400);
  assert.equal((await post(url(owner, "all"))).status, 400);
  assert.equal((await post(url(owner, "daily"), { Origin: "https://evil.example" })).status, 403);
  assert.deepEqual(seen, []);
  assert.equal((await post(url(owner, "daily"))).status, 204);
  const fromSite = await post(url(owner, "comeback"), { Origin: "https://www.prune.win" });
  assert.equal(fromSite.status, 204);
  assert.equal(fromSite.headers.get("Access-Control-Allow-Origin"), "https://www.prune.win");
  assert.deepEqual(seen, [[owner, "daily"], [owner, "comeback"]]);
});
