-- Apply after 20261121000100_focus_time.sql, with 20261124000100_task_list.sql,
-- before deploying the website that shows the task list.
--
-- The list has no days, so the daily focus-time reminder (today's planned
-- tasks, or "what's the one thing?" when nothing was planned) has nothing true
-- to say any more, and its "Start now" link opened a timer that is gone. Only
-- the come-back email is claimed now: at most once a week after 7 days away,
-- four in a row at most, in the owner's usual morning window, exactly as
-- before. Preferences, focus times and push subscriptions are kept as they are.
begin;

create or replace function public.planner_claim_reminders(p_limit integer default 100, p_now timestamptz default now())
returns table (user_id uuid, email text, kind text, tasks jsonb, unsubscribe_token uuid)
language sql security definer set search_path = '' as $$
  with due as (
    select r.user_id, u.email::text as address, r.unsubscribe_token, r.last_comeback_at
    from public.planner_email_reminders r
    join public.planner_accounts a on a.user_id = r.user_id and not a."isDeleted"
    join auth.users u on u.id = r.user_id and u.email is not null
    where r.comeback_enabled and r.comebacks_sent < 4
      and r.last_seen_at < p_now - interval '7 days'
      and (r.last_comeback_at is null or r.last_comeback_at < p_now - interval '6 days 12 hours')
      -- The same window the reminders always used: three hours from the focus
      -- time (09:00 when none was chosen), weekdays only if so chosen.
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
  select c.user_id, c.address, 'comeback'::text, '[]'::jsonb, c.unsubscribe_token
  from claimed c;
$$;

commit;
