-- Apply after 20261119000100_five_tasks_per_day.sql. Keep it in the shared
-- backend's deployment history too: it redefines the reminder claim.
--
-- Many new accounts add a placeholder task and leave: signing up is often not
-- the moment they want to work. This migration lets the owner say when they
-- want to start, and nudges them then.
--   * next_session_at: a one-off start time the owner picked. At that time
--     prune sends a "session" reminder (email, plus browser push on every
--     device that turned it on).
--   * work_hour / weekdays_only: when their day usually starts. The daily
--     reminder, the getting-started emails and the come-back email arrive in
--     that hour instead of always at 09:00.
--   * activation: up to two getting-started emails in the first week to
--     accounts that have never finished a task (day 1 and day 3), before the
--     come-back email takes over. They share the come-back switch.
--   * planner_push_subscriptions: Web Push endpoints, one per browser.
-- Session reminders have their own switch (session_enabled).
begin;

alter table public.planner_email_reminders
  add column session_enabled boolean not null default true,
  add column next_session_at timestamptz,
  -- The next_session_at value that was already announced: a new time is a new reminder.
  add column session_nudged_for timestamptz,
  add column work_hour smallint check (work_hour between 5 and 22),
  add column weekdays_only boolean not null default false,
  add column activation_sent smallint not null default 0,
  add column last_activation_at timestamptz;

-- One row per browser. The endpoint is a capability URL issued by the
-- browser's push service; the keys encrypt every payload end to end, so the
-- push service only ever sees ciphertext. A browser that signs in to another
-- account moves its endpoint to that account.
create table public.planner_push_subscriptions (
  endpoint text primary key check (endpoint ~ '^https://[^\s]+$' and length(endpoint) <= 1024),
  user_id uuid not null references public.planner_accounts(user_id) on delete cascade,
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22,24}$'),
  created_at timestamptz not null default now(),
  -- Consecutive failed deliveries; the row is dropped after five.
  failures smallint not null default 0
);
create index planner_push_subscriptions_user on public.planner_push_subscriptions (user_id);
alter table public.planner_push_subscriptions enable row level security;
revoke all on public.planner_push_subscriptions from public, anon, authenticated;
grant all on public.planner_push_subscriptions to service_role;

-- The owner's scheduling settings, in the shape the client reads.
create function public.planner_schedule_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'nextSessionAt', case when e.next_session_at > now() - interval '2 hours'
      then floor(extract(epoch from e.next_session_at))::bigint end,
    'workHour', e.work_hour,
    'weekdaysOnly', e.weekdays_only,
    'sessionEmails', e.session_enabled,
    'pushDevices', (select count(*) from public.planner_push_subscriptions s where s.user_id = p_user))
  from public.planner_email_reminders e where e.user_id = p_user;
$$;
revoke all on function public.planner_schedule_state(uuid) from public, anon, authenticated;

-- A separate entry point from planner_call, so the planner dispatcher does not
-- have to be redefined. Never queued by the client: these are preferences.
create function public.planner_schedule(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  deleted boolean;
  z text := coalesce((select n.name from pg_catalog.pg_timezone_names n where n.name = p_timezone), 'UTC');
  v_at timestamptz;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in with your email to use prune.';
  end if;
  select a."isDeleted" into deleted from public.planner_accounts a where a.user_id = u;
  if not found then
    raise exception using errcode = 'PT400', message = 'Open your planner first.';
  end if;
  if deleted then
    raise exception using errcode = 'PT403', message = 'This account has been marked for deletion.';
  end if;
  -- Start times are read in the zone the owner is in now.
  insert into public.planner_email_reminders as e (user_id, timezone) values (u, z)
    on conflict (user_id) do update set timezone = case
      when exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then z
      else e.timezone end;

  if p_action = 'schedule' then
    null;
  elsif p_action = 'set_next_session' then
    if p_args->'at' = 'null'::jsonb or not (p_args ? 'at') then
      update public.planner_email_reminders set next_session_at = null where user_id = u;
    else
      if jsonb_typeof(p_args->'at') is distinct from 'number' then
        raise exception using errcode = 'PT400', message = 'Pick a start time.';
      end if;
      v_at := to_timestamp((p_args->>'at')::double precision);
      if v_at < now() - interval '10 minutes' or v_at > now() + interval '8 days' then
        raise exception using errcode = 'PT400', message = 'Pick a time within the next week.';
      end if;
      update public.planner_email_reminders set next_session_at = v_at where user_id = u;
    end if;
  elsif p_action = 'set_work_hours' then
    if (p_args->'hour' <> 'null'::jsonb and ((p_args->>'hour') !~ '^\d{1,2}$' or (p_args->>'hour')::integer not between 5 and 22))
      or jsonb_typeof(p_args->'weekdaysOnly') is distinct from 'boolean' then
      raise exception using errcode = 'PT400', message = 'Pick an hour between 05:00 and 22:00.';
    end if;
    update public.planner_email_reminders set
      work_hour = case when p_args->'hour' = 'null'::jsonb then null else (p_args->>'hour')::smallint end,
      weekdays_only = (p_args->>'weekdaysOnly')::boolean
    where user_id = u;
  elsif p_action = 'set_session_emails' then
    if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
      raise exception using errcode = 'PT400', message = 'Choose on or off.';
    end if;
    update public.planner_email_reminders set session_enabled = (p_args->>'enabled')::boolean where user_id = u;
  elsif p_action = 'save_push' then
    if jsonb_typeof(p_args->'endpoint') is distinct from 'string'
      or (p_args->>'endpoint') !~ '^https://[^\s]+$' or length(p_args->>'endpoint') > 1024
      or coalesce(p_args->>'p256dh', '') !~ '^[A-Za-z0-9_-]{86,88}$'
      or coalesce(p_args->>'auth', '') !~ '^[A-Za-z0-9_-]{22,24}$' then
      raise exception using errcode = 'PT400', message = 'This browser returned an invalid notification address.';
    end if;
    insert into public.planner_push_subscriptions as s (endpoint, user_id, p256dh, auth)
      values (p_args->>'endpoint', u, p_args->>'p256dh', p_args->>'auth')
      on conflict (endpoint) do update set user_id = u, p256dh = excluded.p256dh,
        auth = excluded.auth, failures = 0, created_at = now();
    -- At most ten browsers per account: the oldest go first.
    delete from public.planner_push_subscriptions s where s.user_id = u and s.endpoint in (
      select o.endpoint from public.planner_push_subscriptions o where o.user_id = u
      order by o.created_at desc offset 10);
  elsif p_action = 'remove_push' then
    delete from public.planner_push_subscriptions s
      where s.user_id = u and s.endpoint = p_args->>'endpoint';
  else
    raise exception using errcode = 'PT400', message = 'Unsupported scheduling action.';
  end if;
  return public.planner_schedule_state(u);
end;
$$;
revoke all on function public.planner_schedule(text, jsonb, text) from public, anon;
grant execute on function public.planner_schedule(text, jsonb, text) to authenticated;

-- Same contract as before (atomic pick-and-mark, so overlapping or retried runs
-- never send twice), now run every ten minutes and with four kinds, at most
-- one per account per run, in this order:
--   session:    the start time the owner picked has come (up to 2 hours late).
--   daily:      tasks planned for today are unfinished, in the owner's start hour.
--   activation: never finished a task, joined 20 hours to 7 days ago, at most
--               two, 44+ hours apart, and no start time still ahead.
--   comeback:   not seen for 7 days, at most weekly, at most 4 in a row.
-- "Start hour" is work_hour (09:00 by default) and the two hours after it,
-- skipping weekends when weekdays_only is set.
create or replace function public.planner_claim_reminders(p_limit integer default 100, p_now timestamptz default now())
returns table (user_id uuid, email text, kind text, tasks jsonb, unsubscribe_token uuid)
language sql security definer set search_path = '' as $$
  with base as (
    select r.user_id, r.timezone, r.unsubscribe_token, r.daily_enabled, r.comeback_enabled,
      r.session_enabled, r.next_session_at, r.session_nudged_for, r.last_daily_on,
      r.last_comeback_at, r.comebacks_sent, r.last_seen_at, r.activation_sent, r.last_activation_at,
      u.email::text as address, u.created_at as joined,
      (p_now at time zone r.timezone)::date as today,
      extract(hour from p_now at time zone r.timezone)::integer between coalesce(r.work_hour, 9) and coalesce(r.work_hour, 9) + 2
        and not (r.weekdays_only and extract(isodow from p_now at time zone r.timezone) > 5) as in_window
    from public.planner_email_reminders r
    join public.planner_accounts a on a.user_id = r.user_id and not a."isDeleted"
    join auth.users u on u.id = r.user_id and u.email is not null
  ), candidates as (
    select b.*,
      b.session_enabled and b.next_session_at <= p_now and b.next_session_at > p_now - interval '2 hours'
        and b.session_nudged_for is distinct from b.next_session_at as session_open,
      -- A start time already reminded them today: no second nudge the same day.
      b.in_window and b.daily_enabled and b.last_daily_on is distinct from b.today
        and ((b.session_nudged_for at time zone b.timezone)::date is distinct from b.today)
        and exists (select 1 from public.planner_tasks t where t.user_id = b.user_id
          and t.planned_for = b.today and t.status in ('planned', 'active')) as daily_open,
      b.in_window and b.comeback_enabled and b.activation_sent < 2
        and b.joined < p_now - interval '20 hours' and b.joined > p_now - interval '7 days'
        and (b.last_activation_at is null or b.last_activation_at < p_now - interval '44 hours')
        and (b.next_session_at is null or b.next_session_at < p_now)
        and ((b.session_nudged_for at time zone b.timezone)::date is distinct from b.today)
        and not exists (select 1 from public.planner_tasks t where t.user_id = b.user_id
          and t.status = 'completed') as activation_open,
      b.in_window and b.comeback_enabled and b.comebacks_sent < 4
        and b.last_seen_at < p_now - interval '7 days'
        and (b.last_comeback_at is null or b.last_comeback_at < p_now - interval '6 days 12 hours') as comeback_open
    from base b
  ), picked as (
    select c.user_id, c.address, c.unsubscribe_token, c.today, c.next_session_at,
      c.last_comeback_at, c.last_activation_at, c.timezone,
      case when c.session_open then 'session' when c.daily_open then 'daily'
        when c.activation_open then 'activation' else 'comeback' end as kind
    from candidates c
    where c.session_open or c.daily_open or c.activation_open or c.comeback_open
    order by c.user_id
    limit greatest(p_limit, 0)
  ), claimed as (
    update public.planner_email_reminders r set
      last_daily_on = case when p.kind = 'daily' then p.today else r.last_daily_on end,
      last_comeback_at = case when p.kind = 'comeback' then p_now else r.last_comeback_at end,
      comebacks_sent = r.comebacks_sent + (p.kind = 'comeback')::integer,
      session_nudged_for = case when p.kind = 'session' then p.next_session_at else r.session_nudged_for end,
      last_activation_at = case when p.kind = 'activation' then p_now else r.last_activation_at end,
      activation_sent = r.activation_sent + (p.kind = 'activation')::integer
    from picked p
    where r.user_id = p.user_id
      -- Rechecked under the row lock: a concurrent run that got here first wins.
      and (p.kind <> 'daily' or r.last_daily_on is distinct from p.today)
      and (p.kind <> 'comeback' or r.last_comeback_at is not distinct from p.last_comeback_at)
      and (p.kind <> 'session' or (r.next_session_at is not distinct from p.next_session_at
        and r.session_nudged_for is distinct from p.next_session_at))
      and (p.kind <> 'activation' or r.last_activation_at is not distinct from p.last_activation_at)
    returning p.user_id, p.address, p.kind, p.unsubscribe_token, p.today, p.next_session_at, p.timezone
  )
  select c.user_id, c.address, c.kind,
    coalesce((select jsonb_agg(t.outcome order by t.planned_for, t.slot)
      from public.planner_tasks t
      where t.user_id = c.user_id and t.status in ('planned', 'active') and case c.kind
        when 'session' then t.planned_for = (c.next_session_at at time zone c.timezone)::date
        when 'daily' then t.planned_for = c.today
        when 'activation' then t.planned_for >= c.today
        else false end), '[]'::jsonb),
    c.unsubscribe_token
  from claimed c;
$$;

create or replace function public.planner_release_reminder(p_user_id uuid, p_kind text) returns void
language sql security definer set search_path = '' as $$
  update public.planner_email_reminders set
    last_daily_on = case when p_kind = 'daily' then null else last_daily_on end,
    last_comeback_at = case when p_kind = 'comeback' then null else last_comeback_at end,
    comebacks_sent = case when p_kind = 'comeback' then greatest(comebacks_sent - 1, 0) else comebacks_sent end,
    session_nudged_for = case when p_kind = 'session' then null else session_nudged_for end,
    last_activation_at = case when p_kind = 'activation' then null else last_activation_at end,
    activation_sent = case when p_kind = 'activation' then greatest(activation_sent - 1, 0) else activation_sent end
  where user_id = p_user_id and p_kind in ('daily', 'comeback', 'session', 'activation');
$$;

create or replace function public.planner_unsubscribe(p_token uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_email_reminders set
    daily_enabled = daily_enabled and p_kind <> 'daily',
    comeback_enabled = comeback_enabled and p_kind <> 'comeback',
    session_enabled = session_enabled and p_kind <> 'session'
  where unsubscribe_token = p_token and p_kind in ('daily', 'comeback', 'session');
  return found;
end;
$$;

-- Push endpoints for the accounts a run just claimed.
create function public.planner_push_targets(p_users uuid[])
returns table (user_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = '' as $$
  select s.user_id, s.endpoint, s.p256dh, s.auth
  from public.planner_push_subscriptions s
  where s.user_id = any(p_users);
$$;

-- 'sent' resets the failure count, 'gone' (404/410: the browser dropped it)
-- deletes the endpoint, 'failed' deletes it after five failures in a row.
create function public.planner_push_result(p_endpoint text, p_result text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_result = 'sent' then
    update public.planner_push_subscriptions set failures = 0 where endpoint = p_endpoint and failures > 0;
  elsif p_result = 'gone' then
    delete from public.planner_push_subscriptions where endpoint = p_endpoint;
  elsif p_result = 'failed' then
    update public.planner_push_subscriptions set failures = failures + 1 where endpoint = p_endpoint;
    delete from public.planner_push_subscriptions where endpoint = p_endpoint and failures >= 5;
  end if;
end;
$$;

revoke all on function public.planner_push_targets(uuid[]) from public, anon, authenticated;
revoke all on function public.planner_push_result(text, text) from public, anon, authenticated;
grant execute on function public.planner_push_targets(uuid[]) to service_role;
grant execute on function public.planner_push_result(text, text) to service_role;
commit;
