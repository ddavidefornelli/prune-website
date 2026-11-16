import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export const owner = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const ANALYSIS = JSON.stringify({ summary: "ok", mainReasons: [], improvements: ["x"] });
const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

// The shared backend's tables, trimmed to the columns these functions use.
export async function reviewFixture(migrations = ["20261112000500_reviews_every_ten_tasks.sql"]) {
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
  for (const name of migrations) await db.exec(read(name));
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
