-- Apply before deploying the task-helper Edge Function and the website that
-- shows "Do it for me". Additive.
--
-- The task helper (2026-11-22): for tasks it can do (write, list, plan,
-- research), the person taps "Do it for me", picks a few this-or-that
-- options, and Claude writes the result in the background. The task-helper
-- Edge Function (service role) is the only reader and writer: the browser
-- never reaches these tables.
--
-- planner_helper_runs: one answer per task, with the refine conversation
-- behind it. Discarding an answer deletes its row; Delete everything deletes
-- them all; every row goes with its Auth user.
--
-- A task deleted from the list (one by one, by Clear or by Delete
-- everything) takes its answer with it.
--
-- planner_helper_usage: what each account used, for the limits: a guest may
-- start 3 runs before signing in; everyone gets 30 runs and refines, and 300
-- sorting and question calls, a day (UTC). Discarding a run does not give it
-- back.
begin;

create table public.planner_helper_runs (
  user_id uuid not null references auth.users on delete cascade,
  task_id uuid not null,
  title text not null check (char_length(title) between 1 and 500),
  kind text check (kind in ('draft', 'list', 'plan', 'research')),
  -- The other open task titles, the picks and the locale the run was asked with.
  context jsonb not null default '[]'::jsonb check (jsonb_typeof(context) = 'array'),
  picks jsonb not null default '[]'::jsonb check (jsonb_typeof(picks) = 'array'),
  locale jsonb not null default '{}'::jsonb check (jsonb_typeof(locale) = 'object'),
  status text not null check (status in ('working', 'done', 'failed')),
  first_answer text check (char_length(first_answer) <= 20000),
  answer text check (char_length(answer) <= 20000),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  turns jsonb not null default '[]'::jsonb check (jsonb_typeof(turns) = 'array'),
  error text check (char_length(error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
alter table public.planner_helper_runs enable row level security;
revoke all on public.planner_helper_runs from public, anon, authenticated;
grant all on public.planner_helper_runs to service_role;

create table public.planner_helper_usage (
  user_id uuid primary key references auth.users on delete cascade,
  -- Runs started as a guest, ever.
  guest_starts integer not null default 0,
  day date not null default (now() at time zone 'UTC')::date,
  day_runs integer not null default 0,
  day_calls integer not null default 0
);
alter table public.planner_helper_usage enable row level security;
revoke all on public.planner_helper_usage from public, anon, authenticated;
grant all on public.planner_helper_usage to service_role;

-- Counts one use against the caller's limits, or says which limit stops it:
-- 'ok', 'sign_in' (a guest's free runs are used up) or 'daily_limit'.
-- p_kind: 'start' (a new answer), 'refine' (changing one) or 'call'
-- (sorting tasks, writing questions).
create or replace function public.planner_helper_claim(p_user uuid, p_guest boolean, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'UTC')::date;
  u public.planner_helper_usage%rowtype;
begin
  if p_user is null or p_kind is null or p_kind not in ('start', 'refine', 'call') then
    raise exception using errcode = '22023', message = 'Unsupported helper claim.';
  end if;
  insert into public.planner_helper_usage(user_id) values (p_user) on conflict do nothing;
  select * into u from public.planner_helper_usage where user_id = p_user for update;
  if u.day <> today then
    u.day := today;
    u.day_runs := 0;
    u.day_calls := 0;
  end if;
  if p_kind = 'call' then
    if u.day_calls >= 300 then return 'daily_limit'; end if;
    u.day_calls := u.day_calls + 1;
  else
    if p_kind = 'start' and coalesce(p_guest, true) and u.guest_starts >= 3 then return 'sign_in'; end if;
    if u.day_runs >= 30 then return 'daily_limit'; end if;
    u.day_runs := u.day_runs + 1;
    if p_kind = 'start' and coalesce(p_guest, true) then u.guest_starts := u.guest_starts + 1; end if;
  end if;
  update public.planner_helper_usage
    set guest_starts = u.guest_starts, day = u.day, day_runs = u.day_runs, day_calls = u.day_calls
    where user_id = p_user;
  return 'ok';
end;
$$;
revoke all on function public.planner_helper_claim(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.planner_helper_claim(uuid, boolean, text) to service_role;

create or replace function public.planner_helper_forget_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.planner_helper_runs r where r.user_id = old.user_id and r.task_id = old.id;
  return old;
end;
$$;
revoke all on function public.planner_helper_forget_task() from public, anon, authenticated;
create trigger planner_helper_forget_task after delete on public.planner_list_tasks
  for each row execute function public.planner_helper_forget_task();

commit;
