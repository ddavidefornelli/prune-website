-- Daily come-back notifications (2026-11-23). prune asks for notification
-- permission as soon as someone opens it; a browser that allows them gets at
-- most one notification a day, at 10:00 in its time zone, on days it has not
-- opened prune yet. It stops after 30 days without a visit.
--
-- Guests can turn them on too. planner_call gains, for guests and accounts:
--   'save_push'   {endpoint, p256dh, auth}  stores (or moves) this browser's
--                 subscription, with its time zone; sent on every visit, so it
--                 also records the visit.
--   'remove_push' {endpoint}  forgets it (Delete everything sends this first).
-- planner_claim_daily_pushes (service_role) marks and returns the browsers due
-- now; the daily-reminders function sends them and reports each result with
-- planner_push_result, as before.
--
-- Apply after 20261129000100_keep_deleted_done_tasks.sql, then deploy the
-- daily-reminders function, then the website.
begin;

alter table public.planner_push_subscriptions
  add column timezone text not null default 'UTC',
  add column last_seen_at timestamptz not null default now(),
  add column last_daily_at timestamptz;

create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  guest boolean := coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
  known text := (select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone);
begin
  if u is null then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is null or p_action not in ('delete_account', 'save_push', 'remove_push') then
    raise exception using errcode = 'PT400', message = 'Unsupported action.';
  end if;
  if jsonb_typeof(p_args) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'Unsupported action.';
  end if;

  if p_action = 'remove_push' then
    delete from public.planner_push_subscriptions s
      where s.user_id = u and s.endpoint = p_args->>'endpoint';
    return jsonb_build_object('push', false);
  end if;

  if p_action = 'save_push' then
    if jsonb_typeof(p_args->'endpoint') is distinct from 'string'
      or (p_args->>'endpoint') !~ '^https://[^\s]+$' or length(p_args->>'endpoint') > 1024
      or coalesce(p_args->>'p256dh', '') !~ '^[A-Za-z0-9_-]{86,88}$'
      or coalesce(p_args->>'auth', '') !~ '^[A-Za-z0-9_-]{22,24}$' then
      raise exception using errcode = 'PT400', message = 'This browser returned an invalid notification address.';
    end if;
    insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
    -- A deleted account gets nothing; its browser simply is not stored.
    if (select a."isDeleted" from public.planner_accounts a where a.user_id = u) then
      return jsonb_build_object('push', false);
    end if;
    insert into public.planner_push_subscriptions as s (endpoint, user_id, p256dh, auth, timezone)
      values (p_args->>'endpoint', u, p_args->>'p256dh', p_args->>'auth', coalesce(known, 'UTC'))
      on conflict (endpoint) do update set
        user_id = u,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        -- An unknown zone never replaces a known one.
        timezone = case when known is null and s.user_id = u then s.timezone else excluded.timezone end,
        last_seen_at = now(),
        failures = 0;
    -- At most ten browsers per account: the least recently seen go first.
    delete from public.planner_push_subscriptions s where s.user_id = u and s.endpoint in (
      select o.endpoint from public.planner_push_subscriptions o where o.user_id = u
      order by o.last_seen_at desc offset 10);
    return jsonb_build_object('push', true);
  end if;

  -- delete_account: accounts from before guests only, as before.
  if guest then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Idempotent: a retry must never restart the 30-day retention period.
  update public.planner_accounts set "isDeleted" = true, deleted_at = now()
    where user_id = u and not "isDeleted";
  -- A deleted account's browsers get no more notifications.
  delete from public.planner_push_subscriptions s where s.user_id = u;
  return jsonb_build_object('isDeleted', true);
end;
$$;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;

-- The browsers due a notification now: 10:00 to 10:59 in their time zone, not
-- notified in the last 20 hours, not opened today, and opened in the last 30
-- days. Marked as notified before anything is sent, so a run that dies
-- halfway never sends twice.
create function public.planner_claim_daily_pushes(p_limit integer default 500, p_now timestamptz default now())
returns table (endpoint text, p256dh text, auth text, timezone text)
language sql security definer set search_path = '' as $$
  with due as (
    select s.endpoint, s.last_daily_at
    from public.planner_push_subscriptions s
    join public.planner_accounts a on a.user_id = s.user_id and not a."isDeleted"
    where extract(hour from p_now at time zone s.timezone) = 10
      and (s.last_daily_at is null or s.last_daily_at < p_now - interval '20 hours')
      and (s.last_seen_at at time zone s.timezone)::date < (p_now at time zone s.timezone)::date
      and s.last_seen_at > p_now - interval '30 days'
    order by s.endpoint
    limit greatest(p_limit, 0)
  )
  update public.planner_push_subscriptions s set last_daily_at = p_now
  from due d
  where s.endpoint = d.endpoint and s.last_daily_at is not distinct from d.last_daily_at
  returning s.endpoint, s.p256dh, s.auth, s.timezone;
$$;
revoke all on function public.planner_claim_daily_pushes(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.planner_claim_daily_pushes(integer, timestamptz) to service_role;

commit;
