-- Alerts when a planned task starts (2026-11-23): 5 minutes before, everyone
-- in the task's space gets a notification on every browser that allowed
-- them, and an email when their account has an address. Each person gets one
-- alert per task and start time: a task moved to another time alerts again,
-- a done task never does.
--
--   planner_start_alerts             who was alerted for which task and start
--   planner_claim_start_alerts(now)  (service_role) records and returns the
--                                    alerts due now, with what they need to say
--   planner_email_reminders.starts_enabled
--                                    the email's own switch; its unsubscribe
--                                    link says kind=starts
--
-- The daily-reminders function sends them when called with {"job": "starts"}
-- (every minute: 20261201000300_task_start_alerts_cron.sql).
--
-- Apply after 20261201000100_task_start_times.sql, then deploy the
-- daily-reminders function, then apply the cron migration.
begin;

alter table public.planner_email_reminders
  add column starts_enabled boolean not null default true;

create table public.planner_start_alerts (
  user_id uuid not null references auth.users on delete cascade,
  space_id uuid not null,
  task_id uuid not null,
  start_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, task_id, start_at)
);
create index planner_start_alerts_sent on public.planner_start_alerts (sent_at);
alter table public.planner_start_alerts enable row level security;
revoke all on public.planner_start_alerts from public, anon, authenticated;
grant all on public.planner_start_alerts to service_role;

create function public.planner_claim_start_alerts(p_now timestamptz default now(), p_limit integer default 1000)
returns table (
  user_id uuid,
  task_id uuid,
  title text,
  notes text,
  start_at timestamptz,
  minutes smallint,
  -- A group space's name; null for Personal.
  space_name text,
  timezone text,
  -- Null when the person has no address or turned these emails off.
  email text,
  unsubscribe_token uuid
)
language plpgsql security definer set search_path = '' as $$
begin
  -- Two days is long enough to never alert twice; nothing older is needed.
  delete from public.planner_start_alerts o where o.sent_at < p_now - interval '2 days';
  return query
  with due as (
    select m.user_id as alert_user, t.space_id as alert_space, t.id as alert_task, t.start_at as alert_start
    from public.planner_list_tasks t
    join public.planner_space_members m on m.space_id = t.space_id
    join public.planner_accounts a on a.user_id = m.user_id and not a."isDeleted"
    where not t.done and t.start_at > p_now and t.start_at <= p_now + interval '5 minutes'
    order by t.start_at, t.id, m.user_id
    limit greatest(p_limit, 0)
  ), claimed as (
    insert into public.planner_start_alerts as s (user_id, space_id, task_id, start_at)
      select d.alert_user, d.alert_space, d.alert_task, d.alert_start from due d
      on conflict do nothing
      returning s.user_id as alert_user, s.space_id as alert_space, s.task_id as alert_task, s.start_at as alert_start
  )
  select c.alert_user, c.alert_task, t.title, t.notes, c.alert_start, t.minutes,
    case when x.kind = 'group' then x.name end,
    coalesce(r.timezone, 'UTC'),
    case when not coalesce(au.is_anonymous, false) and coalesce(r.starts_enabled, false)
      then nullif(btrim(au.email), '') end,
    r.unsubscribe_token
  from claimed c
  join public.planner_list_tasks t on t.space_id = c.alert_space and t.id = c.alert_task
  join public.planner_spaces x on x.id = c.alert_space
  join auth.users au on au.id = c.alert_user
  left join public.planner_email_reminders r on r.user_id = c.alert_user
  order by c.alert_start, c.alert_task;
end;
$$;
revoke all on function public.planner_claim_start_alerts(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.planner_claim_start_alerts(timestamptz, integer) to service_role;

-- An unsubscribe link can now also turn off task-start emails.
create or replace function public.planner_unsubscribe(p_token uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_email_reminders set
    comeback_enabled = comeback_enabled and p_kind <> 'comeback',
    starts_enabled = starts_enabled and p_kind <> 'starts'
  where unsubscribe_token = p_token and p_kind in ('daily', 'comeback', 'session', 'starts');
  return found;
end;
$$;

commit;
