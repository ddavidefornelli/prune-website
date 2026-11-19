-- The Mac app is retired. Two tables only it used go:
--   planner_resources   links/files attached to tasks (no web UI ever wrote them)
--   ai_review_previews  quotas/leases for the Mac's manual "preview this week"
-- Their rows are deleted with them. Back up first if you want to keep any.
--
-- What changes alongside:
--   * planner_task_json keeps its shape: "resources" is always [] (the web client
--     and saved browser snapshots expect the array).
--   * planner_execute: the resource commands become no-ops, so an old command
--     still sitting in someone's offline queue replays without an error.
--   * The four preview functions are dropped; the weekly-review Edge Function no
--     longer accepts a preview flag.
-- The migration stops, changing nothing, if the live database has anything else
-- that still reads either table.
begin;

-- 1. planner_task_json: return an empty resources list.
do $$
declare
  definition text;
  head constant text := 'coalesce((select jsonb_agg(jsonb_build_object(''id'', r.id';
  tail constant text := 'r.user_id = p_task.user_id), ''[]''::jsonb)';
  i int;
  j int;
begin
  definition := pg_get_functiondef('public.planner_task_json(public.planner_tasks)'::regprocedure);
  i := strpos(definition, head);
  j := strpos(definition, tail);
  if i = 0 or j < i then
    raise exception 'planner_task_json changed; review this migration before applying.';
  end if;
  definition := left(definition, i - 1) || '''[]''::jsonb' || substr(definition, j + length(tail));
  execute definition;
end;
$$;

-- 2. planner_execute: resource commands do nothing.
do $$
declare
  definition text;
  head constant text := 'elsif p_action in (''add_task_link'', ''attach_task_file'') then';
  tail constant text := 'else' || chr(10) || '    raise exception using errcode = ''PT400'', message = ''Unsupported planner command.'';';
  i int;
  j int;
begin
  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  i := strpos(definition, head);
  j := i + strpos(substr(definition, i + 1), tail);
  if i = 0 or j = i then
    raise exception 'planner_execute changed; review this migration before applying.';
  end if;
  definition := left(definition, i - 1)
    || 'elsif p_action in (''add_task_link'', ''attach_task_file'', ''remove_task_resource'') then' || chr(10)
    || '    null; -- Task resources were retired with the Mac app.' || chr(10)
    || '  elsif p_action = ''get_task_resource'' then' || chr(10)
    || '    return null;' || chr(10)
    || '  ' || substr(definition, j);
  execute definition;
end;
$$;

-- 3. The Mac preview functions.
drop function if exists public.planner_preview_input(uuid, text);
drop function if exists public.reserve_review_preview(uuid);
drop function if exists public.finish_review_preview(uuid, uuid);
drop function if exists public.fail_review_preview(uuid, uuid);

-- 4. Refuse to continue if anything else still uses the tables. Function bodies
-- are not tracked as dependencies, so a plain DROP would succeed and the caller
-- would only fail later, at run time.
do $$
declare
  users text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into users
    from pg_catalog.pg_proc p
    where p.prosrc ~ '\m(planner_resources|ai_review_previews)\M';
  if users is not null then
    raise exception 'Still used by: %. Review this migration before applying.', users;
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select string_agg(jobname, ', ') from cron.job
      where command ~ '\m(planner_resources|ai_review_previews)\M'$q$ into users;
    if users is not null then
      raise exception 'Still used by cron jobs: %. Review this migration before applying.', users;
    end if;
  end if;
  raise notice 'Dropping % task resources and % preview rows.',
    (select count(*) from public.planner_resources), (select count(*) from public.ai_review_previews);
end;
$$;

-- 5. No CASCADE: a view or foreign key we haven't seen makes this fail instead.
drop table public.planner_resources;
drop table public.ai_review_previews;

commit;
