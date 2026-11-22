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
    "20261124000200_comeback_reminders_only.sql",
  ])
    await db.exec(migration(name));
  await db.exec(`update public.planner_email_reminders set last_seen_at = '2026-11-12T00:00:00Z'`);
  return db;
}
const task = (db, user, day, status, outcome, slot) =>
  db.query("insert into public.planner_tasks(user_id, planned_for, status, outcome, slot) values ($1, $2, $3, $4, $5)", [user, day, status, outcome, slot]);
const seen = (db, user, iso) => db.query("update public.planner_email_reminders set last_seen_at = $2 where user_id = $1", [user, iso]);

test("planned tasks and an empty day no longer send a daily reminder", async () => {
  const db = await fixture();
  try {
    await task(db, owner, "2026-11-13", "planned", "Write report", 1);
    await as(db, owner);
    await schedule(db, "set_focus_time", { minute: 9 * 60, weekdaysOnly: false });
    await seen(db, owner, "2026-11-12T20:00:00Z");
    assert.deepEqual(await claim(db, "2026-11-13T09:05:00Z"), []);
    assert.deepEqual(await claim(db, "2026-11-14T09:05:00Z"), []);
    // The preferences themselves are untouched.
    const row = (await db.query("select daily_enabled, focus_minute from public.planner_email_reminders where user_id = $1", [owner])).rows[0];
    assert.deepEqual(row, { daily_enabled: true, focus_minute: 540 });
  } finally { await db.close(); }
});

test("the come-back email still goes out after a week away, once a week, four times at most", async () => {
  const db = await fixture();
  try {
    await seen(db, other, "2026-11-01T20:00:00Z");
    // Outside the morning window: nothing.
    assert.deepEqual(await claim(db, "2026-11-13T15:05:00Z"), []);
    assert.deepEqual(kinds(await claim(db, "2026-11-13T09:05:00Z")), [["other", "comeback", []]]);
    assert.deepEqual(await claim(db, "2026-11-14T09:05:00Z"), []);
    const theirs = async (day) => (await claim(db, `${day}T09:05:00Z`)).filter((row) => row.email.startsWith("other"));
    for (const day of ["2026-11-20", "2026-11-27", "2026-12-04"])
      assert.equal((await theirs(day)).length, 1, day);
    assert.deepEqual(await theirs("2026-12-11"), []);
  } finally { await db.close(); }
});

test("turned off, or a deleted account: no come-back email", async () => {
  const db = await fixture();
  try {
    await seen(db, owner, "2026-11-01T20:00:00Z");
    await seen(db, other, "2026-11-01T20:00:00Z");
    await db.exec(`update public.planner_email_reminders set comeback_enabled = false where user_id = '${owner}'`);
    await db.exec(`update public.planner_accounts set "isDeleted" = true, deleted_at = now() where user_id = '${other}'`);
    assert.deepEqual(await claim(db, "2026-11-13T09:05:00Z"), []);
  } finally { await db.close(); }
});

test("a lost race claims nothing twice", async () => {
  const db = await fixture();
  try {
    await seen(db, other, "2026-11-01T20:00:00Z");
    const [first, second] = await Promise.all([claim(db, "2026-11-13T09:05:00Z"), claim(db, "2026-11-13T09:06:00Z")]);
    assert.equal(first.length + second.length, 1);
  } finally { await db.close(); }
});
