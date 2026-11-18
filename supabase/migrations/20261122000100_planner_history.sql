-- Apply after 20261121000100_focus_time.sql. Keep it in the shared backend's
-- deployment history too: it adds triggers to planner_tasks and planner_stops,
-- which the Mac app writes as well.
--
-- A per-account history of every stage someone goes through, so problems can
-- be found by reading what actually happened, in order:
--   * kind 'task': every insert, change and delete of a task, written by a
--     trigger, whichever client made it. `detail` holds the changed columns as
--     [before, after]; the title is never copied, only marked as changed.
--   * kind 'stop': each recorded stop (the reason itself stays in planner_stops).
--   * kind 'journey': steps in the website that write nothing else, such as the
--     tour, the first-task and focus-time questions, or a change the server
--     rejected. Sent by the signed-in client through planner_track().
-- Rows go with the account (auth.users cascade) and are pruned after 180 days.
-- Only service_role can read the table: query it from the SQL editor, e.g.
--   select at, kind, event, task_id, detail from public.planner_history
--   where user_id = '...' order by id;
begin;

create table public.planner_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('task', 'stop', 'journey')),
  event text not null check (event ~ '^[a-z_]{1,40}$'),
  task_id uuid,
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048)
);
create index planner_history_user_at on public.planner_history (user_id, at);
create index planner_history_event_at on public.planner_history (event, at);
alter table public.planner_history enable row level security;
revoke all on public.planner_history from public, anon, authenticated;
grant all on public.planner_history to service_role;

-- The one writer. Skips users that no longer exist, so cascading an account
-- deletion through planner_tasks can never fail on this table's foreign key.
create function public.planner_history_add(p_user uuid, p_kind text, p_event text,
  p_task uuid, p_detail jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    return;
  end if;
  delete from public.planner_history h
    where h.user_id = p_user and h.at < now() - interval '180 days';
  insert into public.planner_history (user_id, kind, event, task_id, detail)
    values (p_user, p_kind, p_event, p_task, coalesce(p_detail, '{}'::jsonb));
end;
$$;
revoke all on function public.planner_history_add(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- Reads columns through jsonb so a column added later by either client is
-- recorded too, without redefining this trigger.
create function public.planner_history_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Bookkeeping columns change on every write and say nothing on their own.
  quiet constant text[] := array['outcome', 'updated_at', 'revision', 'last_event_at'];
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  rec jsonb := coalesce(n, o);
  changes jsonb := '{}'::jsonb;
  k text;
  ev text;
begin
  if tg_op = 'UPDATE' then
    for k in select key from jsonb_each(n) where key <> all (quiet) loop
      if n->k is distinct from o->k then
        changes := changes || jsonb_build_object(k, jsonb_build_array(o->k, n->k));
      end if;
    end loop;
    if n->'outcome' is distinct from o->'outcome' then
      changes := changes || '{"outcome": "changed"}'::jsonb;
    end if;
    if changes = '{}'::jsonb then
      return null;
    end if;
    ev := case
      when n->>'status' = 'active' and o->>'status' is distinct from 'active' then 'task_started'
      when n->>'status' = 'completed' and o->>'status' is distinct from 'completed' then 'task_completed'
      when o->>'status' = 'completed' then 'task_reopened'
      when o->>'status' = 'active' then 'task_stopped'
      when changes ? 'planned_for' then 'task_moved'
      when changes ? 'estimated_minutes' then 'estimate_changed'
      when changes ? 'outcome' then 'task_renamed'
      else 'task_updated' end;
  elsif tg_op = 'INSERT' then
    ev := 'task_created';
    changes := (n - quiet) || '{"outcome": "set"}'::jsonb;
  else
    ev := 'task_deleted';
    changes := o - quiet;
  end if;
  -- id and user_id are columns of the row already.
  perform public.planner_history_add((rec->>'user_id')::uuid, 'task', ev,
    (rec->>'id')::uuid, changes - 'id' - 'user_id');
  return null;
end;
$$;
revoke all on function public.planner_history_task() from public, anon, authenticated;
create trigger planner_history_task after insert or update or delete on public.planner_tasks
  for each row execute function public.planner_history_task();

create function public.planner_history_stop() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := to_jsonb(new);
begin
  perform public.planner_history_add((n->>'user_id')::uuid, 'stop', 'stop_recorded',
    (n->>'task_id')::uuid,
    jsonb_strip_nulls(jsonb_build_object('stopped_on', n->'stopped_on',
      'has_reason', coalesce(length(n->>'reason'), 0) > 0)));
  return null;
end;
$$;
revoke all on function public.planner_history_stop() from public, anon, authenticated;
create trigger planner_history_stop after insert on public.planner_stops
  for each row execute function public.planner_history_stop();

-- Journey steps from the signed-in website. Events are an allowlist; detail is
-- at most six short codes (no free text), so nothing typed by the owner can be
-- sent here. Capped at 300 rows per account per day.
create function public.planner_track(p_event text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  item record;
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode = 'PT401', message = 'Sign in to use prune.';
  end if;
  -- Add new events here when you start sending them.
  if p_event is null or p_event not in (
      'planner_opened', 'tour_shown', 'tour_finished',
      'first_task_shown', 'first_task_added', 'first_task_later',
      'focus_time_shown', 'focus_time_saved', 'focus_time_closed',
      'change_rejected', 'error_shown')
    or p_detail is null or jsonb_typeof(p_detail) <> 'object'
    or (select count(*) from jsonb_object_keys(p_detail)) > 6 then
    raise exception using errcode = 'PT400', message = 'Invalid history event.';
  end if;
  for item in select key, value from jsonb_each(p_detail) loop
    if item.key !~ '^[a-z_]{1,32}$'
      or not (jsonb_typeof(item.value) in ('boolean', 'number')
        or (jsonb_typeof(item.value) = 'string' and item.value #>> '{}' ~ '^[a-z0-9_]{0,32}$')) then
      raise exception using errcode = 'PT400', message = 'Invalid history event.';
    end if;
  end loop;
  if not exists (select 1 from public.planner_accounts a where a.user_id = u and not a."isDeleted") then
    return;
  end if;
  if (select count(*) from public.planner_history h where h.user_id = u and h.kind = 'journey'
      and h.at >= now() - interval '1 day') >= 300 then
    return;
  end if;
  perform public.planner_history_add(u, 'journey', p_event, null, p_detail);
end;
$$;
revoke all on function public.planner_track(text, jsonb) from public, anon;
grant execute on function public.planner_track(text, jsonb) to authenticated;

commit;
