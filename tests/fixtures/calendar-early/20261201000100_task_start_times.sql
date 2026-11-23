-- Task start times for the calendar (2026-11-23). A task can be planned for
-- an hour: planner_list_tasks.start_at, sent and returned as startAt (epoch
-- milliseconds, or null). A save without startAt (a website from before the
-- calendar) leaves the start as it is, so an older tab never wipes a plan.
-- Everything else is as in 20261128000200_create_spaces.sql.
--
-- Apply after 20261130000100_daily_push.sql, before deploying the website
-- with the calendar.
begin;

alter table public.planner_list_tasks add column start_at timestamptz;

create or replace function public.planner_list(p_action text, p_args jsonb default '{}'::jsonb, p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  s uuid;
  sp public.planner_spaces%rowtype;
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
  starts numeric;
  -- Saves that leave the start as it is: from a website without the calendar.
  keep_start boolean;
  total integer;
  rejected jsonb := '[]'::jsonb;
  signed_in numeric;
  guest boolean := coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
  space_name text;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if u is null then
    raise exception using errcode = 'PT401', message = 'Open prune again to continue.';
  end if;
  if p_action is null or p_action not in ('sync', 'erase', 'share', 'join', 'create', 'people', 'rename', 'leave') then
    raise exception using errcode = 'PT400', message = 'Unsupported list action.';
  end if;
  if jsonb_typeof(p_args) is distinct from 'object'
    or jsonb_typeof(saves) is distinct from 'array'
    or jsonb_typeof(removes) is distinct from 'array'
    or coalesce(jsonb_typeof(p_args->'space'), 'null') not in ('string', 'null')
    or (jsonb_typeof(p_args->'space') = 'string' and (p_args->>'space') !~* uuid_pattern) then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;
  if jsonb_array_length(saves) > 200 or jsonb_array_length(removes) > 1000
    or exists (select 1 from jsonb_array_elements(removes) e
      where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* uuid_pattern) then
    raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
  end if;
  if guest and p_action in ('share', 'join', 'create') then
    raise exception using errcode = 'PT400', message = 'Sign in to share a list.';
  end if;

  insert into public.planner_accounts(user_id) values (u) on conflict do nothing;
  -- Serialize with deletion and with this account's other syncs.
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
    -- Spaces the caller owns go, with their tasks, for everyone in them.
    delete from public.planner_spaces where owner_id = u;
    delete from public.planner_space_members where user_id = u;
    return jsonb_build_object('tasks', '[]'::jsonb, 'rejected', '[]'::jsonb);
  end if;

  -- Everyone has a Personal space.
  insert into public.planner_spaces (id, owner_id, kind) values (u, u, 'personal') on conflict do nothing;
  insert into public.planner_space_members (space_id, user_id) values (u, u) on conflict do nothing;

  if p_action = 'create' then
    space_name := left(btrim(coalesce(p_args->>'name', '')), 60);
    if (select count(*) from public.planner_spaces x where x.owner_id = u and x.kind = 'group') >= 50 then
      raise exception using errcode = 'PT409', message = 'You own 50 shared spaces. Delete one to make another.';
    end if;
    insert into public.planner_spaces (owner_id, kind, name, share_token)
      values (u, 'group', coalesce(nullif(space_name, ''), 'Shared list'), replace(gen_random_uuid()::text, '-', ''))
      returning * into sp;
    insert into public.planner_space_members (space_id, user_id) values (sp.id, u);
    return jsonb_build_object('space', sp.id, 'token', sp.share_token);
  end if;

  if p_action = 'join' then
    if jsonb_typeof(p_args->'token') is distinct from 'string' then
      raise exception using errcode = 'PT404', message = 'This link doesn''t work any more. Ask for a new one.';
    end if;
    select * into sp from public.planner_spaces x where x.share_token = lower(p_args->>'token');
    if not found then
      raise exception using errcode = 'PT404', message = 'This link doesn''t work any more. Ask for a new one.';
    end if;
    if (select count(*) from public.planner_space_members m where m.user_id = u) >= 100 then
      raise exception using errcode = 'PT409', message = 'You''re in 100 spaces. Leave one to join another.';
    end if;
    insert into public.planner_space_members (space_id, user_id) values (sp.id, u) on conflict do nothing;
    return jsonb_build_object('space', sp.id);
  end if;

  -- The space this call is about: the one asked for, or Personal.
  s := coalesce((p_args->>'space')::uuid, u);
  if not exists (select 1 from public.planner_space_members m where m.space_id = s and m.user_id = u) then
    raise exception using errcode = 'PT404', message = 'This space isn''t available any more.';
  end if;
  -- Serialize with everyone else's writes to the same space.
  select * into sp from public.planner_spaces x where x.id = s for update;

  if p_action = 'share' then
    space_name := left(btrim(coalesce(p_args->>'name', '')), 60);
    if sp.kind = 'personal' then
      if (select count(*) from public.planner_spaces x where x.owner_id = u and x.kind = 'group') >= 50 then
        raise exception using errcode = 'PT409', message = 'You own 50 shared spaces. Delete one to share another.';
      end if;
      insert into public.planner_spaces (owner_id, kind, name, share_token)
        values (u, 'group', coalesce(nullif(space_name, ''), 'Shared list'), replace(gen_random_uuid()::text, '-', ''))
        returning * into sp;
      insert into public.planner_space_members (space_id, user_id) values (sp.id, u);
      -- What was in Personal is now the group's; Personal starts empty.
      update public.planner_list_tasks t set space_id = sp.id where t.space_id = s;
    elsif sp.share_token is null then
      update public.planner_spaces x set share_token = replace(gen_random_uuid()::text, '-', '')
        where x.id = s returning * into sp;
    end if;
    return jsonb_build_object('space', sp.id, 'token', sp.share_token);
  end if;

  if p_action = 'people' then
    return jsonb_build_object('people', coalesce((select jsonb_agg(jsonb_build_object(
        'name', nullif(btrim(coalesce(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', '')), ''),
        'email', nullif(au.email, ''),
        'owner', m.user_id = sp.owner_id,
        'you', m.user_id = u
      ) order by m.user_id = sp.owner_id desc, m.joined_at, m.user_id)
      from public.planner_space_members m
      join auth.users au on au.id = m.user_id
      where m.space_id = s), '[]'::jsonb));
  end if;

  if p_action = 'rename' then
    space_name := btrim(coalesce(p_args->>'name', ''));
    if sp.kind <> 'group' or char_length(space_name) not between 1 and 60 then
      raise exception using errcode = 'PT400', message = 'Give the space a name of up to 60 characters.';
    end if;
    update public.planner_spaces x set name = space_name where x.id = s;
    return jsonb_build_object('space', s, 'name', space_name);
  end if;

  if p_action = 'leave' then
    if sp.kind = 'personal' then
      raise exception using errcode = 'PT400', message = 'Your personal space stays.';
    end if;
    if sp.owner_id = u then
      delete from public.planner_spaces x where x.id = s;
    else
      delete from public.planner_space_members m where m.space_id = s and m.user_id = u;
    end if;
    return jsonb_build_object('left', true);
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
    where t.space_id = s and t.id in (select (e #>> '{}')::uuid from jsonb_array_elements(removes) e);

  select count(*) into total from public.planner_list_tasks where space_id = s;
  for item in select value from jsonb_array_elements(saves) loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'id') is distinct from 'string'
      or (item->>'id') !~* uuid_pattern
      or jsonb_typeof(item->'title') is distinct from 'string'
      or char_length(btrim(item->>'title')) not between 1 and 500
      or jsonb_typeof(item->'done') is distinct from 'boolean'
      or jsonb_typeof(item->'createdAt') is distinct from 'number'
      or jsonb_typeof(item->'updatedAt') is distinct from 'number'
      or coalesce(jsonb_typeof(item->'doneAt'), 'null') not in ('number', 'null')
      or coalesce(jsonb_typeof(item->'startAt'), 'null') not in ('number', 'null') then
      raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
    end if;
    item_id := (item->>'id')::uuid;
    created := least(greatest((item->>'createdAt')::numeric, 0), latest);
    updated := least(greatest((item->>'updatedAt')::numeric, 0), latest);
    finished := least(greatest(coalesce((item->>'doneAt')::numeric, updated), 0), latest);
    keep_start := not (item ? 'startAt');
    -- Any time from 1970 to 2200: a calendar plans ahead, not only up to now.
    starts := case when jsonb_typeof(item->'startAt') = 'number'
      then least(greatest((item->>'startAt')::numeric, 0), 7258118400000) end;

    -- At most 1000 tasks a space: the oldest done task makes room for a new one.
    if not exists (select 1 from public.planner_list_tasks t where t.space_id = s and t.id = item_id) then
      if total >= 1000 then
        delete from public.planner_list_tasks t
          where t.space_id = s and t.id = (select o.id from public.planner_list_tasks o
            where o.space_id = s and o.done order by o.done_at, o.created_at limit 1);
        if not found then
          rejected := rejected || to_jsonb(item->>'id');
          continue;
        end if;
        total := total - 1;
      end if;
      total := total + 1;
    end if;

    insert into public.planner_list_tasks as t (space_id, id, title, done, created_at, updated_at, done_at, start_at)
      values (s, item_id, btrim(item->>'title'), (item->>'done')::boolean,
        to_timestamp(created / 1000), to_timestamp(updated / 1000),
        case when (item->>'done')::boolean then to_timestamp(finished / 1000) end,
        case when starts is not null then to_timestamp(starts / 1000) end)
      on conflict (space_id, id) do update set
        title = excluded.title,
        done = excluded.done,
        updated_at = excluded.updated_at,
        done_at = excluded.done_at,
        start_at = case when keep_start then t.start_at else excluded.start_at end
      where t.updated_at <= excluded.updated_at;
  end loop;

  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'done', t.done,
        'createdAt', floor(extract(epoch from t.created_at) * 1000)::bigint,
        'updatedAt', floor(extract(epoch from t.updated_at) * 1000)::bigint,
        'doneAt', floor(extract(epoch from t.done_at) * 1000)::bigint,
        'startAt', floor(extract(epoch from t.start_at) * 1000)::bigint
      ) order by t.created_at desc, t.id)
      from public.planner_list_tasks t where t.space_id = s), '[]'::jsonb),
    'rejected', rejected,
    -- Every space the caller is in: Personal first, then the oldest first.
    'spaces', (select jsonb_agg(jsonb_build_object(
        'id', x.id,
        'kind', x.kind,
        'name', x.name,
        'people', (select count(*) from public.planner_space_members p where p.space_id = x.id),
        'owner', x.owner_id = u
      ) order by x.kind = 'personal' desc, x.created_at, x.id)
      from public.planner_spaces x
      join public.planner_space_members m on m.space_id = x.id and m.user_id = u));
end
$$;
revoke all on function public.planner_list(text, jsonb, text) from public, anon;
grant execute on function public.planner_list(text, jsonb, text) to authenticated;

commit;
