import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { validateInput } from "../server/weekly-review/domain.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const migration = readFileSync(
  new URL("../supabase/migrations/20261112000500_reviews_every_ten_tasks.sql", import.meta.url),
  "utf8",
);
const HASH = "a".repeat(64);
const ANALYSIS = JSON.stringify({ summary: "ok", mainReasons: [], improvements: ["x"] });

// The shared backend's tables, trimmed to the columns these functions use.
async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, ai_enabled boolean not null default true,
      ai_revision bigint not null default 0, consent_version text default 'weekly-ai-v1', "isDeleted" boolean not null default false, deleted_at timestamptz);
    insert into public.planner_accounts(user_id) values ('${owner}');
    create table public.planner_tasks(id uuid primary key default gen_random_uuid(), user_id uuid not null, outcome text not null,
      planned_for date not null, estimated_minutes integer not null default 25, actual_seconds bigint not null default 0,
      status text not null default 'planned', completed_on date, created_at bigint not null default 0, unique (user_id, id));
    create table public.planner_stops(id bigint generated always as identity primary key, user_id uuid not null, task_id uuid not null,
      reason text not null, stopped_at bigint not null default 0, stopped_on date not null);
    create table public.planner_reviews(user_id uuid not null, week_start date not null, report jsonb not null, primary key (user_id, week_start));
    create table public.ai_controls(id boolean primary key default true, enabled boolean not null default true,
      daily_attempt_limit integer not null default 150, monthly_attempt_limit integer not null default 600,
      development_unlimited boolean not null default false);
    insert into public.ai_controls(id) values (true);
    create table public.ai_usage(period text primary key, attempts integer not null default 0);
    create table public.ai_review_requests(id uuid primary key default gen_random_uuid(), user_id uuid not null, quota_week date not null,
      week_start date not null, request_hash text not null, consent_version text not null, consent_recorded_at timestamptz not null default now(),
      status text not null, attempts integer not null default 1 constraint ai_review_requests_attempts_check check (attempts between 1 and 3),
      lease_token uuid not null, lease_until timestamptz not null, last_attempt_at timestamptz not null default now(),
      analysis jsonb, model text, generated_at timestamptz, activity jsonb, consent_revision bigint,
      unique (user_id, quota_week), unique (user_id, week_start));
    create table public.planner_email_reminders(user_id uuid primary key, timezone text, last_seen_at timestamptz default now(),
      comebacks_sent integer default 0, daily_enabled boolean default true, comeback_enabled boolean default true);
    create function public.planner_month_stats(u uuid, a jsonb, z text) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.planner_call_active(p_action text, p_args jsonb, p_timezone text) returns jsonb language sql as $$ select '{"dispatched":true}'::jsonb $$;
  `);
  await db.exec(migration);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: owner, role: "authenticated" })]);
  const since = (await db.query("select task_reviews_since::text d from public.ai_controls")).rows[0].d;
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const one = async (sql, args = []) => (await rows(sql, args))[0].r;
  let created = 0;
  return {
    since,
    rows,
    overview: () => one("select public.planner_call('weekly_overview', '{}'::jsonb, 'Europe/Rome') r"),
    input: () => one("select public.planner_review_input($1, 'Europe/Rome') r", [owner]),
    reserve: (input, activity = input.activity) =>
      one("select public.reserve_planner_review($1, $2::date, $3, 'weekly-ai-v1', $4::jsonb) r",
        [owner, input.weekStart, HASH, JSON.stringify(activity)]),
    finish: (claim) =>
      one("select public.finish_weekly_review($1, $2, $3::jsonb, 'gpt-4.1-mini') r", [claim.id, claim.leaseToken, ANALYSIS]),
    complete: async (count, day = since) => {
      const ids = [];
      for (let i = 0; i < count; i++) {
        created++;
        ids.push(await one(`insert into public.planner_tasks(user_id, outcome, planned_for, status, completed_on, created_at)
          values ($1, $2, $3::date, 'completed', $3::date, $4) returning id r`, [owner, `task ${created}`, day, created]));
      }
      return ids;
    },
  };
}

test("a review is due after every 10 completed tasks, counting from the switch", async () => {
  const db = await fixture();
  assert.equal(new Date(`${db.since}T00:00:00Z`).getUTCDay(), 1, "counting starts on a Monday");
  // Completed before the switch: already covered by weekly reviews.
  await db.complete(4, "2026-01-05");
  const [first] = await db.complete(9);
  await db.rows(`insert into public.planner_stops(user_id, task_id, reason, stopped_on) values
    ($1, $2, 'Phone call', $3::date), ($1, $2, 'Reason not provided', $3::date)`, [owner, first, db.since]);

  let overview = await db.overview();
  assert.deepEqual(overview.progress, { completed: 9, target: 10 });
  assert.equal(overview.status, "no_data");
  assert.equal((await db.input()).activity.tasks.length, 0, "no AI input before 10 tasks");

  await db.complete(2);
  overview = await db.overview();
  assert.equal(overview.status, "pending");
  assert.deepEqual(overview.progress, { completed: 10, target: 10 });

  const input = await db.input();
  assert.equal(input.activity.tasks.length, 10);
  assert.deepEqual(input.activity.tasks.map((task) => task.outcome), Array.from({ length: 10 }, (_, i) => `task ${i + 5}`));
  assert.deepEqual(input.activity.stops.map((stop) => stop.reason), ["Phone call"]);

  // Only the batch that is due can be reserved.
  assert.equal((await db.reserve(input, { ...input.activity, tasks: input.activity.tasks.slice(1) })).outcome, "invalid");
  const claim = await db.reserve(input);
  assert.equal(claim.outcome, "reserved");
  assert.equal((await db.reserve(input)).outcome, "running");
  assert.equal((await db.overview()).status, "running");
  assert.equal(await db.finish(claim), true);

  overview = await db.overview();
  assert.equal(overview.status, "up_to_date");
  assert.deepEqual(overview.progress, { completed: 1, target: 10 }, "the 11th task starts the next batch");
  assert.equal(overview.reviews.length, 1);
  assert.equal(overview.reviews[0].weekStart, db.since);
  assert.equal(overview.reviews[0].activity.tasks.length, 10);

  // The next batch, on later days, gets its own review.
  const next = new Date(Date.parse(`${db.since}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  await db.complete(9, next);
  const second = await db.input();
  assert.equal(second.activity.tasks[0].outcome, "task 15");
  assert.equal(second.weekEnd, next);
  const claim2 = await db.reserve(second);
  assert.equal(claim2.outcome, "reserved");
  assert.equal(await db.finish(claim2), true);
  overview = await db.overview();
  assert.equal(overview.reviews.length, 2);
  assert.deepEqual(overview.progress, { completed: 0, target: 10 });
});

test("a failing batch retries hourly, then daily, and is never stuck", async () => {
  const db = await fixture();
  await db.complete(10);
  const input = await db.input();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const claim = await db.reserve(input);
    assert.equal(claim.outcome, "reserved", `attempt ${attempt}`);
    await db.rows("update public.ai_review_requests set status = 'failed' where id = $1", [claim.id]);
    assert.equal((await db.overview()).status, "failed");
    assert.equal((await db.reserve(input)).outcome, "rate_limited");
    await db.rows("update public.ai_review_requests set last_attempt_at = now() - interval '2 hours'");
    if (attempt >= 3) {
      assert.equal((await db.reserve(input)).outcome, "rate_limited", "after three failures, wait a day");
      await db.rows("update public.ai_review_requests set last_attempt_at = now() - interval '25 hours'");
    }
  }
});

test("turning reviews on returns the progress overview and clients can't read the helpers", async () => {
  const db = await fixture();
  await db.rows("update public.planner_accounts set ai_enabled = false where user_id = $1", [owner]);
  assert.equal((await db.overview()).status, "disabled");
  const enabled = (await db.rows("select public.planner_call('set_weekly_ai_enabled', '{\"enabled\":true}'::jsonb, 'UTC') r"))[0].r;
  assert.ok(enabled.progress);
  await db.rows("set role authenticated");
  await assert.rejects(db.rows("select public.planner_review_batch($1)", [owner]));
  await assert.rejects(db.rows("select public.planner_review_input($1, 'UTC')", [owner]));
  await assert.rejects(db.rows("select * from public.planner_review_tasks"));
});

test("the Edge Function accepts a batch spanning any dates up to tomorrow", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const task = (id, day) => ({ id, outcome: `t${id}`, plannedFor: day, completedOn: day, status: "completed", estimatedMinutes: 25, actualSeconds: 60 });
  const body = (weekStart, weekEnd) => ({
    consentVersion: "weekly-ai-v1",
    weekStart,
    weekEnd,
    activity: { tasks: [task("a", weekStart), task("b", weekEnd)], stops: [], totalStops: 0, omittedStops: 0 },
  });
  assert.equal(validateInput(body("2026-10-28", "2026-11-12"), now).weekStart, "2026-10-28");
  assert.equal(validateInput(body("2026-11-12", "2026-11-12"), now).weekEnd, "2026-11-12");
  assert.throws(() => validateInput(body("2026-11-12", "2026-11-10"), now));
  assert.throws(() => validateInput(body("2026-11-12", "2026-11-15"), now));
});
