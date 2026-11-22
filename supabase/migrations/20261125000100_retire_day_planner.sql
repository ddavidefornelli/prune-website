-- Retires the day planner from the database. prune is one list (2026-11-22):
-- the website reads and writes only planner_list_tasks (through planner_list),
-- deletes an account from before guests through planner_call, and the
-- reminder job sends the weekly come-back email. Everything else the day
-- planner and its AI used goes, with its data:
--   tables     planner_tasks, planner_stops, planner_reviews, planner_receipts,
--              planner_review_tasks, planner_history, planner_suggestion_usage,
--              ai_controls, ai_usage, ai_review_requests
--   functions  the planner executor and its helpers, scheduling, history,
--              month stats, weekly reviews and check-ins, task suggestions
--   columns    the AI, check-in and outbox columns of planner_accounts; the
--              daily, start-time and getting-started columns of
--              planner_email_reminders
--   cron       the AI retention job; the reminder job goes back to hourly
-- Unfinished planner tasks for today and later are copied into the list first,
-- for every account that has not opened the list yet, as its first sync would
-- have done. Completed tasks, stop reasons, reviews and history are deleted.
--
-- Apply after 20261124000200_comeback_reminders_only.sql, once the list website
-- has been live for a day (an open tab of the day planner would only get
-- errors), and after deploying the daily-reminders function from the same
-- commit. BACK UP THE DATABASE FIRST: this cannot be undone. Then undeploy the
-- weekly-review and task-suggestions Edge Functions and delete their secrets.
--
-- Nothing is dropped with CASCADE: a view, trigger or foreign key this
-- migration does not know about makes it fail, and then it changes nothing.
begin;

-- 1. Keep what is still open: copy it into the list, once per account.
insert into public.planner_list_tasks (user_id, id, title, done, created_at, updated_at)
  select t.user_id, t.id, left(btrim(t.outcome), 500), false,
    coalesce(to_timestamp(nullif(t.created_at, 0)), now()), now()
  from public.planner_tasks t
  join public.planner_accounts a on a.user_id = t.user_id
  left join public.planner_email_reminders r on r.user_id = t.user_id
  where a.list_started_at is null and not a."isDeleted"
    and t.status <> 'completed'
    and t.planned_for >= (now() at time zone coalesce(r.timezone, 'UTC'))::date
    and btrim(coalesce(t.outcome, '')) <> ''
  on conflict do nothing;

-- 2. The functions that stay, without anything the day planner needed.

-- planner_list: sync and erase only; the one-time copy above replaces its own.
create or replace function public.planner_list(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
  r public.planner_email_reminders%rowtype;
  known text := (select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone);
  -- Client clocks may run ahead; nothing may claim to be newer than this.
  latest numeric := floor(extract(epoch from now()) * 1000) + 60000;
  saves jsonb := coalesce(p_args->'save', '[]'::jsonb);
  removes jsonb := coalesce(p_args->'remove', '[]'::jsonb);
  item jsonb;
  item_id uuid;
  created numeric;
  updated numeric;
  finished numeric;
  total integer;
  rejected jsonb := '[]'::jsonb;
  signed_in numeric;
  guest boolean := coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
begin
  if u is null then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is null or p_action not in ('sync', 'erase') then
    raise exception using errcode = 'PT400', message = 'Unsupported list action.';
  end if;
  if jsonb_typeof(p_args) is distinct from 'object'
    or jsonb_typeof(saves) is distinct from 'array'
    or jsonb_typeof(removes) is distinct from 'array' then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;
  if jsonb_array_length(saves) > 200 or jsonb_array_length(removes) > 1000
    or exists (select 1 from jsonb_array_elements(removes) e
      where jsonb_typeof(e) <> 'string'
        or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;

  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serialize with deletion and with other devices' syncs.
  select * into a from public.planner_accounts where user_id = u for update;
  if a."isDeleted" then
    -- When this session signed in: the authentication times Supabase puts in
    -- every token of a session (refreshing keeps them), else when it was issued.
    signed_in := coalesce(
      (select max((m->>'timestamp')::numeric)
        from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array'
          then auth.jwt()->'amr' else '[]'::jsonb end) m
        where jsonb_typeof(m->'timestamp') = 'number'),
      case when jsonb_typeof(auth.jwt()->'iat') = 'number' then (auth.jwt()->>'iat')::numeric end);
    if a.deleted_at is not null and signed_in > extract(epoch from a.deleted_at) then
      update public.planner_accounts set "isDeleted" = false, deleted_at = null where user_id = u;
    else
      raise exception using errcode = 'PT403', message = 'This account was deleted.';
    end if;
  end if;

  if p_action = 'erase' then
    delete from public.planner_list_tasks t where t.user_id = u;
    return jsonb_build_object('tasks', '[]'::jsonb, 'rejected', '[]'::jsonb);
  end if;

  -- Remember the caller's time zone and that they were here, for the
  -- come-back email: at most one write an hour. Guests have no email, so
  -- nothing is recorded for them.
  select * into r from public.planner_email_reminders where user_id = u;
  if not guest and (not found or r.timezone is distinct from p_timezone or r.last_seen_at < now() - interval '1 hour') then
    insert into public.planner_email_reminders as e (user_id, timezone)
      values (u, coalesce(known, 'UTC'))
      on conflict (user_id) do update set
        -- An unknown zone never replaces a known one.
        timezone = coalesce(known, e.timezone),
        last_seen_at = now(),
        comebacks_sent = 0;
  end if;

  delete from public.planner_list_tasks t
    where t.user_id = u and t.id in (select (e #>> '{}')::uuid from jsonb_array_elements(removes) e);

  select count(*) into total from public.planner_list_tasks where user_id = u;
  for item in select value from jsonb_array_elements(saves) loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'title') is distinct from 'string'
      or char_length(btrim(item->>'title')) not between 1 and 500
      or jsonb_typeof(item->'done') is distinct from 'boolean'
      or jsonb_typeof(item->'createdAt') is distinct from 'number'
      or jsonb_typeof(item->'updatedAt') is distinct from 'number'
      or coalesce(jsonb_typeof(item->'doneAt'), 'null') not in ('number', 'null') then
      raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
    end if;
    item_id := (item->>'id')::uuid;
    created := least(greatest((item->>'createdAt')::numeric, 0), latest);
    updated := least(greatest((item->>'updatedAt')::numeric, 0), latest);
    finished := least(greatest(coalesce((item->>'doneAt')::numeric, updated), 0), latest);

    -- At most 1000 tasks: the oldest done task makes room for a new one.
    if not exists (select 1 from public.planner_list_tasks t where t.user_id = u and t.id = item_id) then
      if total >= 1000 then
        delete from public.planner_list_tasks t
          where t.user_id = u and t.id = (select o.id from public.planner_list_tasks o
            where o.user_id = u and o.done order by o.done_at, o.created_at limit 1);
        if not found then
          rejected := rejected || to_jsonb(item->>'id');
          continue;
        end if;
        total := total - 1;
      end if;
      total := total + 1;
    end if;

    insert into public.planner_list_tasks as t (user_id, id, title, done, created_at, updated_at, done_at)
      values (u, item_id, btrim(item->>'title'), (item->>'done')::boolean,
        to_timestamp(created / 1000), to_timestamp(updated / 1000),
        case when (item->>'done')::boolean then to_timestamp(finished / 1000) end)
      on conflict (user_id, id) do update set
        title = excluded.title,
        done = excluded.done,
        updated_at = excluded.updated_at,
        done_at = excluded.done_at
      where t.updated_at <= excluded.updated_at;
  end loop;

  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'done', t.done,
        'createdAt', floor(extract(epoch from t.created_at) * 1000)::bigint,
        'updatedAt', floor(extract(epoch from t.updated_at) * 1000)::bigint,
        'doneAt', floor(extract(epoch from t.done_at) * 1000)::bigint
      ) order by t.created_at desc, t.id)
      from public.planner_list_tasks t where t.user_id = u), '[]'::jsonb),
    'rejected', rejected);
end
$$;

-- planner_call: only deleting an account from before guests is left. The
-- operator still removes marked accounts after 30 days; a later sign-in
-- restores one (see planner_list).
create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is distinct from 'delete_account' then
    raise exception using errcode = 'PT400', message = 'Unsupported action.';
  end if;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Idempotent: a retry must never restart the 30-day retention period.
  update public.planner_accounts set "isDeleted" = true, deleted_at = now()
    where user_id = u and not "isDeleted";
  return jsonb_build_object('isDeleted', true);
end;
$$;

-- The reminder job: the come-back email only (see 20261124000200), now
-- without the task list the daily reminder carried.
drop function public.planner_claim_reminders(integer, timestamptz);
create function public.planner_claim_reminders(p_limit integer default 100, p_now timestamptz default now())
returns table (user_id uuid, email text, kind text, unsubscribe_token uuid)
language sql security definer set search_path = '' as $$
  with due as (
    select r.user_id, u.email::text as address, r.unsubscribe_token, r.last_comeback_at
    from public.planner_email_reminders r
    join public.planner_accounts a on a.user_id = r.user_id and not a."isDeleted"
    join auth.users u on u.id = r.user_id and u.email is not null
    where r.comeback_enabled and r.comebacks_sent < 4
      and r.last_seen_at < p_now - interval '7 days'
      and (r.last_comeback_at is null or r.last_comeback_at < p_now - interval '6 days 12 hours')
      -- Three hours from the owner's focus time (09:00 when none was chosen),
      -- weekdays only if so chosen.
      and extract(hour from p_now at time zone r.timezone)::integer * 60
        + extract(minute from p_now at time zone r.timezone)::integer
        - coalesce(r.focus_minute, 540) between 0 and 179
      and not (r.weekdays_only and extract(isodow from p_now at time zone r.timezone) > 5)
    order by r.user_id
    limit greatest(p_limit, 0)
  ), claimed as (
    update public.planner_email_reminders r set
      last_comeback_at = p_now,
      comebacks_sent = r.comebacks_sent + 1
    from due d
    where r.user_id = d.user_id
      and r.last_comeback_at is not distinct from d.last_comeback_at
    returning d.user_id, d.address, d.unsubscribe_token
  )
  select c.user_id, c.address, 'comeback'::text, c.unsubscribe_token
  from claimed c;
$$;
revoke all on function public.planner_claim_reminders(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.planner_claim_reminders(integer, timestamptz) to service_role;

create or replace function public.planner_release_reminder(p_user_id uuid, p_kind text) returns void
language sql security definer set search_path = '' as $$
  update public.planner_email_reminders set
    last_comeback_at = null,
    comebacks_sent = greatest(comebacks_sent - 1, 0)
  where user_id = p_user_id and p_kind = 'comeback';
$$;

-- Links in the day planner's emails say kind=daily or kind=session. Those
-- emails are gone, so such a link has nothing left to turn off: it still
-- answers, so the page can say it is done.
create or replace function public.planner_unsubscribe(p_token uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_email_reminders set
    comeback_enabled = comeback_enabled and p_kind <> 'comeback'
  where unsubscribe_token = p_token and p_kind in ('daily', 'comeback', 'session');
  return found;
end;
$$;

-- 3. Scheduled jobs: none may call what is about to go, and come-back emails
-- (a morning window of three hours) need one run an hour, not six.
do $$
begin
  if to_regclass('cron.job') is not null then
    execute $q$
      select cron.unschedule(jobid) from cron.job
      where jobname = 'pro-ai-retention'
        or command ~ '\m(planner_tasks|planner_stops|planner_reviews|planner_receipts|planner_review_tasks|planner_history|planner_suggestion_usage|ai_controls|ai_usage|ai_review_requests|purge_weekly_review_content)\M'
    $q$;
    execute $q$
      select cron.alter_job(jobid, schedule := '5 * * * *') from cron.job
      where jobname = 'prune-email-reminders'
    $q$;
  end if;
end;
$$;

-- 4. Everything that reads or writes the retired tables, and the day planner's
-- entry points that do not (scheduling). Triggers on the retired tables go
-- first, so their functions can.
do $$
declare
  retired constant text[] := array['planner_tasks', 'planner_stops', 'planner_reviews',
    'planner_receipts', 'planner_review_tasks', 'planner_history', 'planner_suggestion_usage',
    'ai_controls', 'ai_usage', 'ai_review_requests'];
  entry_points constant text[] := array['planner_schedule', 'planner_schedule_state',
    'planner_track', 'planner_call_active', 'planner_execute', 'planner_task_json',
    'planner_month_stats', 'planner_review_input', 'planner_review_overview',
    'planner_review_batch', 'planner_check_in_window', 'planner_check_in_batch',
    'reserve_planner_review', 'reserve_weekly_review', 'finish_weekly_review',
    'fail_weekly_review', 'purge_weekly_review_content', 'planner_reserve_suggestion',
    'planner_history_add', 'planner_history_task', 'planner_history_stop'];
  kept constant text[] := array['planner_list', 'planner_call', 'planner_claim_reminders',
    'planner_release_reminder', 'planner_unsubscribe', 'planner_push_targets',
    'planner_push_result', 'log_client_error'];
  uses text := '\m(' || array_to_string(retired || entry_points, '|') || ')\M';
  item record;
  dropped text[] := '{}';
begin
  for item in
    select t.tgname, t.tgrelid::regclass as relation
    from pg_catalog.pg_trigger t
    where not t.tgisinternal
      and t.tgrelid in (select c.oid from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any (retired))
  loop
    execute format('drop trigger %I on %s', item.tgname, item.relation);
  end loop;

  for item in
    select p.oid::regprocedure as fn
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and not (p.proname = any (kept))
      -- Not an extension's own function.
      and not exists (select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and (p.proname = any (entry_points) or pg_catalog.pg_get_functiondef(p.oid) ~ uses)
  loop
    execute format('drop function %s', item.fn);
    dropped := dropped || item.fn::text;
  end loop;
  raise notice 'Dropped % functions: %', cardinality(dropped), array_to_string(dropped, ', ');
end;
$$;

-- 5. The tables, together, so foreign keys among them do not set an order.
drop table if exists public.planner_history, public.planner_review_tasks,
  public.planner_stops, public.planner_receipts, public.planner_reviews,
  public.planner_tasks, public.planner_suggestion_usage, public.ai_review_requests,
  public.ai_usage, public.ai_controls;

-- 6. Columns nothing reads any more.
alter table public.planner_accounts
  drop column if exists ai_enabled,
  drop column if exists ai_revision,
  drop column if exists consent_version,
  drop column if exists consent_recorded_at,
  drop column if exists check_in_day,
  drop column if exists check_in_plan,
  drop column if exists revision,
  drop column if exists last_event_at,
  drop column if exists list_started_at;
alter table public.planner_email_reminders
  drop column if exists daily_enabled,
  drop column if exists last_daily_on,
  drop column if exists empty_nudges,
  drop column if exists last_empty_nudge_at,
  drop column if exists session_enabled,
  drop column if exists next_session_at,
  drop column if exists session_nudged_for,
  drop column if exists work_hour,
  drop column if exists activation_sent,
  drop column if exists last_activation_at;

-- 7. Nothing left may still need what went.
do $$
declare
  users text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into users
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and p.prosrc ~ '\m(planner_tasks|planner_stops|planner_reviews|planner_receipts|planner_review_tasks|planner_history|planner_suggestion_usage|ai_controls|ai_usage|ai_review_requests|list_started_at|daily_enabled|last_daily_on|ai_enabled|ai_revision)\M';
  if users is not null then
    raise exception 'Still used by: %. Review this migration before applying.', users;
  end if;
end;
$$;

commit;
