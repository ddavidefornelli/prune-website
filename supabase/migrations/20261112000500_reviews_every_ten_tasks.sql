-- AI reviews happen every 10 completed tasks instead of every Sunday.
-- Apply after 20261112000200_email_reminders.sql and keep it in the shared
-- backend's deployment history too: it redefines planner_call, the review
-- loader, the reservation and the finish step that every client relies on.
--
-- A review covers a batch: the first 10 completed tasks that no review has
-- covered yet (oldest completion first) and the written stop reasons on those
-- tasks. Only completions from the week this ships onwards count, so earlier
-- work that weekly reviews already covered is not reviewed twice. Saved reports
-- keep the same shape: weekStart/weekEnd now hold the batch's first and last
-- dates, and planner_reviews.week_start / ai_review_requests.week_start hold
-- the batch's last date as its identity (one batch can't end on the same day
-- as the next: at most a few tasks fit in a day).
--
-- Mac clients keep working: they call the same Edge Function and read the same
-- weekly_overview shape, which gains an optional `progress` field.
begin;

alter table public.ai_controls add column if not exists task_reviews_since date;
update public.ai_controls set task_reviews_since = coalesce(task_reviews_since,
  date_trunc('week', now() at time zone 'UTC')::date);
alter table public.ai_controls alter column task_reviews_since set not null;
comment on column public.ai_controls.task_reviews_since is
  'Completed tasks count toward AI reviews only from this date.';

-- Remembers which tasks a review has covered, so each task counts once.
create table if not exists public.planner_review_tasks (
  user_id uuid not null,
  task_id uuid not null,
  review_end date not null,
  primary key (user_id, task_id),
  foreign key (user_id, task_id) references public.planner_tasks(user_id, id) on delete cascade
);
alter table public.planner_review_tasks enable row level security;
revoke all on public.planner_review_tasks from public, anon, authenticated;
grant select, insert, update, delete on public.planner_review_tasks to service_role;

-- Period start, set only for batch reviews; null on older weekly requests.
alter table public.ai_review_requests add column if not exists period_start date;
-- A batch that keeps failing must stay retryable (see the reservation below).
alter table public.ai_review_requests drop constraint if exists ai_review_requests_attempts_check;
alter table public.ai_review_requests add constraint ai_review_requests_attempts_check check (attempts >= 1);

-- The current batch: how many completed tasks are waiting, and the first 10.
create or replace function public.planner_review_batch(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pending as (
    select t.* from public.planner_tasks t
    where t.user_id = p_user and t.status = 'completed'
      and t.completed_on >= coalesce((select c.task_reviews_since from public.ai_controls c where c.id), '-infinity'::date)
      and not exists (select 1 from public.planner_review_tasks r where r.user_id = p_user and r.task_id = t.id)
  ), batch as (
    select * from pending order by completed_on, created_at, id limit 10
  ), eligible_stops as (
    select s.* from public.planner_stops s join batch b on b.id = s.task_id
    where s.user_id = p_user and s.reason <> 'Reason not provided'
  ), selected_stops as (
    select * from eligible_stops order by id desc limit 200
  )
  select jsonb_build_object(
    'completed', (select count(*) from pending),
    'target', 10,
    'start', least((select min(completed_on) from batch), (select min(stopped_on) from selected_stops)),
    'end', greatest((select max(completed_on) from batch), (select max(stopped_on) from selected_stops)),
    'activity', jsonb_build_object(
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'outcome', outcome, 'plannedFor', planned_for,
        'completedOn', completed_on, 'status', status, 'estimatedMinutes', estimated_minutes, 'actualSeconds', actual_seconds)
        order by completed_on, created_at, id) from batch), '[]'::jsonb),
      'stops', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'taskId', task_id, 'reason', reason, 'stoppedOn', stopped_on)
        order by id) from selected_stops), '[]'::jsonb),
      'totalStops', (select count(*) from eligible_stops),
      'omittedStops', greatest(0, (select count(*) from eligible_stops) - 200)));
$$;

-- Only the Edge Function loads inputs. Fewer than 10 tasks: empty activity, so
-- the function answers noData without contacting OpenAI.
create or replace function public.planner_review_input(p_user_id uuid, p_timezone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.planner_accounts%rowtype; b jsonb; d date;
begin
  select * into a from public.planner_accounts where user_id = p_user_id;
  if not found or not a.ai_enabled or a.consent_version is distinct from 'weekly-ai-v1' then
    return jsonb_build_object('disabled', true);
  end if;
  b := public.planner_review_batch(p_user_id);
  if (b->>'completed')::integer < (b->>'target')::integer then
    d := (now() at time zone coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone), 'UTC'))::date;
    return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', d, 'weekEnd', d,
      'activity', jsonb_build_object('tasks', '[]'::jsonb, 'stops', '[]'::jsonb, 'totalStops', 0, 'omittedStops', 0));
  end if;
  return jsonb_build_object('consentVersion', 'weekly-ai-v1', 'weekStart', b->>'start', 'weekEnd', b->>'end',
    'activity', b->'activity');
end;
$$;

-- One paid call per batch, with the same lease, retry and global caps as
-- before. There is no weekly allowance any more: the batch is the allowance.
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
  -- The request must be exactly the batch that is due now.
  b := public.planner_review_batch(p_user_id);
  if (b->>'completed')::integer < (b->>'target')::integer
     or p_week_start is distinct from (b->>'start')::date
     or (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(b->'activity'->'tasks') x)
        is distinct from (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(p_activity->'tasks') x) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  k := (b->>'end')::date;

  select * into v_controls from public.ai_controls where id = true for update;
  if not found or not v_controls.enabled then
    return jsonb_build_object('outcome', 'disabled');
  end if;

  select * into v_request from public.ai_review_requests where user_id = p_user_id and week_start = k for update;
  if found then
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
    -- Retry an hour apart; after three failures, once a day, so a batch is never stuck.
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

-- Same checks as before; a batch review also marks its tasks as reviewed.
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
  if r.period_start is not null then
    insert into public.planner_review_tasks(user_id, task_id, review_end)
      select r.user_id, t.id, r.week_start from public.planner_tasks t
      where t.user_id = r.user_id and t.id in (select (x->>'id')::uuid from jsonb_array_elements(r.activity->'tasks') x)
      on conflict do nothing;
  end if;
  update public.ai_review_requests set status = 'succeeded', analysis = p_analysis, model = p_model,
    generated_at = now(), activity = null where id = p_id;
  return true;
end;
$$;

-- What Overview shows: progress toward the next review, its status and saved reports.
create or replace function public.planner_review_overview(p_user uuid, p_timezone text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.planner_accounts%rowtype;
  attempt public.ai_review_requests%rowtype;
  b jsonb;
  d date;
  k date;
  done integer;
  goal integer;
  reports jsonb;
  ai_available boolean;
  state text;
begin
  select * into a from public.planner_accounts where user_id = p_user;
  d := (now() at time zone coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone), 'UTC'))::date;
  b := public.planner_review_batch(p_user);
  done := (b->>'completed')::integer;
  goal := (b->>'target')::integer;
  if done >= goal then
    k := (b->>'end')::date;
    select * into attempt from public.ai_review_requests where user_id = p_user and week_start = k;
  end if;
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
    'week', jsonb_build_object('start', coalesce(b->>'start', d::text), 'end', coalesce(b->>'end', d::text), 'nextUpdate', d),
    'progress', jsonb_build_object('completed', least(done, goal), 'target', goal),
    'status', state,
    'error', case when state = 'failed' then 'Your AI review could not be generated. Please try again later.' else null end,
    'reviews', reports);
end;
$$;

revoke all on function public.planner_review_batch(uuid), public.planner_review_overview(uuid, text) from public, anon, authenticated;
revoke all on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb),
  public.finish_weekly_review(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.planner_review_input(uuid, text), public.reserve_planner_review(uuid, date, text, text, jsonb),
  public.finish_weekly_review(uuid, uuid, jsonb, text) to service_role;

-- Same guard as 20261112000200_email_reminders.sql, plus the new overview.
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
  if p_action = 'weekly_overview' then
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
