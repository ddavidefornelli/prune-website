-- Apply after soft_delete_accounts.sql. Keep it in the shared backend's deployment
-- history too, so later Mac/backend deployments preserve the guard.
-- Weekly reviews, and the task suggestions that share ai_enabled, are part of every
-- account: owners can turn them on from any client but never off. Accounts that
-- turned them off earlier keep that preference until they turn reviews on.
-- delete_account still disables AI, and the operator can still disable it directly
-- in the database, for example to honour an objection.
begin;
create or replace function public.planner_call(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in with your email to use prune.';
  end if;
  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serialize deletion with all planner writes, including other devices.
  select * into a from public.planner_accounts where user_id = u for update;
  if p_action = 'account_status' then
    return jsonb_build_object('isDeleted', a."isDeleted");
  end if;
  if p_action = 'delete_account' then
    -- Idempotent: a retry must never restart the 30-day retention period.
    if not a."isDeleted" then
      update public.planner_accounts set "isDeleted" = true, deleted_at = now(),
        ai_enabled = false, ai_revision = ai_revision + 1 where user_id = u;
    end if;
    return jsonb_build_object('isDeleted', true);
  end if;
  if a."isDeleted" then
    raise exception using errcode = 'PT403', message = 'This account has been marked for deletion.';
  end if;
  -- Only a literal JSON true passes: false, "false" or a missing value never reach the dispatcher.
  if p_action = 'set_weekly_ai_enabled' and p_args->'enabled' is distinct from 'true'::jsonb then
    raise exception using errcode = 'PT400', message = 'Weekly reviews are part of prune and cannot be turned off.';
  end if;
  return public.planner_call_active(p_action, p_args, p_timezone);
end;
$$;
revoke all on function public.planner_call(text, jsonb, text) from public, anon;
grant execute on function public.planner_call(text, jsonb, text) to authenticated;
commit;
