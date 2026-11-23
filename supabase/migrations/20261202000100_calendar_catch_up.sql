-- Calendar catch-up (2026-11-23). 20261201000100 and 20261201000200 changed
-- after an early version of each may already have been applied:
--   20261201000100 first stored only the start (start_at); the length
--     (minutes), the description (notes) and planner_list 'calendar' came later.
--   20261201000200 was first Google Calendar (planner_google_*, set aside
--     unshipped, never deployed), then became task-start alerts.
-- A database that ran the early versions never gets the later ones (their
-- version numbers are already recorded), so planned tasks lost their length on
-- every sync and start alerts had nothing to claim. This brings any database,
-- early or current, to the same state; on a current one it changes nothing.
--
-- Apply before deploying the website (and before the daily-reminders function
-- that sends start alerts).
begin;

-- 1. The calendar's columns.
alter table public.planner_list_tasks add column if not exists start_at timestamptz;
alter table public.planner_list_tasks add column if not exists minutes smallint not null default 60;
alter table public.planner_list_tasks add column if not exists notes text not null default '';
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint c
      where c.conrelid = 'public.planner_list_tasks'::regclass and c.contype = 'c'
        and pg_catalog.pg_get_constraintdef(c.oid) ~ 'minutes >= 15') then
    alter table public.planner_list_tasks
      add constraint planner_list_tasks_minutes_check check (minutes between 15 and 720);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
      where c.conrelid = 'public.planner_list_tasks'::regclass and c.contype = 'c'
        and pg_catalog.pg_get_constraintdef(c.oid) ~ 'char_length\(notes\)') then
    alter table public.planner_list_tasks
      add constraint planner_list_tasks_notes_check check (char_length(notes) <= 2000);
  end if;
end;
$$;

-- 2. planner_list as in 20261201000100 today: length, description, 'calendar'.
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
  keep_minutes boolean;
  keep_notes boolean;
  range_from timestamptz;
  range_to timestamptz;
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
  if p_action is null or p_action not in ('sync', 'erase', 'share', 'join', 'create', 'people', 'rename', 'leave', 'calendar') then
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

  if p_action = 'calendar' then
    if jsonb_typeof(p_args->'from') is distinct from 'number'
      or jsonb_typeof(p_args->'to') is distinct from 'number'
      or (p_args->>'to')::numeric <= (p_args->>'from')::numeric
      or (p_args->>'to')::numeric - (p_args->>'from')::numeric > 777600000
      or abs((p_args->>'from')::numeric) > 7258118400000 then
      raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
    end if;
    range_from := to_timestamp((p_args->>'from')::numeric / 1000);
    range_to := to_timestamp((p_args->>'to')::numeric / 1000);
    if sp.kind = 'personal' then
      return jsonb_build_object('busy', '[]'::jsonb, 'elsewhere', coalesce((select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'space', t.space_id,
          'spaceName', x.name,
          'title', t.title,
          'startAt', floor(extract(epoch from t.start_at) * 1000)::bigint,
          'minutes', t.minutes,
          'done', t.done,
          'notes', t.notes
        ) order by t.start_at, t.id)
        from public.planner_list_tasks t
        join public.planner_spaces x on x.id = t.space_id and x.kind = 'group'
        join public.planner_space_members m on m.space_id = t.space_id and m.user_id = u
        where t.start_at < range_to and t.start_at + make_interval(mins => t.minutes) > range_from), '[]'::jsonb));
    end if;
    return jsonb_build_object('elsewhere', '[]'::jsonb, 'busy', coalesce((
      with spans as (
        select distinct busy_task.start_at as span_from, busy_task.start_at + make_interval(mins => busy_task.minutes) as span_to
        from public.planner_space_members here
        join public.planner_space_members there on there.user_id = here.user_id and there.space_id <> s
        join public.planner_list_tasks busy_task on busy_task.space_id = there.space_id
        where here.space_id = s and not busy_task.done
          and busy_task.start_at < range_to and busy_task.start_at + make_interval(mins => busy_task.minutes) > range_from
      ), ordered as (
        select busy_span.span_from, busy_span.span_to,
          max(busy_span.span_to) over (order by busy_span.span_from, busy_span.span_to rows between unbounded preceding and 1 preceding) as reach
        from spans busy_span
      ), runs as (
        select busy_order.span_from, busy_order.span_to,
          count(*) filter (where busy_order.reach is null or busy_order.span_from > busy_order.reach) over (order by busy_order.span_from, busy_order.span_to) as run
        from ordered busy_order
      ), merged as (
        select min(busy_run.span_from) as span_from, max(busy_run.span_to) as span_to from runs busy_run group by busy_run.run
      )
      select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from merged.span_from) * 1000)::bigint,
          'end', floor(extract(epoch from merged.span_to) * 1000)::bigint
        ) order by merged.span_from)
      from merged), '[]'::jsonb));
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
      or coalesce(jsonb_typeof(item->'startAt'), 'null') not in ('number', 'null')
      or coalesce(jsonb_typeof(item->'notes'), 'string') <> 'string'
      or char_length(coalesce(item->>'notes', '')) > 2000
      or coalesce(jsonb_typeof(item->'minutes'), 'number') <> 'number'
      or (item ? 'minutes' and (item->>'minutes')::numeric not between 15 and 720) then
      raise exception using errcode = 'PT400', message = 'Some changes could not be read. Reload and try again.';
    end if;
    item_id := (item->>'id')::uuid;
    created := least(greatest((item->>'createdAt')::numeric, 0), latest);
    updated := least(greatest((item->>'updatedAt')::numeric, 0), latest);
    finished := least(greatest(coalesce((item->>'doneAt')::numeric, updated), 0), latest);
    keep_start := not (item ? 'startAt');
    keep_minutes := not (item ? 'minutes');
    keep_notes := not (item ? 'notes');
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

    insert into public.planner_list_tasks as t (space_id, id, title, done, created_at, updated_at, done_at, start_at, minutes, notes)
      values (s, item_id, btrim(item->>'title'), (item->>'done')::boolean,
        to_timestamp(created / 1000), to_timestamp(updated / 1000),
        case when (item->>'done')::boolean then to_timestamp(finished / 1000) end,
        case when starts is not null then to_timestamp(starts / 1000) end,
        coalesce(round((item->>'minutes')::numeric)::smallint, 60),
        btrim(coalesce(item->>'notes', '')))
      on conflict (space_id, id) do update set
        title = excluded.title,
        done = excluded.done,
        updated_at = excluded.updated_at,
        done_at = excluded.done_at,
        start_at = case when keep_start then t.start_at else excluded.start_at end,
        minutes = case when keep_minutes then t.minutes else excluded.minutes end,
        notes = case when keep_notes then t.notes else excluded.notes end
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
        'startAt', floor(extract(epoch from t.start_at) * 1000)::bigint,
        'minutes', t.minutes,
        'notes', t.notes
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


-- 3. Task-start alerts, as in 20261201000200 today.
alter table public.planner_email_reminders
  add column if not exists starts_enabled boolean not null default true;

create table if not exists public.planner_start_alerts (
  user_id uuid not null references auth.users on delete cascade,
  space_id uuid not null,
  task_id uuid not null,
  start_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, task_id, start_at)
);
create index if not exists planner_start_alerts_sent on public.planner_start_alerts (sent_at);
alter table public.planner_start_alerts enable row level security;
revoke all on public.planner_start_alerts from public, anon, authenticated;
grant all on public.planner_start_alerts to service_role;

create or replace function public.planner_claim_start_alerts(p_now timestamptz default now(), p_limit integer default 1000)
returns table (
  user_id uuid,
  task_id uuid,
  title text,
  notes text,
  start_at timestamptz,
  minutes smallint,
  -- A group space's name; null for Personal.
  space_name text,
  timezone text,
  -- Null when the person has no address or turned these emails off.
  email text,
  unsubscribe_token uuid
)
language plpgsql security definer set search_path = '' as $$
begin
  -- Two days is long enough to never alert twice; nothing older is needed.
  delete from public.planner_start_alerts o where o.sent_at < p_now - interval '2 days';
  return query
  with due as (
    select m.user_id as alert_user, t.space_id as alert_space, t.id as alert_task, t.start_at as alert_start
    from public.planner_list_tasks t
    join public.planner_space_members m on m.space_id = t.space_id
    join public.planner_accounts a on a.user_id = m.user_id and not a."isDeleted"
    where not t.done and t.start_at > p_now and t.start_at <= p_now + interval '5 minutes'
    order by t.start_at, t.id, m.user_id
    limit greatest(p_limit, 0)
  ), claimed as (
    insert into public.planner_start_alerts as s (user_id, space_id, task_id, start_at)
      select d.alert_user, d.alert_space, d.alert_task, d.alert_start from due d
      on conflict do nothing
      returning s.user_id as alert_user, s.space_id as alert_space, s.task_id as alert_task, s.start_at as alert_start
  )
  select c.alert_user, c.alert_task, t.title, t.notes, c.alert_start, t.minutes,
    case when x.kind = 'group' then x.name end,
    coalesce(r.timezone, 'UTC'),
    case when not coalesce(au.is_anonymous, false) and coalesce(r.starts_enabled, false)
      then nullif(btrim(au.email), '') end,
    r.unsubscribe_token
  from claimed c
  join public.planner_list_tasks t on t.space_id = c.alert_space and t.id = c.alert_task
  join public.planner_spaces x on x.id = c.alert_space
  join auth.users au on au.id = c.alert_user
  left join public.planner_email_reminders r on r.user_id = c.alert_user
  order by c.alert_start, c.alert_task;
end;
$$;
revoke all on function public.planner_claim_start_alerts(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.planner_claim_start_alerts(timestamptz, integer) to service_role;

-- An unsubscribe link can now also turn off task-start emails.
create or replace function public.planner_unsubscribe(p_token uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.planner_email_reminders set
    comeback_enabled = comeback_enabled and p_kind <> 'comeback',
    starts_enabled = starts_enabled and p_kind <> 'starts'
  where unsubscribe_token = p_token and p_kind in ('daily', 'comeback', 'session', 'starts');
  return found;
end;
$$;


-- 4. The early Google Calendar version: never deployed, so it holds nothing.
drop function if exists public.planner_calendar_tasks(uuid);
drop function if exists public.planner_calendar_move(uuid, uuid, uuid, timestamptz, text);
drop table if exists public.planner_google_events;
drop table if exists public.planner_google_states;
drop table if exists public.planner_google_calendars;

commit;
