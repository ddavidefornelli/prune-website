-- Google Calendar, two ways (2026-11-23). The google-calendar Edge Function
-- (server/calendar/) keeps it; the browser never reads these tables.
--
--   planner_google_calendars  who connected: the Google refresh token,
--                             encrypted by the function (AES-GCM, its key is a
--                             function secret), and when Google was last read.
--   planner_google_states     a connect in progress: the OAuth state, for 15
--                             minutes at most.
--   planner_google_events     which Google event is which task, per person: a
--                             task planned in a shared space is an event in
--                             the calendar of everyone in it who connected.
--
--   planner_calendar_tasks(user)            planned tasks in the person's
--                                           spaces, and those with an event
--   planner_calendar_move(user, space, task, start, title)
--                                           a change made in Google Calendar
--
-- All of it goes with the account (auth.users cascade) and with Delete
-- everything (the website disconnects first, which revokes the token).
--
-- Apply after 20261201000100_task_start_times.sql.
begin;

create table public.planner_google_calendars (
  user_id uuid primary key references auth.users on delete cascade,
  refresh_token text not null,
  calendar_id text not null default 'primary',
  connected_at timestamptz not null default now(),
  -- When Google was last read for changes to prune's events.
  pulled_at timestamptz
);

create table public.planner_google_states (
  state text primary key,
  user_id uuid not null references auth.users on delete cascade,
  -- The website origin to send the person back to (checked when it was made).
  return_to text not null,
  created_at timestamptz not null default now()
);
create index planner_google_states_created on public.planner_google_states (created_at);

create table public.planner_google_events (
  user_id uuid not null references auth.users on delete cascade,
  task_id uuid not null,
  space_id uuid not null,
  event_id text not null,
  -- The event as prune last wrote or read it.
  start_at timestamptz not null,
  end_at timestamptz not null,
  title text not null,
  done boolean not null default false,
  primary key (user_id, task_id)
);

alter table public.planner_google_calendars enable row level security;
alter table public.planner_google_states enable row level security;
alter table public.planner_google_events enable row level security;
revoke all on public.planner_google_calendars, public.planner_google_states, public.planner_google_events
  from public, anon, authenticated;
grant all on public.planner_google_calendars, public.planner_google_states, public.planner_google_events
  to service_role;

-- Planned tasks the person can see (from 30 days ago on), and every task that
-- has an event in their calendar, planned or not, so a task taken off the
-- calendar loses its event. At most 500.
create or replace function public.planner_calendar_tasks(p_user uuid)
returns table (space_id uuid, id uuid, title text, done boolean, start_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select t.space_id, t.id, t.title, t.done, t.start_at
  from public.planner_list_tasks t
  join public.planner_space_members m on m.space_id = t.space_id and m.user_id = p_user
  where (t.start_at is not null and t.start_at > now() - interval '30 days')
    or exists (select 1 from public.planner_google_events e where e.user_id = p_user and e.task_id = t.id)
  order by t.start_at nulls first
  limit 500;
$$;

-- Someone moved, renamed or deleted prune's event in Google Calendar: the task
-- follows, for everyone in its space. Only in a space the person is in. The
-- change is newer than anything saved, so every device takes it.
create or replace function public.planner_calendar_move(p_user uuid, p_space uuid, p_task uuid,
  p_start timestamptz, p_title text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.planner_space_members m where m.space_id = p_space and m.user_id = p_user) then
    return false;
  end if;
  update public.planner_list_tasks t set
    start_at = p_start,
    title = coalesce(nullif(left(btrim(p_title), 500), ''), t.title),
    updated_at = greatest(now(), t.updated_at + interval '1 millisecond')
    where t.space_id = p_space and t.id = p_task;
  return found;
end;
$$;

revoke all on function public.planner_calendar_tasks(uuid) from public, anon, authenticated;
revoke all on function public.planner_calendar_move(uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.planner_calendar_tasks(uuid) to service_role;
grant execute on function public.planner_calendar_move(uuid, uuid, uuid, timestamptz, text) to service_role;

commit;
