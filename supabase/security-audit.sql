-- READ ONLY. Run in the HOSTED project's SQL Editor as its administrator.
-- This does not apply migrations, reset/seed data, or retrieve planner content.
-- It complements, not replaces, two-account hosted isolation testing.

-- 1. Every expected table must exist with RLS enabled (all rows true/true).
with expected(name) as (values
  ('planner_accounts'), ('planner_tasks'), ('planner_resources'), ('planner_stops'),
  ('planner_reviews'), ('planner_receipts'), ('ai_controls'), ('ai_usage'),
  ('ai_review_requests'), ('ai_review_previews'), ('guest_usage_daily'),
  ('planner_onboarding')
)
select e.name, c.oid is not null as table_exists,
  coalesce(c.relrowsecurity, false) as rls_enabled
from expected e
left join pg_catalog.pg_class c on c.oid = to_regclass('public.' || e.name)
order by e.name;

-- 2. No anon or authenticated direct INSERT/UPDATE/DELETE privileges.
-- authenticated SELECT should be true only for the five owner-readable tables.
with expected(name) as (values
  ('planner_accounts'), ('planner_tasks'), ('planner_resources'), ('planner_stops'),
  ('planner_reviews'), ('planner_receipts'), ('ai_controls'), ('ai_usage'),
  ('ai_review_requests'), ('ai_review_previews'), ('guest_usage_daily'),
  ('planner_onboarding')
), roles(name) as (values ('anon'), ('authenticated'))
select e.name as table_name, r.name as role_name,
  has_table_privilege(r.name, c.oid, 'SELECT') as can_select,
  has_table_privilege(r.name, c.oid, 'INSERT,UPDATE,DELETE') as can_write
from expected e cross join roles r
join pg_catalog.pg_class c on c.oid = to_regclass('public.' || e.name)
order by e.name, r.name;

-- 3. Only owner SELECT policies should exist for these five planner tables.
-- Inspect qual: user_id must equal auth.uid(); no USING(true), public reads,
-- or permissive INSERT/UPDATE/DELETE/ALL policies. No policies on private AI/
-- receipt tables. This displays policy definitions, not user rows.
select tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public' and tablename in (
  'planner_accounts', 'planner_tasks', 'planner_resources', 'planner_stops',
  'planner_reviews', 'planner_receipts', 'ai_controls', 'ai_usage',
  'ai_review_requests', 'ai_review_previews'
)
order by tablename, policyname;

-- 4. All security-definer functions require an empty search_path.
-- No anon execute; authenticated execute ONLY on planner_call(text,jsonb,text).
-- PUBLIC execute must be false. All other listed functions are server-only.
-- planner_week_goal(uuid,date) is server-only: service_role, for the review loader.
select p.oid::regprocedure::text as function_name, p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (
  p.proname like 'planner\_%' escape '\' or
  p.proname in ('reserve_weekly_review', 'reserve_planner_review', 'finish_weekly_review',
    'fail_weekly_review', 'purge_weekly_review_content', 'reserve_review_preview',
    'finish_review_preview', 'fail_review_preview')
)
order by function_name;

-- 4b. guest_record_usage(jsonb) is the only anon-callable function.
-- Expected: security_definer=true, empty search_path, anon_execute=true,
-- authenticated_execute=false, public_execute=false.
select p.oid::regprocedure::text as function_name, p.prosecdef as security_definer,
  p.proconfig as function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'guest_record_usage';

-- 5. Queue protocol and latest UI rules must actually be deployed.
-- Expected: true/true. Missing functions return false rather than applying anything.
select
  coalesce(pg_get_functiondef(to_regprocedure('public.planner_call(text,jsonb,text)'))
    like '%queue_protocol%', false) as queue_protocol_installed,
  coalesce(pg_get_functiondef(to_regprocedure('public.planner_execute(text,jsonb,text)'))
    like '%''canPlanTomorrow'', true%', false) as immediate_tomorrow_installed;

-- 6. Never permit unlimited development AI on production.
-- Expected: development_unlimited=false, conservative bounded budgets.
-- If this query fails, migrations/configuration must be investigated; do not reset.
select enabled, development_unlimited, daily_attempt_limit, monthly_attempt_limit
from public.ai_controls where id;

-- 7. Optional additional checks, run separately when the schemas exist:
-- select version from supabase_migrations.schema_migrations order by version;
-- Expect all nine migrations from ../pro/supabase/migrations/, through 20261019000100.
-- select jobname, schedule, active from cron.job where jobname = 'pro-ai-retention';
-- If hosted AI is enabled, confirm a single active daily retention job and check
-- its successful execution in the dashboard. Do not schedule duplicate jobs.
