-- Shared lists (2026-11-22): sign in, copy the link, send it. Whoever opens
-- the link and signs in edits the same list.
--
-- A list still belongs to one account (planner_list_tasks.user_id: its
-- owner). Sharing gives it one secret link (planner_list_shares); joining
-- through that link makes the caller a member (planner_list_members), and
-- from then on every planner_list call of theirs reads and writes the owner's
-- list instead of their own. A member's own tasks move into the shared list
-- when they join, so nothing they had is lost. An account belongs to one list
-- at a time.
--
-- New planner_list actions (signed-in accounts only, never guests):
--   'share'  the list's link token: the owner's, made on first use; a member
--            gets the owner's.
--   'join'   {token}: become a member of that list.
--   'leave'  a member leaves (their own list is empty again); the owner stops
--            sharing: every member leaves and the old link stops working.
-- 'sync' also returns `shared`: null, or {role: 'owner'|'member', people}.
-- 'erase' by a member only leaves; by an owner it also stops sharing.
--
-- Apply after 20261126000100_task_helper.sql, before deploying the website
-- that shows Share. Additive: an older website ignores `shared`.
begin;

create table public.planner_list_shares (
  owner_id uuid primary key references auth.users on delete cascade,
  -- 32 hex characters (122 random bits): the link's secret.
  token text not null unique check (token ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now()
);
alter table public.planner_list_shares enable row level security;
revoke all on public.planner_list_shares from public, anon, authenticated;
grant all on public.planner_list_shares to service_role;

create table public.planner_list_members (
  member_id uuid primary key references auth.users on delete cascade,
  owner_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  check (member_id <> owner_id)
);
create index planner_list_members_owner on public.planner_list_members (owner_id);
alter table public.planner_list_members enable row level security;
revoke all on public.planner_list_members from public, anon, authenticated;
grant all on public.planner_list_members to service_role;

create or replace function public.planner_list(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  -- Whose list the caller reads and writes: their own, or the one they joined.
  l uuid;
  a public.planner_accounts%rowtype;
  r public.planner_email_reminders%rowtype;
  known text := (select z.name from pg_catalog.pg_timezone_names z where z.name = p_timezone);
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
  share_token text;
  target uuid;
  people integer;
begin
  if u is null then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is null or p_action not in ('sync', 'erase', 'share', 'join', 'leave') then
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
  if guest and p_action in ('share', 'join') then
    raise exception using errcode = 'PT400', message = 'Sign in to share a list.';
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

  if p_action = 'join' then
    if jsonb_typeof(p_args->'token') is distinct from 'string' then
      raise exception using errcode = 'PT404', message = 'This link doesn''t work any more. Ask for a new one.';
    end if;
    select s.owner_id into target from public.planner_list_shares s where s.token = lower(p_args->>'token');
    if target is null then
      raise exception using errcode = 'PT404', message = 'This link doesn''t work any more. Ask for a new one.';
    end if;
    -- The caller's own link, or a list they already joined: nothing to do.
    if target = u or exists (select 1 from public.planner_list_members m where m.member_id = u and m.owner_id = target) then
      return jsonb_build_object('joined', true);
    end if;
    if exists (select 1 from public.planner_list_members m where m.owner_id = u) then
      raise exception using errcode = 'PT409', message = 'Your list is shared. Stop sharing it before joining another.';
    end if;
    -- The owner's syncs lock the owner's account row: take it too, after the caller's.
    perform 1 from public.planner_accounts where user_id = target for update;
    -- Bring the caller's own tasks along, as many as the shared list has room
    -- for (open ones first). Moved, not copied, so their answers stay theirs.
    select count(*) into total from public.planner_list_tasks where user_id = target;
    update public.planner_list_tasks t set user_id = target
      where t.user_id = u and t.id in (select o.id from public.planner_list_tasks o
        where o.user_id = u
          and not exists (select 1 from public.planner_list_tasks x where x.user_id = target and x.id = o.id)
        order by o.done, o.created_at desc
        limit greatest(1000 - total, 0));
    delete from public.planner_list_tasks t where t.user_id = u;
    insert into public.planner_list_members as m (member_id, owner_id) values (u, target)
      on conflict (member_id) do update set owner_id = excluded.owner_id, joined_at = now();
    return jsonb_build_object('joined', true);
  end if;

  l := coalesce((select m.owner_id from public.planner_list_members m where m.member_id = u), u);
  if l <> u then
    perform 1 from public.planner_accounts where user_id = l for update;
  end if;

  if p_action = 'share' then
    select s.token into share_token from public.planner_list_shares s where s.owner_id = l;
    if share_token is null then
      insert into public.planner_list_shares (owner_id, token)
        values (l, replace(gen_random_uuid()::text, '-', ''))
        returning token into share_token;
    end if;
    return jsonb_build_object('token', share_token);
  end if;

  if p_action = 'leave' or p_action = 'erase' then
    if l <> u then
      -- A member leaves; the shared list stays with its owner.
      delete from public.planner_list_members m where m.member_id = u;
      if p_action = 'leave' then
        return jsonb_build_object('left', true);
      end if;
      l := u;
    else
      -- The owner stops sharing: members leave and the old link stops working.
      delete from public.planner_list_members m where m.owner_id = u;
      delete from public.planner_list_shares s where s.owner_id = u;
      if p_action = 'leave' then
        return jsonb_build_object('left', true);
      end if;
    end if;
    delete from public.planner_list_tasks t where t.user_id = u;
    return jsonb_build_object('tasks', '[]'::jsonb, 'rejected', '[]'::jsonb);
  end if;

  -- Remember the caller's time zone and that they were here, for the
  -- come-back email: at most one write an hour. Guests have no email, so
  -- nothing is recorded for them.
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

  delete from public.planner_list_tasks t
    where t.user_id = l and t.id in (select (e #>> '{}')::uuid from jsonb_array_elements(removes) e);

  select count(*) into total from public.planner_list_tasks where user_id = l;
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
    if not exists (select 1 from public.planner_list_tasks t where t.user_id = l and t.id = item_id) then
      if total >= 1000 then
        delete from public.planner_list_tasks t
          where t.user_id = l and t.id = (select o.id from public.planner_list_tasks o
            where o.user_id = l and o.done order by o.done_at, o.created_at limit 1);
        if not found then
          rejected := rejected || to_jsonb(item->>'id');
          continue;
        end if;
        total := total - 1;
      end if;
      total := total + 1;
    end if;

    insert into public.planner_list_tasks as t (user_id, id, title, done, created_at, updated_at, done_at)
      values (l, item_id, btrim(item->>'title'), (item->>'done')::boolean,
        to_timestamp(created / 1000), to_timestamp(updated / 1000),
        case when (item->>'done')::boolean then to_timestamp(finished / 1000) end)
      on conflict (user_id, id) do update set
        title = excluded.title,
        done = excluded.done,
        updated_at = excluded.updated_at,
        done_at = excluded.done_at
      where t.updated_at <= excluded.updated_at;
  end loop;

  select count(*) into people from public.planner_list_members m where m.owner_id = l;

  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'done', t.done,
        'createdAt', floor(extract(epoch from t.created_at) * 1000)::bigint,
        'updatedAt', floor(extract(epoch from t.updated_at) * 1000)::bigint,
        'doneAt', floor(extract(epoch from t.done_at) * 1000)::bigint
      ) order by t.created_at desc, t.id)
      from public.planner_list_tasks t where t.user_id = l), '[]'::jsonb),
    'rejected', rejected,
    -- Who else edits this list: null while nobody joined it.
    'shared', case
      when l <> u then jsonb_build_object('role', 'member', 'people', people + 1)
      when people > 0 then jsonb_build_object('role', 'owner', 'people', people + 1)
    end);
end
$$;
revoke all on function public.planner_list(text, jsonb, text) from public, anon;
grant execute on function public.planner_list(text, jsonb, text) to authenticated;

-- A deleted shared task takes every member's "Do it for me" answer for it too.
create or replace function public.planner_helper_forget_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.planner_helper_runs r
    where r.task_id = old.id
      and (r.user_id = old.user_id
        or r.user_id in (select m.member_id from public.planner_list_members m where m.owner_id = old.user_id));
  return old;
end;
$$;
revoke all on function public.planner_helper_forget_task() from public, anon, authenticated;

commit;
