import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const as = (db, sub) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, role: 'authenticated' })]);
const stats = async (db, args, timezone = 'UTC') =>
  (await db.query('select public.planner_call($1, $2::jsonb, $3) as result', ['month_stats', JSON.stringify(args), timezone])).rows[0].result;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}'), ('${other}');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, ai_enabled boolean not null default true, ai_revision bigint not null default 0);
    create table public.planner_tasks(user_id uuid, planned_for date, status text, actual_seconds bigint not null default 0);
    create table public.planner_resources(user_id uuid);
    create table public.planner_stops(user_id uuid); create table public.planner_reviews(user_id uuid);
    -- Stands in for the shared backend dispatcher, which soft-delete renames to planner_call_active.
    create function public.planner_call(p_action text, p_args jsonb, p_timezone text) returns jsonb language plpgsql security definer as $$ begin
      return jsonb_build_object('action', p_action);
    end $$;
  `);
  for (const name of ['20261024000200_soft_delete_accounts.sql', '20261103000100_weekly_reviews_always_on.sql', '20261106000100_month_stats.sql'])
    await db.exec(migration(name));
  return db;
}

const insert = (db, user, plannedFor, status, seconds) =>
  db.query('insert into public.planner_tasks values ($1, $2, $3, $4)', [user, plannedFor, status, seconds]);

test('a past month reports finished share and focus time for the owner only', async () => {
  const db = await fixture();
  try {
    await insert(db, owner, '2026-03-02', 'completed', 1500);
    await insert(db, owner, '2026-03-02', 'completed', 900);
    await insert(db, owner, '2026-03-31', 'planned', 0);
    await insert(db, owner, '2026-03-15', 'planned', 600);
    await insert(db, owner, '2026-02-28', 'completed', 3600);
    await insert(db, owner, '2026-04-01', 'completed', 3600);
    await insert(db, other, '2026-03-02', 'completed', 9999);
    await as(db, owner);
    assert.deepEqual(await stats(db, { month: '2026-03', _accountKey: 'ignored' }),
      { month: '2026-03', planned: 4, completed: 2, focusSeconds: 3000 });
  } finally { await db.close(); }
});

test("today's unfinished tasks and future days do not count against the month", async () => {
  const db = await fixture();
  try {
    const today = day(0);
    await insert(db, owner, today, 'completed', 1200);
    await insert(db, owner, today, 'active', 300);
    await insert(db, owner, today, 'planned', 0);
    await insert(db, owner, day(1), 'planned', 0);
    await as(db, owner);
    const result = await stats(db, { month: today.slice(0, 7) });
    assert.equal(result.planned, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.focusSeconds, 1500);
  } finally { await db.close(); }
});

test('bad input, signed-out callers and deleted accounts are refused', async () => {
  const db = await fixture();
  try {
    await as(db, owner);
    for (const month of ['2026-13', '2026-3', 'march', null])
      await assert.rejects(stats(db, { month }), (error) => error.code === 'PT400');
    await assert.rejects(stats(db, { month: '2026-03' }, 'Not/AZone'), (error) => error.code === 'PT400');
    await db.query('select public.planner_call($1, $2::jsonb, $3)', ['delete_account', '{}', 'UTC']);
    await assert.rejects(stats(db, { month: '2026-03' }), (error) => error.code === 'PT403');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
    await assert.rejects(stats(db, { month: '2026-03' }), (error) => error.code === 'PT401');
  } finally { await db.close(); }
});

test('the stats function is private and other actions still reach the dispatcher', async () => {
  const db = await fixture();
  try {
    const { rows } = await db.query(`select
      has_function_privilege('authenticated', 'public.planner_month_stats(uuid,jsonb,text)', 'EXECUTE') as authenticated,
      has_function_privilege('anon', 'public.planner_month_stats(uuid,jsonb,text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.planner_call(text,jsonb,text)', 'EXECUTE') as call`);
    assert.deepEqual(rows[0], { authenticated: false, anon: false, call: true });
    await as(db, owner);
    assert.deepEqual((await db.query(`select public.planner_call('dashboard', '{}'::jsonb, 'UTC') as r`)).rows[0].r, { action: 'dashboard' });
    await assert.rejects(db.query(`select public.planner_call('set_weekly_ai_enabled', '{"enabled":false}'::jsonb, 'UTC')`),
      (error) => error.code === 'PT400');
  } finally { await db.close(); }
});
