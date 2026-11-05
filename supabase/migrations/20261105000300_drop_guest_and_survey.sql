-- Remove guest planning, the onboarding survey and their anonymous counters.
-- The website now requires Google sign-in before the planner, so nothing
-- calls these any more. Apply after 20261105000200_drop_clerk_bridge.sql and
-- after deploying the client that no longer sends guest imports or counters.
--
-- This permanently deletes:
-- - planner_guest_imports: receipts of past guest imports. The imported
--   tasks themselves live in the planner tables and are not touched.
-- - planner_onboarding: survey answers and week outcomes.
-- - guest_usage_daily: the anonymous daily totals and the survey funnel.
-- Export anything you want to keep before applying it.
--
-- A weekly-review deployment that still passes loadWeekGoal keeps working:
-- the failed planner_week_goal lookup reviews the week without a goal.
begin;
drop function if exists public.guest_record_usage(jsonb);
drop table if exists public.guest_usage_daily;
drop function if exists public.planner_import_guest(jsonb);
drop table if exists public.planner_guest_imports;
drop function if exists public.planner_week_goal(uuid, date);
drop table if exists public.planner_onboarding;
commit;
