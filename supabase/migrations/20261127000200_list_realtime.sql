-- Shared lists in real time (2026-11-22): when anyone adds, ticks, edits or
-- deletes a task in a shared list, everyone else's open prune syncs at once
-- instead of on its next half-minute poll.
--
-- How: after every write to planner_list_tasks, a statement trigger sends a
-- Supabase Realtime broadcast ("changed", no task content) to the private
-- topic of each person in that list: 'list:<their user id>'. Browsers of a
-- shared list listen on their own topic and sync when it fires; the sync
-- itself still goes through planner_list. Lists nobody joined send nothing.
--
-- The realtime.messages policy below lets a signed-in user (guests included)
-- receive only their own topic. Hosted projects have the realtime schema; a
-- database without it (the PGlite tests) skips the policy, and a failed send
-- never blocks a sync.
--
-- Apply after 20261127000100_shared_lists.sql.
begin;

create or replace function public.planner_list_broadcast() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  list_owner uuid;
  person uuid;
begin
  for list_owner in select distinct c.user_id from changed c loop
    for person in
      select list_owner where exists (select 1 from public.planner_list_members m where m.owner_id = list_owner)
      union
      select m.member_id from public.planner_list_members m where m.owner_id = list_owner
    loop
      begin
        perform realtime.send(
          jsonb_build_object('at', floor(extract(epoch from clock_timestamp()) * 1000)),
          'changed', 'list:' || person::text, true);
      exception when others then
        -- No realtime here, or it is down: the poll still brings the change.
        raise warning 'planner_list_broadcast: % not told (%)', person, sqlerrm;
      end;
    end loop;
  end loop;
  return null;
end;
$$;
revoke all on function public.planner_list_broadcast() from public, anon, authenticated;

-- Transition tables need one trigger per kind of write.
create trigger planner_list_broadcast_insert after insert on public.planner_list_tasks
  referencing new table as changed for each statement execute function public.planner_list_broadcast();
create trigger planner_list_broadcast_update after update on public.planner_list_tasks
  referencing new table as changed for each statement execute function public.planner_list_broadcast();
create trigger planner_list_broadcast_delete after delete on public.planner_list_tasks
  referencing old table as changed for each statement execute function public.planner_list_broadcast();

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $policy$
      create policy "prune: own list topic only" on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and (select realtime.topic()) = 'list:' || (select auth.uid())::text
        )
    $policy$;
  end if;
end $$;

commit;
