import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const owner = '11111111-1111-4111-8111-111111111111';
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const asOwner = (db) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: owner, role: 'authenticated' })]);
const call = (db, action, args = {}) => db.query('select public.planner_call($1, $2::jsonb) as result', [action, JSON.stringify(args)]);
const enabled = async (db) => (await db.query(`select ai_enabled from public.planner_accounts where user_id = '${owner}'`)).rows[0].ai_enabled;
const refused = (error) => error.code === 'PT400' && error.message === 'Weekly reviews are part of prune and cannot be turned off.';

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, ai_enabled boolean not null default true, ai_revision bigint not null default 0);
    create table public.planner_tasks(user_id uuid); create table public.planner_resources(user_id uuid);
    create table public.planner_stops(user_id uuid); create table public.planner_reviews(user_id uuid);
    -- Stands in for the shared backend dispatcher, which soft-delete renames to planner_call_active.
    create function public.planner_call(p_action text, p_args jsonb, p_timezone text) returns jsonb language plpgsql security definer as $$ begin
      if p_action = 'set_weekly_ai_enabled' then
        update public.planner_accounts set ai_enabled = (p_args->>'enabled')::boolean, ai_revision = ai_revision + 1 where user_id = auth.uid();
      end if;
      return (select jsonb_build_object('action', p_action, 'enabled', ai_enabled) from public.planner_accounts where user_id = auth.uid());
    end $$;
  `);
  for (const name of ['20261024000200_soft_delete_accounts.sql', '20261103000100_weekly_reviews_always_on.sql'])
    await db.exec(migration(name));
  await asOwner(db);
  return db;
}

test('owners can turn weekly reviews on but never off', async () => {
  const db = await fixture();
  try {
    assert.deepEqual((await call(db, 'dashboard')).rows[0].result, { action: 'dashboard', enabled: true });
    for (const args of [{ enabled: false }, { enabled: 'false' }, { enabled: null }, { enabled: 0 }, {}])
      await assert.rejects(call(db, 'set_weekly_ai_enabled', args), refused);
    assert.equal(await enabled(db), true);
    // An account that turned reviews off before this migration can still turn them on.
    await db.exec(`update public.planner_accounts set ai_enabled = false where user_id = '${owner}'`);
    assert.deepEqual((await call(db, 'set_weekly_ai_enabled', { enabled: true })).rows[0].result, { action: 'set_weekly_ai_enabled', enabled: true });
    await assert.rejects(call(db, 'set_weekly_ai_enabled', { enabled: false }), refused);
  } finally { await db.close(); }
});

test('account deletion still disables weekly AI and keeps blocking the deleted account', async () => {
  const db = await fixture();
  try {
    assert.deepEqual((await call(db, 'delete_account')).rows[0].result, { isDeleted: true });
    assert.equal(await enabled(db), false);
    await assert.rejects(call(db, 'set_weekly_ai_enabled', { enabled: true }), (error) => error.code === 'PT403');
  } finally { await db.close(); }
});

test('the replaced guard keeps authenticated-only access and a private dispatcher', async () => {
  const db = await fixture();
  try {
    const { rows } = await db.query(`select
      has_function_privilege('authenticated', 'public.planner_call(text,jsonb,text)', 'EXECUTE') as authenticated,
      has_function_privilege('anon', 'public.planner_call(text,jsonb,text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.planner_call_active(text,jsonb,text)', 'EXECUTE') as dispatcher`);
    assert.deepEqual(rows[0], { authenticated: true, anon: false, dispatcher: false });
  } finally { await db.close(); }
});

test('the Clerk bridge drops cleanly, but never while identity mappings remain', async () => {
  const db = await fixture();
  try {
    await db.exec('reset role');
    await db.exec(migration('20261027000100_clerk_bridge.sql'));
    await db.exec(`insert into public.planner_clerk_identities values ('user_clerk', '${owner}', now())`);
    await assert.rejects(db.exec(migration('20261105000200_drop_clerk_bridge.sql')), /still has rows/);
    await db.exec('rollback');
    assert.ok((await db.query(`select to_regclass('public.planner_clerk_identities') as t`)).rows[0].t, 'a refused drop changes nothing');
    await db.exec('delete from public.planner_clerk_identities');
    await db.exec(migration('20261105000200_drop_clerk_bridge.sql'));
    const { rows } = await db.query(`select to_regclass('public.planner_clerk_identities') as t,
      to_regprocedure('public.planner_call_as(uuid,text,jsonb,text)') as f`);
    assert.deepEqual(rows[0], { t: null, f: null });
    await db.exec(migration('20261105000200_drop_clerk_bridge.sql'));
  } finally { await db.close(); }
});
