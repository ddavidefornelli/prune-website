-- The weekly check-in day is no longer chosen: it is the weekday after the
-- account started (auth.users.created_at in the owner's time zone, plus one
-- day). Apply after 20261116000100_weekly_check_in.sql and keep it in the
-- shared backend's deployment history too: it redefines the check-in window
-- and planner_call.
--
-- It also fixes repeated check-ins. A week was skipped only when a saved
-- review ended inside it, so moving the day back pointed at an earlier,
-- unreviewed week and every change paid for another check-in over days that
-- were already covered. Now a week is skipped when any saved review ends on or
-- after its first day.
begin;

create or replace function public.planner_check_in_window(p_user uuid, p_timezone text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare z text; d date; started date; w smallint; due date;
begin
  z := coalesce((select n.name from pg_catalog.pg_timezone_names n where n.name = p_timezone),
    (select e.timezone from public.planner_email_reminders e where e.user_id = p_user), 'UTC');
  d := (now() at time zone z)::date;
  started := (select (u.created_at at time zone z)::date from auth.users u where u.id = p_user);
  w := extract(dow from coalesce(started, d) + 1)::smallint;
  due := d - ((extract(dow from d)::integer - w + 7) % 7);
  return jsonb_build_object('zone', z, 'day', w, 'start', due - 7, 'end', due - 1, 'due', due,
    'covered', exists (select 1 from public.planner_reviews r where r.user_id = p_user
      and r.week_start >= due - 7));
end;
$$;
revoke all on function public.planner_check_in_window(uuid, text) from public, anon, authenticated;

-- Same guard as 20261116000100_weekly_check_in.sql; the check-in day can no longer be set.
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
    raise exception using errcode = 'PT400', message = 'Your check-in is always on the weekday after you started.';
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
