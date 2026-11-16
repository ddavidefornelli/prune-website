-- The first check-in comes three days after the account started, then one every
-- seven days from it. Apply after 20261117000100_check_in_day_after_start.sql
-- and keep it in the shared backend's deployment history too: it redefines the
-- check-in window that the loader, the reservation and the overview all read.
--
-- With S the day the account started (auth.users.created_at in the owner's
-- time zone), check-ins are due on S+3, S+10, S+17, ... A check-in due on D
-- still covers D-7 to D-1 and is identified by D-1. Before S+3 nothing is due:
-- the window counts as covered, so no AI request is made, and the overview's
-- next check-in is S+3. The check-in weekday is the weekday of S+3.
--
-- Accounts that already had check-ins on the weekday after they started move
-- to the new weekday; a window that overlaps a saved review is still skipped,
-- so the change never sends the same days twice.
begin;

create or replace function public.planner_check_in_window(p_user uuid, p_timezone text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare z text; d date; first date; due date;
begin
  z := coalesce((select n.name from pg_catalog.pg_timezone_names n where n.name = p_timezone),
    (select e.timezone from public.planner_email_reminders e where e.user_id = p_user), 'UTC');
  d := (now() at time zone z)::date;
  first := coalesce((select (u.created_at at time zone z)::date from auth.users u where u.id = p_user), d) + 3;
  -- The latest check-in day on or before today; the one before the first while it is still ahead.
  due := first + 7 * floor((d - first) / 7.0)::integer;
  return jsonb_build_object('zone', z, 'day', extract(dow from first)::smallint, 'first', first,
    'start', due - 7, 'end', due - 1, 'due', due,
    'covered', d < first or exists (select 1 from public.planner_reviews r where r.user_id = p_user
      and r.week_start >= due - 7));
end;
$$;
revoke all on function public.planner_check_in_window(uuid, text) from public, anon, authenticated;

commit;
