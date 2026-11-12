-- Apply after email_reminders.sql. That migration counted every existing account
-- as seen at the moment it ran, so nobody could get a come-back email for a week.
-- Replace that placeholder with each account's real last activity: the later of
-- its last sign-in and its last planner event (epoch seconds). Rows a client has
-- touched since (a later last_seen_at) are left alone, and a value is only ever
-- moved earlier, never later.
update public.planner_email_reminders r set last_seen_at = s.seen
from (
  select a.user_id,
    greatest(u.last_sign_in_at,
      case when a.last_event_at > 0 then to_timestamp(a.last_event_at) end,
      u.created_at) as seen
  from public.planner_accounts a
  join auth.users u on u.id = a.user_id
) s
where r.user_id = s.user_id
  and r.last_seen_at < timestamptz '2026-11-12 02:00:00+00'
  and r.comebacks_sent = 0
  and s.seen < r.last_seen_at;
