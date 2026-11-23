-- Keep deleted done tasks (2026-11-23), so the operator can count every task
-- ever finished and created, not only the ones still in a list.
--
-- When a done task leaves planner_list_tasks, a copy goes to
-- planner_deleted_tasks first, whatever removed it: deleting it from the list,
-- "Clear done", or the 1,000-task cap making room. Tasks that were not done
-- are not kept.
--
-- When a whole space goes (its creator deletes it, chooses Delete everything,
-- or the account is removed), its done tasks are still counted, but without
-- their title or space: only when they were created, finished and deleted.
--
-- planner_task_totals() (service_role only): tasks created (in lists now plus
-- deleted done ones), tasks done, and deleted done tasks.
--
-- Apply after 20261128000200_create_spaces.sql. Nothing in the website changes.
begin;

create table public.planner_deleted_tasks (
  row_id bigint generated always as identity primary key,
  -- Null once the space is gone.
  space_id uuid,
  id uuid not null,
  -- Null once the space is gone.
  title text,
  created_at timestamptz not null,
  done_at timestamptz not null,
  deleted_at timestamptz not null default now()
);
create index planner_deleted_tasks_space on public.planner_deleted_tasks (space_id);
alter table public.planner_deleted_tasks enable row level security;
revoke all on public.planner_deleted_tasks from public, anon, authenticated;
grant all on public.planner_deleted_tasks to service_role;

create or replace function public.planner_keep_deleted_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- A cascade from a deleted space runs after the space row is gone.
  space_kept boolean := exists (select 1 from public.planner_spaces x where x.id = old.space_id);
begin
  insert into public.planner_deleted_tasks (space_id, id, title, created_at, done_at)
    values (
      case when space_kept then old.space_id end,
      old.id,
      case when space_kept then old.title end,
      old.created_at,
      old.done_at);
  return old;
end;
$$;
revoke all on function public.planner_keep_deleted_task() from public, anon, authenticated;

create trigger planner_keep_deleted_task before delete on public.planner_list_tasks
  for each row when (old.done) execute function public.planner_keep_deleted_task();

-- Deleting a space later anonymises what was kept from it too.
create or replace function public.planner_forget_deleted_space() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_deleted_tasks d set space_id = null, title = null
    where d.space_id in (select c.id from changed c);
  return null;
end;
$$;
revoke all on function public.planner_forget_deleted_space() from public, anon, authenticated;

create trigger planner_forget_deleted_space after delete on public.planner_spaces
  referencing old table as changed for each statement execute function public.planner_forget_deleted_space();

create or replace function public.planner_task_totals()
returns table (created bigint, done bigint, deleted_done bigint)
language sql stable security definer set search_path = '' as $$
  with live as (select count(*) as n, count(*) filter (where t.done) as done from public.planner_list_tasks t),
  gone as (select count(*) as n from public.planner_deleted_tasks)
  select live.n + gone.n, live.done + gone.n, gone.n from live, gone;
$$;
revoke all on function public.planner_task_totals() from public, anon, authenticated;
grant execute on function public.planner_task_totals() to service_role;

commit;
