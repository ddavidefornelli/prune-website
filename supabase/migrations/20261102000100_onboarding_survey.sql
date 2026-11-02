-- Onboarding survey. Answers travel inside the existing guest import (never a
-- separate path) and never include the visitor's name, which stays in their
-- browser. The weekly review may cite the week outcome for its own week.
-- Also adds anonymous survey funnel totals. Apply after all prior migrations.
begin;
create table public.planner_onboarding (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goal text check (goal in ('ship', 'study', 'procrastination', 'business', 'exploring')),
  role text check (role in ('student', 'engineer', 'creative', 'founder', 'other')),
  focus_window text check (focus_window in ('morning', 'afternoon', 'evening', 'varies')),
  focus_minutes smallint check (focus_minutes in (15, 30, 60, 90)),
  derailer text check (derailer in ('phone', 'overload', 'starting', 'interruptions')),
  deep_work_hours smallint check (deep_work_hours between 1 and 4),
  week_goal text check (char_length(week_goal) between 1 and 200),
  week_start date check (extract(isodow from week_start) = 1),
  updated_at timestamptz not null default now(),
  check ((week_goal is null) = (week_start is null))
);
alter table public.planner_onboarding enable row level security;
revoke all on public.planner_onboarding from public, anon, authenticated;
grant all on public.planner_onboarding to service_role;

-- Same import as 20261028000100_guest_import.sql, plus an optional "survey"
-- object. An import of answers alone writes no tasks and leaves the planner
-- revision alone, so it can never conflict with queued account changes.
create or replace function public.planner_import_guest(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  v_import_id uuid;
  prior jsonb;
  item jsonb;
  survey jsonb;
  task_day date;
  free_slot smallint;
  n bigint := extract(epoch from now())::bigint;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in before saving guest tasks.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 1048576
    or jsonb_typeof(p_payload->'tasks') is distinct from 'array'
    or jsonb_typeof(p_payload->'stops') is distinct from 'array' then
    raise exception using errcode = 'PT400', message = 'Invalid guest import.';
  end if;
  v_import_id := (p_payload->>'importId')::uuid;
  if v_import_id is null or jsonb_array_length(p_payload->'tasks') > 1000
    or jsonb_array_length(p_payload->'stops') > 5000 then
    raise exception using errcode = 'PT400', message = 'Guest import is too large or missing its identity.';
  end if;
  survey := p_payload->'survey';
  if survey is not null then
    -- Nested checks: SQL does not short-circuit OR, and key functions need an object.
    if jsonb_typeof(survey) <> 'object' then
      raise exception using errcode = 'PT400', message = 'Invalid onboarding answers.';
    end if;
    if exists (select 1 from jsonb_each(survey) e where e.key not in ('goal', 'role', 'focusWindow',
        'focusMinutes', 'derailer', 'deepWorkHours', 'weekGoal', 'weekStart')
        or jsonb_typeof(e.value) <> case when e.key in ('focusMinutes', 'deepWorkHours')
          then 'number' else 'string' end)
      or (survey ? 'weekGoal') <> (survey ? 'weekStart')
      or coalesce(survey->>'weekStart', '2026-01-05') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = 'PT400', message = 'Invalid onboarding answers.';
    end if;
  end if;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  perform 1 from public.planner_accounts where user_id = u for update;
  if exists (select 1 from public.planner_accounts where user_id = u and "isDeleted") then
    raise exception using errcode = 'PT403', message = 'This account has been deleted.';
  end if;
  select payload into prior from public.planner_guest_imports g
    where g.user_id = u and g.import_id = v_import_id;
  if found then
    if prior <> p_payload then
      raise exception using errcode = 'PT409', message = 'Guest import identity was reused.';
    end if;
    return jsonb_build_object('imported', true);
  end if;
  for item in select value from jsonb_array_elements(p_payload->'tasks') loop
    task_day := (item->>'plannedFor')::date;
    select s into free_slot from generate_series(1, 3) s
      where not exists (select 1 from public.planner_tasks t where t.user_id = u and t.planned_for = task_day and t.slot = s)
      order by s limit 1;
    if free_slot is null then
      raise exception using errcode = 'PT409', message = 'Your account already has tasks on a guest planning day. Guest tasks remain on this device; no tasks were imported.';
    end if;
    if (item->>'createdAt')::bigint > n + 120 or (item->>'startedAt')::bigint > n + 120
      or (item->>'actualSeconds')::bigint > 315360000
      or (item->>'createdAt')::bigint < 0 then
      raise exception using errcode = 'PT400', message = 'Invalid guest task time.';
    end if;
    if item->>'status' = 'active' and exists (select 1 from public.planner_tasks where user_id = u and status = 'active') then
      raise exception using errcode = 'PT409', message = 'Finish the active account task before saving guest tasks. Guest tasks remain on this device.';
    end if;
    insert into public.planner_tasks(id, user_id, outcome, planned_for, slot, estimated_minutes,
      actual_seconds, status, started_at, completed_on, created_at, is_priority)
    values ((item->>'id')::uuid, u, item->>'outcome', task_day, free_slot,
      (item->>'estimatedMinutes')::integer, (item->>'actualSeconds')::bigint, item->>'status',
      (item->>'startedAt')::bigint, (item->>'completedOn')::date, (item->>'createdAt')::bigint, false);
  end loop;
  for item in select value from jsonb_array_elements(p_payload->'stops') loop
    if not exists (select 1 from jsonb_array_elements(p_payload->'tasks') t where t->>'id' = item->>'taskId') then
      raise exception using errcode = 'PT400', message = 'Invalid guest stop task.';
    end if;
    insert into public.planner_stops(user_id, task_id, reason, stopped_at, stopped_on)
      values (u, (item->>'taskId')::uuid, item->>'reason', (item->>'at')::bigint, (item->>'day')::date);
  end loop;
  if survey is not null then
    insert into public.planner_onboarding as o (user_id, goal, role, focus_window, focus_minutes,
      derailer, deep_work_hours, week_goal, week_start, updated_at)
    values (u, survey->>'goal', survey->>'role', survey->>'focusWindow',
      (survey->>'focusMinutes')::smallint, survey->>'derailer', (survey->>'deepWorkHours')::smallint,
      survey->>'weekGoal', (survey->>'weekStart')::date, now())
    on conflict (user_id) do update set goal = excluded.goal, role = excluded.role,
      focus_window = excluded.focus_window, focus_minutes = excluded.focus_minutes,
      derailer = excluded.derailer, deep_work_hours = excluded.deep_work_hours,
      -- Answers from a later import without an outcome keep the earlier one.
      week_goal = coalesce(excluded.week_goal, o.week_goal),
      week_start = case when excluded.week_goal is null then o.week_start else excluded.week_start end,
      updated_at = excluded.updated_at;
  end if;
  if jsonb_array_length(p_payload->'tasks') > 0 or jsonb_array_length(p_payload->'stops') > 0 then
    update public.planner_accounts set revision = revision + 1, last_event_at = greatest(last_event_at, n) where user_id = u;
  end if;
  insert into public.planner_guest_imports(user_id, import_id, payload) values (u, v_import_id, p_payload);
  return jsonb_build_object('imported', true);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or unique_violation or datetime_field_overflow then
  raise exception using errcode = 'PT400', message = 'Invalid or conflicting guest data. Guest tasks remain on this device; no tasks were imported.';
end;
$$;
revoke all on function public.planner_import_guest(jsonb) from public, anon;
grant execute on function public.planner_import_guest(jsonb) to authenticated;

-- Server-only: the weekly-review loader reads the outcome for the week it reviews.
create function public.planner_week_goal(p_user_id uuid, p_week_start date) returns text
language sql stable security definer set search_path = '' as $$
  select o.week_goal from public.planner_onboarding o
  where o.user_id = p_user_id and o.week_start = p_week_start
$$;
revoke all on function public.planner_week_goal(uuid, date) from public, anon, authenticated;
grant execute on function public.planner_week_goal(uuid, date) to service_role;

-- Survey funnel totals, per experiment variant, in the existing anonymous
-- daily counter. Like the other metrics, each call adds at most one.
alter table public.guest_usage_daily drop constraint guest_usage_daily_metric_check;
alter table public.guest_usage_daily add constraint guest_usage_daily_metric_check check (metric in (
  'new_guests', 'active_guests', 'returning_guests', 'tasks_created', 'tasks_started',
  'tasks_completed', 'focus_minutes', 'funnel_control_shown', 'funnel_control_signed_up',
  'funnel_survey_shown', 'funnel_survey_started', 'funnel_survey_finished',
  'funnel_survey_plan_shown', 'funnel_survey_google_clicked', 'funnel_survey_signed_up',
  'funnel_survey_skipped'));

create or replace function public.guest_record_usage(p_metrics jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item record;
  today date := (now() at time zone 'utc')::date;
begin
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then
    raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
  end if;
  for item in select key, value from jsonb_each(p_metrics) loop
    if item.key not in ('new_guests', 'active_guests', 'returning_guests',
        'tasks_created', 'tasks_started', 'tasks_completed', 'focus_minutes',
        'funnel_control_shown', 'funnel_control_signed_up', 'funnel_survey_shown',
        'funnel_survey_started', 'funnel_survey_finished', 'funnel_survey_plan_shown',
        'funnel_survey_google_clicked', 'funnel_survey_signed_up', 'funnel_survey_skipped')
      or jsonb_typeof(item.value) <> 'number' or item.value::text !~ '^[0-9]{1,4}$' then
      raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
    end if;
    -- Cast only after the format check above; OR does not short-circuit in SQL.
    if item.value::text::integer > (case when item.key = 'focus_minutes' then 1440 else 1 end) then
      raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
    end if;
  end loop;
  insert into public.guest_usage_daily as u (day, metric, total)
    select today, key, value::text::bigint from jsonb_each(p_metrics) where value::text::bigint > 0
    on conflict (day, metric) do update set total = u.total + excluded.total;
end;
$$;
revoke all on function public.guest_record_usage(jsonb) from public, anon, authenticated;
grant execute on function public.guest_record_usage(jsonb) to anon;
commit;
