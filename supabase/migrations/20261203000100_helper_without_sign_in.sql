-- "Do it for me" no longer asks a guest to sign in after three answers:
-- signing in is only for sharing. Everyone keeps the same daily limits.
-- p_guest stays in the signature so the deployed Edge Function keeps working.
begin;

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
    if u.day_runs >= 30 then return 'daily_limit'; end if;
    u.day_runs := u.day_runs + 1;
  end if;
  update public.planner_helper_usage
    set day = u.day, day_runs = u.day_runs, day_calls = u.day_calls
    where user_id = p_user;
  return 'ok';
end;
$$;
revoke all on function public.planner_helper_claim(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.planner_helper_claim(uuid, boolean, text) to service_role;

commit;
