-- Remove the unused Clerk bridge from 20261027000100_clerk_bridge.sql. No
-- client calls planner_call_as, and the server route that did was never
-- deployed. Sign-in is Supabase Auth only (email codes and Google).
-- Refuses to run while any Clerk identity mapping exists, so no mapping is
-- lost by accident: check those accounts first, then delete the rows yourself.
-- Accounts are untouched either way; they live in auth.users, not here.
begin;
do $$
begin
  -- Nested so the inner query is only planned while the table exists: a re-run must succeed.
  if to_regclass('public.planner_clerk_identities') is not null then
    if exists (select 1 from public.planner_clerk_identities) then
      raise exception 'planner_clerk_identities still has rows; review and delete them before dropping the Clerk bridge.';
    end if;
  end if;
end;
$$;
drop function if exists public.planner_call_as(uuid, text, jsonb, text);
drop table if exists public.planner_clerk_identities;
commit;
