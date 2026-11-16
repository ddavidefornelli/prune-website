-- AI reviews become a weekly check-in on a day the owner picks, instead of a
-- review every batch of completed tasks. Apply after
-- 20261112000500_reviews_every_ten_tasks.sql and keep it in the shared
-- backend's deployment history too: it redefines planner_call, the review
-- loader, the reservation, the finish step and the overview.
--
-- On the check-in day D (Sunday unless the owner picks another), the check-in
-- covers the seven days before it, D-7 to D-1: every task planned or finished
-- in those days and the written stop reasons. planner_reviews.week_start and
-- ai_review_requests.week_start hold D-1 as the check-in's identity. A week
-- that overlaps a review saved in the last seven days (after changing the day,
-- or right after a batch review) is skipped, so no work is reviewed twice.
--
-- The owner's answer to the check-in (the estimate padding and the number of
-- tasks a day they accepted) is stored as check_in_plan and returned with the
-- overview, so every device plans with it.
--
-- Earlier drafts of this branch added a silver/golden review cycle; if a
-- database has them, they are removed here.
begin;

drop function if exists public.reserve_silver_review(uuid, date, text, text, jsonb);
drop function if exists public.finish_silver_review(uuid, uuid, jsonb, text);
drop function if exists public.fail_silver_review(uuid, uuid);
drop function if exists public.planner_silver_batch(uuid);
drop function if exists public.planner_silver_target(uuid);
drop function if exists public.planner_review_cycle(uuid);
drop function if exists public.planner_review_target(uuid);
drop table if exists public.planner_silver_reviews;

alter table public.planner_accounts add column if not exists check_in_day smallint not null default 0;
alter table public.planner_accounts drop constraint if exists planner_accounts_check_in_day_check;
alter table public.planner_accounts add constraint planner_accounts_check_in_day_check check (check_in_day between 0 and 6);
alter table public.planner_accounts add column if not exists check_in_plan jsonb;
comment on column public.planner_accounts.check_in_day is
  'Weekday of the weekly check-in: 0 is Sunday, 6 is Saturday.';
comment on column public.planner_accounts.check_in_plan is
  'The plan accepted at the last check-in: estimateFactor, dailyTarget, decidedFor.';

-- The check-in due now, in the owner's time zone: the request's zone when it is
-- a real one, else the last one the account was seen in.
create or replace function public.planner_check_in_window(p_user uuid, p_timezone text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare z text; d date; w smallint; due date;
begin
  z := coalesce((select n.name from pg_catalog.pg_timezone_names n where n.name = p_timezone),
    (select e.timezone from public.planner_email_reminders e where e.user_id = p_user), 'UTC');
  d := (now() at time zone z)::date;
  w := coalesce((select a.check_in_day from public.planner_accounts a where a.user_id = p_user), 0);
  due := d - ((extract(dow from d)::integer - w + 7) % 7);
  return jsonb_build_object('zone', z, 'day', w, 'start', due - 7, 'end', due - 1, 'due', due,
    'covered', exists (select 1 from public.planner_reviews r where r.user_id = p_user
      and r.week_start between due - 7 and due - 1));
end;
$$;

-- A week's activity, in the shape the Edge Function validates.
create or replace function public.planner_check_in_batch(p_user uuid, p_start date, p_end date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with eligible_stops as (
    select s.* from public.planner_stops s
    where s.user_id = p_user and s.stopped_on between p_start and p_end and s.reason <> 'Reason not provided'
  ), latest_stops as (
    select * from eligible_stops order by id desc limit 200
  ), week as (
    select t.* from public.planner_tasks t
    where t.user_id = p_user and (t.planned_for between p_start and p_end
      or t.completed_on between p_start and p_end
      or t.id in (select task_id from latest_stops))
    order by t.planned_for, t.created_at, t.id limit 256
  ), stops as (
    select s.* from latest_stops s where s.task_id in (select id from week)
  )
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'outcome', outcome, 'plannedFor', planned_for,
      'completedOn', completed_on, 'status', status, 'estimatedMinutes', estimated_minutes, 'actualSeconds', actual_seconds)
      order by planned_for, created_at, id) from week), '[]'::jsonb),
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'taskId', task_id, 'reason', reason, 'stoppedOn', stopped_on)
      order by id) from stops), '[]'::jsonb),
    'totalStops', (select count(*) from eligible_stops),
    'omittedStops', (select count(*) from eligible_stops) - (select count(*) from stops));
$$;

-- Only the Edge Function loads inputs. Nothing due: empty activity, so the
-- function answers noData without contacting OpenAI.
create or replace function public.planner_review_input(p_user_id uuid, p_timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; w jsonb; b jsonb;
begin
  select * into a from public.planner_accounts where user_id = p_user_id;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then
    return jsonb_build_object('disabled', true);
  end if;
  w := public.planner_check_in_window(p_user_id, p_timezone);
  if (w->>'covered')::boolean then
    b := jsonb_build_object('tasks', '[]'::jsonb, 'stops', '[]'::jsonb, 'totalStops', 0, 'omittedStops', 0);
  else
    b := public.planner_check_in_batch(p_user_id, (w->>'start')::date, (w->>'end')::date);
  end if;
  return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', w->>'start', 'weekEnd', w->>'end',
    'activity', b);
end;
$$;

-- One paid call per check-in, with the same lease, retry and global caps.
create or replace function public.reserve_planner_review(p_user_id uuid, p_week_start date, p_request_hash text,
  p_consent_version text, p_activity jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_day text := 'day:' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD');
  v_month text := 'month:' || to_char(v_now at time zone 'UTC', 'YYYY-MM');
  v_token uuid := gen_random_uuid();
  a public.planner_accounts%rowtype;
  v_controls public.ai_controls%rowtype;
  v_request public.ai_review_requests%rowtype;
  v_attempts integer;
  w jsonb;
  b jsonb;
  k date;
begin
  if p_user_id is null or p_week_start is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_consent_version is distinct from 'weekly-ai-v1' or p_activity is null or jsonb_typeof(p_activity) <> 'object' then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into a from public.planner_accounts where user_id = p_user_id for update;
  if not found or not a.ai_enabled or a.consent_version is distinct from p_consent_version then
    return jsonb_build_object('outcome', 'disabled');
  end if;
  -- The request must be exactly the check-in that is due now.
  w := public.planner_check_in_window(p_user_id);
  k := (w->>'end')::date;
  if p_week_start is distinct from (w->>'start')::date then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_request from public.ai_review_requests where user_id = p_user_id and week_start = k for update;
  -- A saved check-in stays readable from the cache; an overlapping one is never paid for.
  if (w->>'covered')::boolean and not (found and v_request.status = 'succeeded') then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  b := public.planner_check_in_batch(p_user_id, (w->>'start')::date, k);
  if (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(b->'tasks') x)
     is distinct from (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(p_activity->'tasks') x) then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_controls from public.ai_controls where id = true for update;
  if not found or not v_controls.enabled then
    return jsonb_build_object('outcome', 'disabled');
  end if;

  if v_request.id is not null then
    if v_request.status = 'succeeded' then
      if v_request.request_hash <> p_request_hash then
        return jsonb_build_object('outcome', 'conflict');
      end if;
      if v_request.generated_at <= v_now - interval '7 days' or v_request.analysis is null then
        return jsonb_build_object('outcome', 'expired');
      end if;
      return jsonb_build_object('outcome', 'cached', 'analysis', v_request.analysis,
        'model', v_request.model, 'generatedAt', v_request.generated_at);
    end if;
    if v_request.status = 'running' and v_request.lease_until > v_now then
      return jsonb_build_object('outcome', 'running');
    end if;
    -- Retry an hour apart; after three failures, once a day, so a check-in is never stuck.
    if not v_controls.development_unlimited and (v_request.last_attempt_at > v_now - interval '1 hour'
       or (v_request.attempts >= 3 and v_request.last_attempt_at > v_now - interval '1 day')) then
      return jsonb_build_object('outcome', 'rate_limited');
    end if;
  end if;

  insert into public.ai_usage (period) values (v_day), (v_month) on conflict do nothing;
  if not v_controls.development_unlimited then
    select attempts into v_attempts from public.ai_usage where period = v_day;
    if v_attempts >= v_controls.daily_attempt_limit then
      return jsonb_build_object('outcome', 'global_limit');
    end if;
    select attempts into v_attempts from public.ai_usage where period = v_month;
    if v_attempts >= v_controls.monthly_attempt_limit then
      return jsonb_build_object('outcome', 'global_limit');
    end if;
  end if;
  update public.ai_usage set attempts = attempts + 1 where period in (v_day, v_month);

  if v_request.id is null then
    insert into public.ai_review_requests (user_id, quota_week, week_start, period_start, request_hash, consent_version,
      status, lease_token, lease_until, activity, consent_revision)
    values (p_user_id, k, k, p_week_start, p_request_hash, p_consent_version,
      'running', v_token, v_now + interval '3 minutes', p_activity, a.ai_revision)
    returning * into v_request;
  else
    update public.ai_review_requests set status = 'running', request_hash = p_request_hash, period_start = p_week_start,
      consent_version = p_consent_version, consent_recorded_at = v_now,
      attempts = attempts + 1, last_attempt_at = v_now, lease_token = v_token, lease_until = v_now + interval '3 minutes',
      activity = p_activity, consent_revision = a.ai_revision
    where id = v_request.id returning * into v_request;
  end if;
  return jsonb_build_object('outcome', 'reserved', 'id', v_request.id, 'leaseToken', v_token);
end;
$$;

-- Same checks as before; a check-in marks no tasks, since weeks never overlap.
create or replace function public.finish_weekly_review(p_id uuid, p_lease_token uuid, p_analysis jsonb, p_model text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.ai_review_requests%rowtype; a public.planner_accounts%rowtype;
begin
  if p_lease_token is null then return false; end if;
  select * into r from public.ai_review_requests where id = p_id;
  if not found then return false; end if;
  select * into a from public.planner_accounts where user_id = r.user_id for update;
  select * into r from public.ai_review_requests where id = p_id for update;
  if a.ai_enabled is distinct from true or a.ai_revision is distinct from r.consent_revision or r.activity is null
    or r.lease_token is distinct from p_lease_token or r.status is distinct from 'running' or r.lease_until <= now()
    or p_analysis is null or jsonb_typeof(p_analysis) <> 'object' or octet_length(p_analysis::text) > 65536
    or p_model is null or length(p_model) not between 1 and 120 then return false; end if;
  insert into public.planner_reviews(user_id, week_start, report) values (r.user_id, r.week_start,
    jsonb_build_object('weekStart', coalesce(r.period_start, r.week_start),
      'weekEnd', case when r.period_start is null then r.week_start + 6 else r.week_start end,
      'generatedAt', extract(epoch from now())::bigint,
      'model', p_model, 'activity', r.activity, 'analysis', p_analysis)) on conflict do nothing;
  update public.ai_review_requests set status = 'succeeded', analysis = p_analysis, model = p_model,
    generated_at = now(), activity = null where id = p_id;
  return true;
end;
$$;

-- What Overview shows: the next check-in, its status, the plan and saved reports.
create or replace function public.planner_review_overview(p_user uuid, p_timezone text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.planner_accounts%rowtype;
  attempt public.ai_review_requests%rowtype;
  w jsonb;
  b jsonb;
  k date;
  next_day date;
  reports jsonb;
  ai_available boolean;
  state text;
begin
  select * into a from public.planner_accounts where user_id = p_user;
  w := public.planner_check_in_window(p_user, p_timezone);
  if not (w->>'covered')::boolean then
    b := public.planner_check_in_batch(p_user, (w->>'start')::date, (w->>'end')::date);
    if jsonb_array_length(b->'tasks') > 0 or jsonb_array_length(b->'stops') > 0 then
      k := (w->>'end')::date;
      select * into attempt from public.ai_review_requests where user_id = p_user and week_start = k;
    end if;
  end if;
  next_day := case when k is null then (w->>'due')::date + 7 else (w->>'due')::date end;
  select coalesce(jsonb_agg(report order by week_start desc), '[]'::jsonb) into reports
    from (select report, week_start from public.planner_reviews where user_id = p_user order by week_start desc limit 52) x;
  select coalesce((select c.enabled and (c.development_unlimited or (
      coalesce((select attempts from public.ai_usage where period = 'day:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD')), 0) < c.daily_attempt_limit
      and coalesce((select attempts from public.ai_usage where period = 'month:' || to_char(now() at time zone 'UTC', 'YYYY-MM')), 0) < c.monthly_attempt_limit))
    from public.ai_controls c where id), false) into ai_available;
  state := case
    when not coalesce(a.ai_enabled, false) then 'disabled'
    when k is null then case when jsonb_array_length(reports) = 0 then 'no_data' else 'up_to_date' end
    when not ai_available then 'unavailable'
    when attempt.status = 'running' and attempt.lease_until > now() then 'running'
    when attempt.status in ('failed', 'running') then 'failed'
    else 'pending' end;
  return jsonb_build_object('settings', jsonb_build_object('enabled', coalesce(a.ai_enabled, false)), 'model', 'gpt-4.1-mini',
    'developmentUnlimited', coalesce((select development_unlimited from public.ai_controls where id), false),
    'available', ai_available,
    'week', jsonb_build_object('start', w->>'start', 'end', w->>'end', 'nextUpdate', next_day,
      'nextUpdateAt', next_day::timestamp at time zone (w->>'zone')),
    'checkIn', jsonb_build_object('day', (w->>'day')::integer, 'plan', a.check_in_plan),
    'status', state,
    'error', case when state = 'failed' then 'Your check-in could not be written. Please try again later.' else null end,
    'reviews', reports);
end;
$$;

revoke all on function public.planner_check_in_window(uuid, text), public.planner_check_in_batch(uuid, date, date),
  public.planner_review_overview(uuid, text) from public, anon, authenticated;
revoke all on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb),
  public.finish_weekly_review(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb),
  public.finish_weekly_review(uuid, uuid, jsonb, text) to service_role;

-- Same guard as 20261112000500_reviews_every_ten_tasks.sql, plus the check-in day and plan.
create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
  r public.planner_email_reminders%rowtype;
  v_factor numeric;
  v_target integer;
  v_for date;
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
  if p_action = 'weekly_overview' then
    return public.planner_review_overview(u, p_timezone);
  end if;
  if p_action = 'set_check_in_day' then
    if jsonb_typeof(p_args->'day') is distinct from 'number' or (p_args->>'day') !~ '^[0-6]$' then
      raise exception using errcode = 'PT400', message = 'Choose a day of the week for your check-in.';
    end if;
    update public.planner_accounts set check_in_day = (p_args->>'day')::smallint where user_id = u;
    return public.planner_review_overview(u, p_timezone);
  end if;
  if p_action = 'set_check_in_plan' then
    if jsonb_typeof(p_args->'estimateFactor') is distinct from 'number'
      or jsonb_typeof(p_args->'dailyTarget') is distinct from 'number'
      or jsonb_typeof(p_args->'decidedFor') is distinct from 'string'
      or (p_args->>'dailyTarget') !~ '^[1-5]$'
      or (p_args->>'decidedFor') !~ '^20\d{2}-\d{2}-\d{2}$' then
      raise exception using errcode = 'PT400', message = 'That plan is not valid.';
    end if;
    v_factor := (p_args->>'estimateFactor')::numeric;
    v_target := (p_args->>'dailyTarget')::integer;
    v_for := (p_args->>'decidedFor')::date;
    if v_factor < 0.5 or v_factor > 3 or v_factor <> round(v_factor, 2)
      or v_for > (now() at time zone coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone), 'UTC'))::date + 1 then
      raise exception using errcode = 'PT400', message = 'That plan is not valid.';
    end if;
    update public.planner_accounts set check_in_plan = jsonb_build_object(
      'estimateFactor', v_factor, 'dailyTarget', v_target, 'decidedFor', v_for) where user_id = u;
    return public.planner_review_overview(u, p_timezone);
  end if;
  if p_action = 'set_weekly_ai_enabled' then
    perform public.planner_call_active(p_action, p_args, p_timezone);
    return public.planner_review_overview(u, p_timezone);
  end if;
  return public.planner_call_active(p_action, p_args, p_timezone);
end;
$$;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;

commit;
