-- Apply after month_stats.sql. Keep it in the shared backend's deployment history too,
-- so later Mac/backend deployments preserve the planner_call changes.
-- Reminder emails: one "tasks pending today" email per local day, and a weekly
-- "come back" email for accounts not seen for 7 days. This migration only stores
-- preferences and decides who is due; the daily-reminders Edge Function sends.
begin;
create table public.planner_email_reminders (
  user_id uuid primary key references public.planner_accounts(user_id) on delete cascade,
  -- Last time zone a client reported, so emails arrive in the owner's morning.
  timezone text not null default 'UTC',
  last_seen_at timestamptz not null default now(),
  daily_enabled boolean not null default true,
  comeback_enabled boolean not null default true,
  -- Opaque capability for the unsubscribe link; never the user id.
  unsubscribe_token uuid not null default gen_random_uuid() unique,
  -- Idempotency: at most one daily email per local day, one come-back per week.
  last_daily_on date,
  last_comeback_at timestamptz,
  -- Consecutive come-back emails since the owner was last seen; capped so an
  -- abandoned address is not mailed forever.
  comebacks_sent integer not null default 0
);
alter table public.planner_email_reminders enable row level security;
revoke all on public.planner_email_reminders from public, anon, authenticated;
grant all on public.planner_email_reminders to service_role;

-- Existing accounts count as seen now: nobody gets a come-back email sooner
-- than 7 days after this migration.
insert into public.planner_email_reminders (user_id)
  select a.user_id from public.planner_accounts a where not a."isDeleted"
  on conflict do nothing;

create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
  r public.planner_email_reminders%rowtype;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in with your email to use prune.';
  end if;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serialize deletion with all planner writes, including other devices.
  select * into a from public.planner_accounts where user_id = u for update;
  if p_action = 'account_status' then
    return jsonb_build_object('isDeleted', a."isDeleted");
  end if;
  if p_action = 'delete_account' then
    -- Idempotent: a retry must never restart the 30-day retention period.
    if not a."isDeleted" then
      update public.planner_accounts set "isDeleted" = true, deleted_at = now(),
        ai_enabled = false, ai_revision = ai_revision + 1 where user_id = u;
    end if;
    return jsonb_build_object('isDeleted', true);
  end if;
  if a."isDeleted" then
    raise exception using errcode = 'PT403', message = 'This account has been marked for deletion.';
  end if;
  -- Remember the caller's time zone and that they were here, for reminder emails.
  -- At most one write per hour per account unless the time zone changes.
  select * into r from public.planner_email_reminders where user_id = u;
  if not found or r.timezone is distinct from p_timezone or r.last_seen_at < now() - interval '1 hour' then
    insert into public.planner_email_reminders as e (user_id, timezone)
      values (u, coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone), 'UTC'))
      on conflict (user_id) do update set
        -- An unknown zone never replaces a known one.
        timezone = coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone), e.timezone),
        last_seen_at = now(),
        comebacks_sent = 0;
  end if;
  if p_action = 'set_email_preferences' then
    if jsonb_typeof(p_args->'daily') is distinct from 'boolean'
      or jsonb_typeof(p_args->'comeback') is distinct from 'boolean' then
      raise exception using errcode = 'PT400', message = 'Choose on or off for each email.';
    end if;
    update public.planner_email_reminders set
      daily_enabled = (p_args->>'daily')::boolean,
      comeback_enabled = (p_args->>'comeback')::boolean
    where user_id = u;
  end if;
  if p_action in ('email_preferences', 'set_email_preferences') then
    return (select jsonb_build_object('daily', e.daily_enabled, 'comeback', e.comeback_enabled)
      from public.planner_email_reminders e where e.user_id = u);
  end if;
  -- Only a literal JSON true passes: false, "false" or a missing value never reach the dispatcher.
  if p_action = 'set_weekly_ai_enabled' and p_args->'enabled' is distinct from 'true'::jsonb then
    raise exception using errcode = 'PT400', message = 'Weekly reviews are part of prune and cannot be turned off.';
  end if;
  if p_action = 'month_stats' then
    return public.planner_month_stats(u, p_args, p_timezone);
  end if;
  return public.planner_call_active(p_action, p_args, p_timezone);
end;
$$;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;

-- Atomically picks who is due and marks them as sent, so overlapping or retried
-- runs can never email the same person twice. Runs hourly; an email is due while
-- it is 09:00-11:59 in the owner's time zone, which also catches up a missed run.
--   daily:    tasks planned for today are still unfinished.
--   comeback: not seen for 7 days, at most weekly, at most 4 in a row.
create function public.planner_claim_reminders(p_limit integer default 100, p_now timestamptz default now())
returns table (user_id uuid, email text, kind text, tasks jsonb, unsubscribe_token uuid)
language sql security definer set search_path = '' as $$
  with candidates as (
    select r.user_id, u.email::text as email, r.unsubscribe_token, r.last_comeback_at,
      (p_now at time zone r.timezone)::date as today,
      r.daily_enabled and r.last_daily_on is distinct from (p_now at time zone r.timezone)::date as daily_open,
      r.comeback_enabled and r.comebacks_sent < 4
        and r.last_seen_at < p_now - interval '7 days'
        and (r.last_comeback_at is null or r.last_comeback_at < p_now - interval '6 days 12 hours') as comeback_open
    from public.planner_email_reminders r
    join public.planner_accounts a on a.user_id = r.user_id and not a."isDeleted"
    join auth.users u on u.id = r.user_id and u.email is not null
    where extract(hour from p_now at time zone r.timezone) between 9 and 11
  ), pending as (
    select c.*, (select jsonb_agg(t.outcome order by t.slot)
      from public.planner_tasks t
      where c.daily_open and t.user_id = c.user_id and t.planned_for = c.today
        and t.status in ('planned', 'active')) as tasks
    from candidates c
    where c.daily_open or c.comeback_open
  ), picked as (
    select p.*, case when p.tasks is not null then 'daily' else 'comeback' end as kind
    from pending p
    where p.tasks is not null or p.comeback_open
    order by p.user_id
    limit greatest(p_limit, 0)
  ), claimed as (
    update public.planner_email_reminders r set
      last_daily_on = case when p.kind = 'daily' then p.today else r.last_daily_on end,
      last_comeback_at = case when p.kind = 'comeback' then p_now else r.last_comeback_at end,
      comebacks_sent = r.comebacks_sent + (p.kind = 'comeback')::integer
    from picked p
    where r.user_id = p.user_id
      -- Rechecked under the row lock: a concurrent run that got here first wins.
      and (p.kind <> 'daily' or r.last_daily_on is distinct from p.today)
      and (p.kind <> 'comeback' or r.last_comeback_at is not distinct from p.last_comeback_at)
    returning p.user_id, p.email, p.kind, p.tasks, p.unsubscribe_token
  )
  select c.user_id, c.email, c.kind, coalesce(c.tasks, '[]'::jsonb), c.unsubscribe_token from claimed c;
$$;

-- Undo a claim whose email could not be handed to the provider, so the next
-- hourly run inside the morning window retries it.
create function public.planner_release_reminder(p_user_id uuid, p_kind text) returns void
language sql security definer set search_path = '' as $$
  update public.planner_email_reminders set
    last_daily_on = case when p_kind = 'daily' then null else last_daily_on end,
    last_comeback_at = case when p_kind = 'comeback' then null else last_comeback_at end,
    comebacks_sent = case when p_kind = 'comeback' then greatest(comebacks_sent - 1, 0) else comebacks_sent end
  where user_id = p_user_id and p_kind in ('daily', 'comeback');
$$;

-- Turns one kind of email off for whoever holds the link's token.
create function public.planner_unsubscribe(p_token uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_email_reminders set
    daily_enabled = daily_enabled and p_kind <> 'daily',
    comeback_enabled = comeback_enabled and p_kind <> 'comeback'
  where unsubscribe_token = p_token and p_kind in ('daily', 'comeback');
  return found;
end;
$$;

-- Only the Edge Functions (service role) may claim, release or unsubscribe.
revoke all on function public.planner_claim_reminders(integer, timestamptz) from public, anon, authenticated;
revoke all on function public.planner_release_reminder(uuid, text) from public, anon, authenticated;
revoke all on function public.planner_unsubscribe(uuid, text) from public, anon, authenticated;
grant execute on function public.planner_claim_reminders(integer, timestamptz) to service_role;
grant execute on function public.planner_release_reminder(uuid, text) to service_role;
grant execute on function public.planner_unsubscribe(uuid, text) to service_role;
commit;
