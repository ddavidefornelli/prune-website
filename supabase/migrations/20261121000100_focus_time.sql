-- Apply after 20261120000200_reminders_every_ten_minutes.sql. Keep it in the
-- shared backend's deployment history too: it redefines the reminder claim
-- and planner_schedule.
--
-- One idea instead of many: the owner's daily *focus time*. It replaces the
-- one-off start time, the "day starts at" hour, the start-time email and the
-- getting-started emails from 20261120000100. Every day at the focus time
-- (09:00 when none is set), within three hours and skipping weekends when
-- asked, prune sends one reminder (email, plus push to the browsers that
-- turned it on):
--   * tasks planned today are unfinished: "Time to focus" with those tasks;
--   * nothing planned today, and a focus time is set: "What's the one thing
--     today?", at most twice in a row without a visit, so an absent owner is
--     not asked every day; the come-back email takes over after 7 days.
-- Owners without a focus time keep the old behaviour: 09:00, tasks only.
-- The unused columns from 20261120000100 stay, so that migration's history
-- and old unsubscribe links (kind=session) keep working.
--
-- Deploy the daily-reminders function from this commit before applying this:
-- it sends the "nothing planned" variant, which the earlier function would
-- render as "0 tasks are waiting today".
begin;

alter table public.planner_email_reminders
  -- Minutes after local midnight; null means no focus time chosen (09:00, tasks only).
  add column focus_minute smallint check (focus_minute between 0 and 1439),
  -- "Nothing planned" reminders since the owner was last seen; at most two.
  add column empty_nudges smallint not null default 0,
  add column last_empty_nudge_at timestamptz;

-- No owner could set the old hour from the website yet; carry it over anyway.
update public.planner_email_reminders set focus_minute = work_hour * 60 where work_hour is not null;

create or replace function public.planner_schedule_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'focusMinute', e.focus_minute,
    'weekdaysOnly', e.weekdays_only,
    'pushDevices', (select count(*) from public.planner_push_subscriptions s where s.user_id = p_user))
  from public.planner_email_reminders e where e.user_id = p_user;
$$;
revoke all on function public.planner_schedule_state(uuid) from public, anon, authenticated;

create or replace function public.planner_schedule(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  deleted boolean;
  z text := coalesce((select n.name from pg_catalog.pg_timezone_names n where n.name = p_timezone), 'UTC');
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
  -- The focus time is read in the zone the owner is in now.
  insert into public.planner_email_reminders as e (user_id, timezone) values (u, z)
    on conflict (user_id) do update set timezone = case
      when exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_timezone) then z
      else e.timezone end;

  if p_action = 'schedule' then
    null;
  elsif p_action = 'set_focus_time' then
    if (p_args->'minute' is distinct from 'null'::jsonb
        and ((p_args->>'minute') !~ '^\d{1,4}$' or (p_args->>'minute')::integer > 1439))
      or jsonb_typeof(p_args->'weekdaysOnly') is distinct from 'boolean' then
      raise exception using errcode = 'PT400', message = 'Pick a time of day.';
    end if;
    update public.planner_email_reminders set
      focus_minute = case when p_args->'minute' = 'null'::jsonb then null else (p_args->>'minute')::smallint end,
      weekdays_only = (p_args->>'weekdaysOnly')::boolean,
      -- Choosing a focus time is a fresh start for "nothing planned" reminders.
      empty_nudges = 0
    where user_id = u;
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

-- Two kinds now: 'daily' (the focus-time reminder, with today's unfinished
-- tasks, or none for "what's the one thing?") and 'comeback'. Same atomic
-- pick-and-mark contract as before.
create or replace function public.planner_claim_reminders(p_limit integer default 100, p_now timestamptz default now())
returns table (user_id uuid, email text, kind text, tasks jsonb, unsubscribe_token uuid)
language sql security definer set search_path = '' as $$
  with base as (
    select r.user_id, r.unsubscribe_token, r.daily_enabled, r.comeback_enabled,
      r.last_daily_on, r.last_comeback_at, r.comebacks_sent, r.last_seen_at, r.focus_minute,
      u.email::text as address,
      (p_now at time zone r.timezone)::date as today,
      -- Visiting resets the "nothing planned" count.
      case when r.last_empty_nudge_at is null or r.last_seen_at > r.last_empty_nudge_at
        then 0 else r.empty_nudges end as empty_since_seen,
      extract(hour from p_now at time zone r.timezone)::integer * 60
        + extract(minute from p_now at time zone r.timezone)::integer
        - coalesce(r.focus_minute, 540) between 0 and 179
        and not (r.weekdays_only and extract(isodow from p_now at time zone r.timezone) > 5) as in_window
    from public.planner_email_reminders r
    join public.planner_accounts a on a.user_id = r.user_id and not a."isDeleted"
    join auth.users u on u.id = r.user_id and u.email is not null
  ), candidates as (
    select b.*,
      exists (select 1 from public.planner_tasks t where t.user_id = b.user_id
        and t.planned_for = b.today and t.status in ('planned', 'active')) as has_tasks,
      not exists (select 1 from public.planner_tasks t where t.user_id = b.user_id
        and t.planned_for = b.today) as nothing_planned
    from base b
    where b.in_window
  ), picked as (
    select c.user_id, c.address, c.unsubscribe_token, c.today, c.last_comeback_at,
      c.has_tasks, c.empty_since_seen,
      case
        when c.daily_enabled and c.last_daily_on is distinct from c.today
          and (c.has_tasks or (c.nothing_planned and c.focus_minute is not null and c.empty_since_seen < 2))
          then 'daily'
        when c.comeback_enabled and c.comebacks_sent < 4
          and c.last_seen_at < p_now - interval '7 days'
          and (c.last_comeback_at is null or c.last_comeback_at < p_now - interval '6 days 12 hours')
          then 'comeback'
      end as kind
    from candidates c
  ), limited as (
    select * from picked where kind is not null order by user_id limit greatest(p_limit, 0)
  ), claimed as (
    update public.planner_email_reminders r set
      last_daily_on = case when p.kind = 'daily' then p.today else r.last_daily_on end,
      empty_nudges = case when p.kind = 'daily' and not p.has_tasks then p.empty_since_seen + 1 else r.empty_nudges end,
      last_empty_nudge_at = case when p.kind = 'daily' and not p.has_tasks then p_now else r.last_empty_nudge_at end,
      last_comeback_at = case when p.kind = 'comeback' then p_now else r.last_comeback_at end,
      comebacks_sent = r.comebacks_sent + (p.kind = 'comeback')::integer
    from limited p
    where r.user_id = p.user_id
      and (p.kind <> 'daily' or r.last_daily_on is distinct from p.today)
      and (p.kind <> 'comeback' or r.last_comeback_at is not distinct from p.last_comeback_at)
    returning p.user_id, p.address, p.kind, p.unsubscribe_token, p.today
  )
  select c.user_id, c.address, c.kind,
    coalesce((select jsonb_agg(t.outcome order by t.slot)
      from public.planner_tasks t
      where c.kind = 'daily' and t.user_id = c.user_id and t.planned_for = c.today
        and t.status in ('planned', 'active')), '[]'::jsonb),
    c.unsubscribe_token
  from claimed c;
$$;

create or replace function public.planner_release_reminder(p_user_id uuid, p_kind text) returns void
language sql security definer set search_path = '' as $$
  update public.planner_email_reminders set
    last_daily_on = case when p_kind = 'daily' then null else last_daily_on end,
    -- A "nothing planned" reminder claimed in this run is not counted either.
    empty_nudges = case when p_kind = 'daily' and last_empty_nudge_at > now() - interval '30 minutes'
      then greatest(empty_nudges - 1, 0) else empty_nudges end,
    last_empty_nudge_at = case when p_kind = 'daily' and last_empty_nudge_at > now() - interval '30 minutes'
      then null else last_empty_nudge_at end,
    last_comeback_at = case when p_kind = 'comeback' then null else last_comeback_at end,
    comebacks_sent = case when p_kind = 'comeback' then greatest(comebacks_sent - 1, 0) else comebacks_sent end
  where user_id = p_user_id and p_kind in ('daily', 'comeback');
$$;
commit;
