-- Apply after weekly_reviews_always_on.sql. Keep it in the shared backend's deployment
-- history too, so later Mac/backend deployments preserve the action.
-- Adds a read-only `month_stats` action for the Overview calendar: how many of a month's
-- tasks were finished and how long the owner focused. It reads only the caller's own
-- planner_tasks rows, which every client already syncs; nothing new is stored.
begin;
create function public.planner_month_stats(p_user uuid, p_args jsonb, p_timezone text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  month_start date;
  today date;
  result jsonb;
begin
  if coalesce(p_args->>'month', '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = 'PT400', message = 'Choose a month as YYYY-MM.';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception using errcode = 'PT400', message = 'Unknown time zone.';
  end if;
  month_start := pg_catalog.to_date(p_args->>'month', 'YYYY-MM');
  today := (pg_catalog.now() at time zone p_timezone)::date;
  -- Today's unfinished tasks are still in play, so they do not count against the rate.
  select pg_catalog.jsonb_build_object(
    'month', p_args->>'month',
    'planned', count(*) filter (where t.planned_for < today or t.status = 'completed'),
    'completed', count(*) filter (where t.status = 'completed'),
    'focusSeconds', coalesce(sum(t.actual_seconds), 0)
  ) into result
  from public.planner_tasks t
  where t.user_id = p_user
    and t.planned_for >= month_start
    and t.planned_for < (month_start + interval '1 month')::date
    and t.planned_for <= today;
  return result;
end;
$$;
-- Only reachable through planner_call, which supplies the signed-in owner.
revoke all on function public.planner_month_stats(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
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
commit;
