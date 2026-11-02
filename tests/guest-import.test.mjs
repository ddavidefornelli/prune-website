import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
async function fixture(migrations) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${user}'), ('${other}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, "isDeleted" boolean default false, revision bigint default 0, last_event_at bigint default 0);
    create table public.planner_tasks(id uuid primary key, user_id uuid not null references auth.users, outcome text not null check(length(outcome) between 1 and 500), planned_for date not null, slot smallint not null check(slot between 1 and 3), estimated_minutes int not null check(estimated_minutes between 1 and 60), actual_seconds bigint not null check(actual_seconds >= 0), status text not null check(status in ('planned','active','completed')), started_at bigint, completed_on date, created_at bigint not null, is_priority boolean, unique(user_id, planned_for, slot), unique(user_id, id), check((status = 'completed') = (completed_on is not null)), check(started_at is null or status = 'active'));
    create unique index one_active on public.planner_tasks(user_id) where status = 'active';
    create table public.planner_stops(user_id uuid not null, task_id uuid not null, reason text not null check(length(reason) between 1 and 1000), stopped_at bigint not null, stopped_on date not null, foreign key(user_id, task_id) references public.planner_tasks(user_id, id));
    set test.uid = '${user}';
  `);
  for (const name of migrations) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  return db;
}
function payload() {
  return { importId: crypto.randomUUID(), tasks: [{ id: taskId, outcome: 'Guest task', plannedFor: '2026-01-01', estimatedMinutes: 30, actualSeconds: 10, status: 'completed', startedAt: null, completedOn: '2026-01-01', createdAt: 1767225600 }], stops: [{ taskId, reason: 'A call', at: 1767225610, day: '2026-01-01' }] };
}
const send = (db, data) => db.query('select public.planner_import_guest($1::jsonb) as result', [JSON.stringify(data)]);

// The onboarding-survey migration replaces planner_import_guest; both versions must hold.
const VERSIONS = {
  original: ['20261028000100_guest_import.sql'],
  'with onboarding answers': ['20261028000100_guest_import.sql', '20261031000100_guest_usage.sql', '20261102000100_onboarding_survey.sql'],
};
for (const [version, migrations] of Object.entries(VERSIONS)) {
test(`guest SQL import is atomic, authenticated, idempotent, and account scoped (${version})`, async () => {
  const db = await fixture(migrations);
  try {
    const data = payload();
    assert.equal((await send(db, data)).rows[0].result.imported, true);
    await send(db, data);
    assert.equal((await db.query('select count(*)::int as count from planner_tasks')).rows[0].count, 1);
    assert.equal((await db.query('select count(*)::int as count from planner_stops')).rows[0].count, 1);
    await assert.rejects(send(db, { ...data, stops: [] }), /identity was reused/);
    await db.exec(`set test.uid = '${other}'`);
    await assert.rejects(send(db, data), /conflicting guest data/);
    assert.equal((await db.query('select count(*)::int as count from planner_guest_imports')).rows[0].count, 1);
    await db.exec(`set test.uid = ''`);
    await assert.rejects(send(db, { ...data, importId: crypto.randomUUID() }), /Sign in/);
  } finally { await db.close(); }
});

test(`full planning days and deleted accounts reject imports without losing existing tasks (${version})`, async () => {
  const db = await fixture(migrations);
  try {
    for (let i = 0; i < 3; i++) {
      const data = payload();
      data.tasks[0].id = crypto.randomUUID();
      data.stops = [];
      await send(db, data);
    }
    await assert.rejects(send(db, payload()), /already has tasks/);
    assert.equal((await db.query('select count(*)::int as count from planner_tasks')).rows[0].count, 3);
    await db.exec('update planner_accounts set "isDeleted" = true');
    await assert.rejects(send(db, payload()), /deleted/);
  } finally { await db.close(); }
});

test(`bad guest data rolls back all tasks, stops and receipts (${version})`, async () => {
  const db = await fixture(migrations);
  try {
    const data = payload();
    data.tasks.push({ ...data.tasks[0], id: crypto.randomUUID(), estimatedMinutes: 999 });
    await assert.rejects(send(db, data), /Invalid or conflicting/);
    for (const table of ['planner_tasks', 'planner_stops', 'planner_guest_imports'])
      assert.equal((await db.query(`select count(*)::int as count from ${table}`)).rows[0].count, 0);
  } finally { await db.close(); }
});
}
