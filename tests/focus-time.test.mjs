import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const as = (db, sub) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, role: "authenticated" })]);
const schedule = async (db, action, args = {}, timezone = "UTC") =>
  (await db.query("select public.planner_schedule($1, $2::jsonb, $3) as result", [action, JSON.stringify(args), timezone])).rows[0].result;
const claim = async (db, now, limit = 100) =>
  (await db.query("select * from public.planner_claim_reminders($1, $2::timestamptz) order by email", [limit, now])).rows;
const kinds = (rows) => rows.map((row) => [row.email.split("@")[0], row.kind, row.tasks]);
const ENDPOINT = "https://push.example.test/send/abc";
const KEYS = { p256dh: "B".repeat(87), auth: "A".repeat(22) };

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, created_at timestamptz not null default now());
    insert into auth.users values ('${owner}', 'owner@example.test', '2026-11-01T08:00:00Z'), ('${other}', 'other@example.test', '2026-10-01T08:00:00Z');
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
  for (const name of [
    "20261024000200_soft_delete_accounts.sql",
    "20261103000100_weekly_reviews_always_on.sql",
    "20261106000100_month_stats.sql",
    "20261112000200_email_reminders.sql",
    "20261120000100_start_times_and_push.sql",
    "20261121000100_focus_time.sql",
  ])
    await db.exec(migration(name));
  await db.exec(`update public.planner_email_reminders set last_seen_at = '2026-11-12T00:00:00Z'`);
  return db;
}
const task = (db, user, day, status, outcome, slot) =>
  db.query("insert into public.planner_tasks(user_id, planned_for, status, outcome, slot) values ($1, $2, $3, $4, $5)", [user, day, status, outcome, slot]);
const seen = (db, user, iso) => db.query("update public.planner_email_reminders set last_seen_at = $2 where user_id = $1", [user, iso]);

test("the focus time is set, validated and read back", async () => {
  const db = await fixture();
  try {
    await as(db, owner);
    assert.deepEqual(await schedule(db, "schedule"), { focusMinute: null, weekdaysOnly: false, pushDevices: 0 });
    assert.deepEqual(await schedule(db, "set_focus_time", { minute: 14 * 60 + 30, weekdaysOnly: true }), { focusMinute: 870, weekdaysOnly: true, pushDevices: 0 });
    await assert.rejects(schedule(db, "set_focus_time", { minute: 1440, weekdaysOnly: false }), /Pick a time of day/);
    await assert.rejects(schedule(db, "set_focus_time", { minute: "9:00", weekdaysOnly: false }), /Pick a time of day/);
    await assert.rejects(schedule(db, "set_next_session", { at: 1 }), /Unsupported/);
    assert.equal((await schedule(db, "set_focus_time", { minute: null, weekdaysOnly: false })).focusMinute, null);
    await as(db, "33333333-3333-4333-8333-333333333333");
    await assert.rejects(schedule(db, "schedule"), /Open your planner first/);
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
    await assert.rejects(schedule(db, "schedule"), /Sign in/);
    assert.equal((await db.query(`select has_function_privilege('anon', 'public.planner_schedule(text,jsonb,text)', 'EXECUTE') as x`)).rows[0].x, false);
  } finally { await db.close(); }
});

test("at the focus time: today's unfinished tasks, once a day, in the owner's zone", async () => {
  const db = await fixture();
  try {
    await task(db, owner, "2026-11-13", "planned", "Write report", 2);
    await task(db, owner, "2026-11-13", "active", "Call Ana", 1);
    await task(db, owner, "2026-11-13", "completed", "Done", 3);
    await as(db, owner);
    await schedule(db, "set_focus_time", { minute: 14 * 60 + 30, weekdaysOnly: false }, "Europe/Rome");
    // 13:25 UTC is 14:25 in Rome: five minutes early.
    assert.deepEqual(await claim(db, "2026-11-13T13:25:00Z"), []);
    assert.deepEqual(kinds(await claim(db, "2026-11-13T13:35:00Z")), [["owner", "daily", ["Call Ana", "Write report"]]]);
    assert.deepEqual(await claim(db, "2026-11-13T14:35:00Z"), []);
    // A failed send is retried within the three-hour window, never after it.
    await db.query("select public.planner_release_reminder($1, 'daily')", [owner]);
    assert.equal((await claim(db, "2026-11-13T16:25:00Z")).length, 1);
    await db.query("select public.planner_release_reminder($1, 'daily')", [owner]);
    assert.deepEqual(await claim(db, "2026-11-13T16:35:00Z"), []);
  } finally { await db.close(); }
});

test("nothing planned: 'what's the one thing?' twice at most until the owner comes back", async () => {
  const db = await fixture();
  try {
    await as(db, owner);
    await schedule(db, "set_focus_time", { minute: 9 * 60, weekdaysOnly: false });
    await seen(db, owner, "2026-11-12T20:00:00Z");
    assert.deepEqual(kinds(await claim(db, "2026-11-13T09:05:00Z")), [["owner", "daily", []]]);
    assert.deepEqual(kinds(await claim(db, "2026-11-14T09:05:00Z")), [["owner", "daily", []]]);
    assert.deepEqual(await claim(db, "2026-11-15T09:05:00Z"), []);
    // A visit starts the count again.
    await seen(db, owner, "2026-11-15T12:00:00Z");
    assert.equal((await claim(db, "2026-11-16T09:05:00Z")).length, 1);
    // Everything done today: nothing to say.
    await task(db, owner, "2026-11-17", "completed", "Done early", 1);
    assert.deepEqual(await claim(db, "2026-11-17T09:05:00Z"), []);
  } finally { await db.close(); }
});

test("without a focus time: 09:00, and only when tasks are waiting", async () => {
  const db = await fixture();
  try {
    assert.deepEqual(await claim(db, "2026-11-13T09:05:00Z"), []);
    await task(db, other, "2026-11-13", "planned", "Taxes", 1);
    assert.deepEqual(kinds(await claim(db, "2026-11-13T09:05:00Z")), [["other", "daily", ["Taxes"]]]);
  } finally { await db.close(); }
});

test("weekdays only skips Saturday and Sunday; the switch and the come-back still apply", async () => {
  const db = await fixture();
  try {
    await as(db, owner);
    await schedule(db, "set_focus_time", { minute: 8 * 60, weekdaysOnly: true });
    // 2026-11-14 is a Saturday.
    await task(db, owner, "2026-11-14", "planned", "Weekend task", 1);
    assert.deepEqual(await claim(db, "2026-11-14T08:05:00Z"), []);
    await task(db, owner, "2026-11-16", "planned", "Monday task", 1);
    await db.exec(`update public.planner_email_reminders set daily_enabled = false where user_id = '${owner}'`);
    assert.deepEqual(await claim(db, "2026-11-16T08:05:00Z"), []);
    // Away for a week: the come-back email at the focus time.
    assert.deepEqual(kinds(await claim(db, "2026-11-20T08:05:00Z")), [["owner", "comeback", []]]);
  } finally { await db.close(); }
});

test("push subscriptions are owned by the caller and dropped after failures", async () => {
  const db = await fixture();
  try {
    await as(db, owner);
    await assert.rejects(schedule(db, "save_push", { endpoint: "http://insecure.test/x", ...KEYS }), /invalid notification/);
    assert.equal((await schedule(db, "save_push", { endpoint: ENDPOINT, ...KEYS })).pushDevices, 1);
    await as(db, other);
    assert.equal((await schedule(db, "save_push", { endpoint: ENDPOINT, ...KEYS })).pushDevices, 1);
    await as(db, owner);
    assert.equal((await schedule(db, "schedule")).pushDevices, 0);
    const targets = (await db.query("select * from public.planner_push_targets($1)", [[owner, other]])).rows;
    assert.deepEqual(targets.map((row) => row.user_id), [other]);
    for (let i = 0; i < 5; i += 1) await db.query("select public.planner_push_result($1, 'failed')", [ENDPOINT]);
    assert.equal((await db.query("select count(*)::int as n from public.planner_push_subscriptions")).rows[0].n, 0);
  } finally { await db.close(); }
});
