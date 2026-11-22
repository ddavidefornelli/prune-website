-- Apply after 20261123000100_drop_mac_only_tables.sql, before deploying the
-- website that shows the task list. Additive: the day-based planner tables and
-- functions stay as they are.
--
-- prune is one plain list (2026-11-22): a task has a title and is done or not.
-- No days, slots, estimates or timers. The browser keeps the list on the device
-- and calls planner_list('sync') to send what changed and read the whole list
-- back. Each task carries the client's last-edit time and the newest edit wins,
-- so a retried or repeated sync is harmless.
--
-- The first sync of an account copies its unfinished planner tasks for today
-- and later into the list, once, so nobody loses what they had planned.
-- Rows go with the account (auth.users cascade), like every planner table.
--
-- Guests: there is no sign-up any more. Each browser gets a Supabase anonymous
-- user (a guest id, no email) after its first task, and the list syncs under
-- it. Guests get no reminder emails, so nothing is recorded for them in
-- planner_email_reminders. planner_list('erase') deletes the caller's whole
-- list, for "Delete everything".
--
-- Accounts from before keep working in browsers where they are still signed
-- in. Signing in again cancels a deletion: deleting an account (planner_call
-- 'delete_account') still marks it, and the operator still removes marked
-- accounts after 30 days, but a session that signed in after the deletion
-- restores the account instead of locking the address out. Sessions from
-- before it are still refused, so a forgotten open tab cannot undo a deletion.
begin;

create table public.planner_list_tasks (
  user_id uuid not null references auth.users on delete cascade,
  id uuid not null,
  title text not null check (char_length(title) between 1 and 500),
  done boolean not null default false,
  created_at timestamptz not null,
  -- The client's clock at the last edit, capped at the server's: newest wins.
  updated_at timestamptz not null,
  done_at timestamptz,
  check (done = (done_at is not null)),
  primary key (user_id, id)
);
alter table public.planner_list_tasks enable row level security;
revoke all on public.planner_list_tasks from public, anon, authenticated;
grant all on public.planner_list_tasks to service_role;

alter table public.planner_accounts add column if not exists list_started_at timestamptz;
comment on column public.planner_accounts.list_started_at is
  'First task-list sync; the account''s unfinished planner tasks were copied into the list then.';

create or replace function public.planner_list(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  a public.planner_accounts%rowtype;
  r public.planner_email_reminders%rowtype;
  known text := (select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone);
  zone text;
  -- Client clocks may run ahead; nothing may claim to be newer than this.
  latest numeric := floor(extract(epoch from now()) * 1000) + 60000;
  saves jsonb := coalesce(p_args->'save', '[]'::jsonb);
  removes jsonb := coalesce(p_args->'remove', '[]'::jsonb);
  item jsonb;
  item_id uuid;
  created numeric;
  updated numeric;
  finished numeric;
  total integer;
  rejected jsonb := '[]'::jsonb;
  signed_in numeric;
  guest boolean := coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
begin
  if u is null then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is null or p_action not in ('sync', 'status', 'erase') then
    raise exception using errcode = 'PT400', message = 'Unsupported list action.';
  end if;
  if jsonb_typeof(p_args) is distinct from 'object'
    or jsonb_typeof(saves) is distinct from 'array'
    or jsonb_typeof(removes) is distinct from 'array' then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;
  if jsonb_array_length(saves) > 200 or jsonb_array_length(removes) > 1000
    or exists (select 1 from jsonb_array_elements(removes) e
      where jsonb_typeof(e) <> 'string'
        or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;

  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serialize with deletion and with other devices' syncs.
  select * into a from public.planner_accounts where user_id = u for update;
  if a."isDeleted" then
    -- When this session signed in: the authentication times Supabase puts in
    -- every token of a session (refreshing keeps them), else when it was issued.
    signed_in := coalesce(
      (select max((m->>'timestamp')::numeric)
        from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array'
          then auth.jwt()->'amr' else '[]'::jsonb end) m
        where jsonb_typeof(m->'timestamp') = 'number'),
      case when jsonb_typeof(auth.jwt()->'iat') = 'number' then (auth.jwt()->>'iat')::numeric end);
    if a.deleted_at is not null and signed_in > extract(epoch from a.deleted_at) then
      update public.planner_accounts set "isDeleted" = false, deleted_at = null where user_id = u;
    else
      raise exception using errcode = 'PT403', message = 'This account was deleted.';
    end if;
  end if;

  if p_action = 'erase' then
    delete from public.planner_list_tasks t where t.user_id = u;
    return jsonb_build_object('tasks', '[]'::jsonb, 'rejected', '[]'::jsonb);
  end if;

  -- Remember the caller's time zone and that they were here, for reminder
  -- emails, exactly as planner_call does: at most one write an hour. Guests
  -- have no email, so nothing is recorded for them.
  select * into r from public.planner_email_reminders where user_id = u;
  if not guest and (not found or r.timezone is distinct from p_timezone or r.last_seen_at < now() - interval '1 hour') then
    insert into public.planner_email_reminders as e (user_id, timezone)
      values (u, coalesce(known, 'UTC'))
      on conflict (user_id) do update set
        -- An unknown zone never replaces a known one.
        timezone = coalesce(known, e.timezone),
        last_seen_at = now(),
        comebacks_sent = 0;
  end if;
  zone := coalesce(known, r.timezone, 'UTC');
  if p_action = 'status' then
    return jsonb_build_object('isDeleted', false);
  end if;

  -- Once per account: bring over what the day planner still had open.
  if a.list_started_at is null then
    begin
      insert into public.planner_list_tasks(user_id, id, title, done, created_at, updated_at)
        select t.user_id, t.id, left(btrim(t.outcome), 500), false,
          coalesce(to_timestamp(nullif(t.created_at, 0)), now()), now()
        from public.planner_tasks t
        where t.user_id = u and t.status <> 'completed'
          and t.planned_for >= (now() at time zone zone)::date
          and btrim(coalesce(t.outcome, '')) <> ''
        on conflict do nothing;
      update public.planner_accounts set list_started_at = now() where user_id = u;
    exception when others then
      -- Never let the one-time copy block the list; it is tried again next sync.
      raise warning 'planner_list: planner tasks not copied (%)', sqlerrm;
    end;
  end if;

  delete from public.planner_list_tasks t
    where t.user_id = u and t.id in (select (e #>> '{}')::uuid from jsonb_array_elements(removes) e);

  select count(*) into total from public.planner_list_tasks where user_id = u;
  for item in select value from jsonb_array_elements(saves) loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'title') is distinct from 'string'
      or char_length(btrim(item->>'title')) not between 1 and 500
      or jsonb_typeof(item->'done') is distinct from 'boolean'
      or jsonb_typeof(item->'createdAt') is distinct from 'number'
      or jsonb_typeof(item->'updatedAt') is distinct from 'number'
      or coalesce(jsonb_typeof(item->'doneAt'), 'null') not in ('number', 'null') then
      raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
    end if;
    item_id := (item->>'id')::uuid;
    created := least(greatest((item->>'createdAt')::numeric, 0), latest);
    updated := least(greatest((item->>'updatedAt')::numeric, 0), latest);
    finished := least(greatest(coalesce((item->>'doneAt')::numeric, updated), 0), latest);

    -- At most 1000 tasks: the oldest done task makes room for a new one.
    if not exists (select 1 from public.planner_list_tasks t where t.user_id = u and t.id = item_id) then
      if total >= 1000 then
        delete from public.planner_list_tasks t
          where t.user_id = u and t.id = (select o.id from public.planner_list_tasks o
            where o.user_id = u and o.done order by o.done_at, o.created_at limit 1);
        if not found then
          rejected := rejected || to_jsonb(item->>'id');
          continue;
        end if;
        total := total - 1;
      end if;
      total := total + 1;
    end if;

    insert into public.planner_list_tasks as t (user_id, id, title, done, created_at, updated_at, done_at)
      values (u, item_id, btrim(item->>'title'), (item->>'done')::boolean,
        to_timestamp(created / 1000), to_timestamp(updated / 1000),
        case when (item->>'done')::boolean then to_timestamp(finished / 1000) end)
      on conflict (user_id, id) do update set
        title = excluded.title,
        done = excluded.done,
        updated_at = excluded.updated_at,
        done_at = excluded.done_at
      where t.updated_at <= excluded.updated_at;
  end loop;

  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'done', t.done,
        'createdAt', floor(extract(epoch from t.created_at) * 1000)::bigint,
        'updatedAt', floor(extract(epoch from t.updated_at) * 1000)::bigint,
        'doneAt', floor(extract(epoch from t.done_at) * 1000)::bigint
      ) order by t.created_at desc, t.id)
      from public.planner_list_tasks t where t.user_id = u), '[]'::jsonb),
    'rejected', rejected);
end
$$;
revoke all on function public.planner_list(text, jsonb, text) from public, anon;
grant execute on function public.planner_list(text, jsonb, text) to authenticated;

commit;
