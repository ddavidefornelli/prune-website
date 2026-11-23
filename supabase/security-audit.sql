-- READ ONLY. Run in the HOSTED project's SQL Editor as its administrator.
-- This does not apply migrations, change data, or read anyone's tasks.
-- It complements, not replaces, two-account hosted isolation testing.

-- 1. Every table the website relies on exists with RLS enabled (all true/true).
with expected(name) as (values
  ('planner_accounts'), ('planner_list_tasks'), ('planner_email_reminders'),
  ('planner_push_subscriptions'), ('planner_spaces'), ('planner_space_members'),
  ('planner_deleted_tasks'), ('error_log')
)
select e.name, c.oid is not null as table_exists,
  coalesce(c.relrowsecurity, false) as rls_enabled
from expected e
left join pg_catalog.pg_class c on c.oid = to_regclass('public.' || e.name)
order by e.name;

-- 2. No anon or authenticated direct INSERT/UPDATE/DELETE privileges, and
-- SELECT only on planner_accounts (owner policy). The list is reachable only
-- through planner_list; reminders, push and the error log only server-side.
with expected(name) as (values
  ('planner_accounts'), ('planner_list_tasks'), ('planner_email_reminders'),
  ('planner_push_subscriptions'), ('planner_spaces'), ('planner_space_members'),
  ('planner_deleted_tasks'), ('error_log')
), roles(name) as (values ('anon'), ('authenticated'))
select e.name as table_name, r.name as role_name,
  has_table_privilege(r.name, c.oid, 'SELECT') as can_select,
  has_table_privilege(r.name, c.oid, 'INSERT,UPDATE,DELETE') as can_write
from expected e cross join roles r
join pg_catalog.pg_class c on c.oid = to_regclass('public.' || e.name)
order by e.name, r.name;

-- 3. Policies: only an owner SELECT policy on planner_accounts is expected.
-- Inspect qual: user_id must equal auth.uid(); no USING(true) or write policies.
select tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 4. Every public function: security definers need an empty search_path; no
-- PUBLIC execute; authenticated may execute ONLY planner_list and planner_call;
-- anon ONLY log_client_error. The rest are for the reminder functions
-- (service_role).
select p.oid::regprocedure::text as function_name, p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by function_name;

-- 5. The day planner is retired (20261125000100_retire_day_planner.sql).
-- Expected: true for every column.
select
  to_regclass('public.planner_tasks') is null as planner_tasks_removed,
  to_regclass('public.planner_reviews') is null as reviews_removed,
  to_regclass('public.ai_review_requests') is null as ai_requests_removed,
  to_regclass('public.planner_history') is null as history_removed,
  to_regprocedure('public.planner_execute(text,jsonb,text)') is null as executor_removed,
  to_regprocedure('public.planner_schedule(text,jsonb,text)') is null as scheduling_removed,
  coalesce(pg_get_functiondef(to_regprocedure('public.planner_call(text,jsonb,text)'))
    like '%Unsupported action.%', false) as planner_call_slimmed;

-- 6. Scheduled jobs: one hourly reminder job and nothing else of prune's.
-- select jobname, schedule, active from cron.job order by jobname;
-- Expected: prune-email-reminders, '5 * * * *', active. No pro-ai-retention.
