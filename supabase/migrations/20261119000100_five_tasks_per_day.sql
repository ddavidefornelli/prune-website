-- Five tasks a day. The website and its copy have offered five since the
-- equal-tasks change, but the shared backend still kept three slots per day:
-- a CHECK on planner_tasks.slot and the slot search in planner_execute. A
-- fourth task saved on the device and was then rejected on sync.
--
-- Only the slot range and its message change. Ownership, today/tomorrow
-- validation, the single active task rule, receipts and revision checks stay
-- as they are. Slot 1 still marks the legacy is_priority flag for Mac clients.
begin;

alter table public.planner_tasks drop constraint planner_tasks_slot_check;
alter table public.planner_tasks
  add constraint planner_tasks_slot_check check (slot >= 1 and slot <= 5);

do $$
declare
  definition text;
  old_search text := $old$generate_series(1, 3) s where not exists(select 1 from public.planner_tasks where user_id = u and planned_for = task_day and slot = s)$old$;
  new_search text := $new$generate_series(1, 5) s where not exists(select 1 from public.planner_tasks where user_id = u and planned_for = task_day and slot = s)$new$;
  old_message text := $old$'Plan no more than three important tasks per day.'$old$;
  new_message text := $new$'Plan at most five tasks a day.'$new$;
begin
  definition := pg_get_functiondef('public.planner_execute(text,jsonb,text)'::regprocedure);
  if position(old_search in definition) = 0 or position(old_message in definition) = 0 then
    raise exception 'Planner executor changed; review the five-tasks migration before applying.';
  end if;
  execute replace(replace(definition, old_search, new_search), old_message, new_message);
end;
$$;

commit;
