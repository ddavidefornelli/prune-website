import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);
/** The day planner's retirement: the last migration, run separately so tests can seed planner data first. */
export const RETIREMENT = "20261125000100_retire_day_planner.sql";
/** pg_cron and pg_net are not in PGlite; the schedule itself is not under test. */
const NEEDS_CRON = ["20261112000300_email_reminders_cron.sql", "20261120000200_reminders_every_ten_minutes.sql"];

export const migration = (name) => readFileSync(new URL(name, MIGRATIONS), "utf8");
/** Every website migration, oldest first. */
export const migrations = () => readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();

/**
 * Supabase's auth schema and the shared backend's base tables and functions
 * (from ../pro), trimmed to what the website's migrations read and rewrite.
 * The planner executor holds the exact lines those migrations replace.
 */
const BASE = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key, email text, is_anonymous boolean not null default false, raw_user_meta_data jsonb,
    created_at timestamptz not null default now(), last_sign_in_at timestamptz);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;

  create table public.planner_accounts(user_id uuid primary key references auth.users on delete cascade,
    ai_enabled boolean not null default true, ai_revision bigint not null default 0,
    consent_version text default 'weekly-ai-v1', consent_recorded_at timestamptz,
    revision bigint not null default 0, last_event_at bigint not null default 0);
  alter table public.planner_accounts enable row level security;
  create policy owner_read on public.planner_accounts for select to authenticated using (user_id = (select auth.uid()));
  create table public.planner_tasks(id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.planner_accounts on delete cascade, outcome text not null,
    planned_for date not null, slot integer constraint planner_tasks_slot_check check (slot between 1 and 3),
    is_priority boolean not null default false, estimated_minutes integer not null default 25,
    actual_seconds bigint not null default 0, status text not null default 'planned', completed_on date,
    created_at bigint not null default 0, updated_at bigint not null default 0, unique (user_id, id));
  create table public.planner_resources(id uuid primary key default gen_random_uuid(), user_id uuid not null, task_id uuid);
  create table public.planner_stops(id bigint generated always as identity primary key, user_id uuid not null,
    task_id uuid not null references public.planner_tasks on delete cascade, reason text not null,
    stopped_at bigint not null default 0, stopped_on date not null default current_date);
  create table public.planner_reviews(user_id uuid not null references public.planner_accounts on delete cascade,
    week_start date not null, report jsonb not null, primary key (user_id, week_start));
  create table public.planner_receipts(user_id uuid not null references public.planner_accounts on delete cascade,
    mutation_id uuid not null, result jsonb, primary key (user_id, mutation_id));
  alter table public.planner_tasks enable row level security;
  alter table public.planner_resources enable row level security;
  alter table public.planner_stops enable row level security;
  alter table public.planner_reviews enable row level security;
  alter table public.planner_receipts enable row level security;
  create table public.ai_controls(id boolean primary key default true, enabled boolean not null default true,
    daily_attempt_limit integer not null default 150, monthly_attempt_limit integer not null default 600,
    development_unlimited boolean not null default false);
  insert into public.ai_controls(id) values (true);
  create table public.ai_usage(period text primary key, attempts integer not null default 0);
  create table public.ai_review_requests(id uuid primary key default gen_random_uuid(), user_id uuid not null,
    quota_week date not null, week_start date not null, request_hash text not null, consent_version text not null,
    consent_recorded_at timestamptz not null default now(), status text not null,
    attempts integer not null default 1 constraint ai_review_requests_attempts_check check (attempts between 1 and 3),
    lease_token uuid not null, lease_until timestamptz not null, last_attempt_at timestamptz not null default now(),
    analysis jsonb, model text, generated_at timestamptz, activity jsonb, consent_revision bigint,
    unique (user_id, quota_week), unique (user_id, week_start));
  create table public.ai_review_previews(user_id uuid);

  create function public.planner_task_json(p_task public.planner_tasks) returns jsonb language sql stable as $$
    select jsonb_build_object('id', p_task.id, 'outcome', p_task.outcome,
      'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id)) from public.planner_resources r where r.user_id = p_task.user_id), '[]'::jsonb))
  $$;
  create function public.planner_execute(p_action text, p_args jsonb, p_timezone text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); d date := current_date; task_day date := current_date; t public.planner_tasks%rowtype; free integer;
begin
  if p_action = 'add_task' then
    select s into free from generate_series(1, 3) s where not exists(select 1 from public.planner_tasks where user_id = u and planned_for = task_day and slot = s) limit 1;
    if free is null then
      raise exception using errcode = 'PT409', message = 'Plan no more than three important tasks per day.';
    end if;
    insert into public.planner_tasks(user_id, outcome, planned_for, slot) values (u, p_args->>'outcome', task_day, free);
  elsif p_action = 'complete_task' then
    select * into t from public.planner_tasks where id = (p_args->>'id')::uuid;
    if not t.is_priority and not exists(select 1 from public.planner_tasks where user_id = u and planned_for = d and is_priority and status = 'completed') then
      raise exception using errcode = 'PT409', message = 'Complete the most important task first.';
    end if;
    update public.planner_tasks set status = 'completed', completed_on = d where id = t.id;
  elsif p_action in ('add_task_link', 'attach_task_file') then
    insert into public.planner_resources(user_id) values (u);
  else
    raise exception using errcode = 'PT400', message = 'Unsupported planner command.';
  end if;
  insert into public.planner_receipts(user_id, mutation_id, result) values (u, gen_random_uuid(), '{}'::jsonb);
  return jsonb_build_object('action', p_action);
end $$;
  create function public.planner_call(p_action text, p_args jsonb, p_timezone text) returns jsonb
  language plpgsql security definer set search_path = '' as $$
  begin
    return public.planner_execute(p_action, p_args, p_timezone);
  end $$;
  create function public.reserve_weekly_review(p_user uuid) returns uuid language sql security definer set search_path = '' as $$
    insert into public.ai_review_requests(user_id, quota_week, week_start, request_hash, consent_version, status, lease_token, lease_until)
      values (p_user, current_date, current_date, 'x', 'weekly-ai-v1', 'running', gen_random_uuid(), now()) returning id
  $$;
  create function public.purge_weekly_review_content() returns void language sql security definer set search_path = '' as $$
    update public.ai_review_requests set analysis = null where generated_at < now() - interval '30 days'
  $$;
`;

/**
 * A database as the hosted project has it: the shared base schema plus every
 * website migration, up to and including `until` (all of them by default).
 */
export async function backendDb({ until = migrations().at(-1), skip = [] } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  for (const name of migrations()) {
    if (name > until) break;
    if (NEEDS_CRON.includes(name) || skip.includes(name)) continue;
    try {
      await db.exec(migration(name));
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  }
  return db;
}

/** Runs the next statements as `sub` (null: signed out), with any extra JWT claims. */
export const as = (db, sub, claims = {}) =>
  db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(sub ? { sub, role: "authenticated", ...claims } : {})]);
