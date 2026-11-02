import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const user = '11111111-1111-4111-8111-111111111111';
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${user}');
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users, "isDeleted" boolean default false, revision bigint default 0, last_event_at bigint default 0);
    create table public.planner_tasks(id uuid primary key, user_id uuid not null references auth.users, outcome text not null check(length(outcome) between 1 and 500), planned_for date not null, slot smallint not null check(slot between 1 and 3), estimated_minutes int not null check(estimated_minutes between 1 and 60), actual_seconds bigint not null check(actual_seconds >= 0), status text not null check(status in ('planned','active','completed')), started_at bigint, completed_on date, created_at bigint not null, is_priority boolean, unique(user_id, planned_for, slot), unique(user_id, id), check((status = 'completed') = (completed_on is not null)), check(started_at is null or status = 'active'));
    create table public.planner_stops(user_id uuid not null, task_id uuid not null, reason text not null check(length(reason) between 1 and 1000), stopped_at bigint not null, stopped_on date not null, foreign key(user_id, task_id) references public.planner_tasks(user_id, id));
    set test.uid = '${user}';
  `);
  for (const name of ['20261028000100_guest_import.sql', '20261031000100_guest_usage.sql', '20261102000100_onboarding_survey.sql'])
    await db.exec(migration(name));
  return db;
}
const survey = { goal: 'ship', role: 'engineer', focusWindow: 'morning', focusMinutes: 60, derailer: 'phone', deepWorkHours: 2, weekGoal: 'Launch the new homepage', weekStart: '2026-11-02' };
function payload(overrides = {}) {
  const taskId = crypto.randomUUID();
  return { importId: crypto.randomUUID(), tasks: [{ id: taskId, outcome: 'Build the next feature', plannedFor: '2026-11-04', estimatedMinutes: 60, actualSeconds: 0, status: 'planned', startedAt: null, completedOn: null, createdAt: 1793600000 }], stops: [], ...overrides };
}
const send = (db, data) => db.query('select public.planner_import_guest($1::jsonb) as result', [JSON.stringify(data)]);
const count = async (db, table) => (await db.query(`select count(*)::int as count from ${table}`)).rows[0].count;
const answers = async (db) => (await db.query('select goal, role, focus_window, focus_minutes, derailer, deep_work_hours, week_goal, week_start::text from planner_onboarding')).rows;

test('answers arrive with guest tasks in one atomic, idempotent import', async () => {
  const db = await fixture();
  try {
    const data = payload({ survey });
    assert.equal((await send(db, data)).rows[0].result.imported, true);
    await send(db, data);
    assert.equal(await count(db, 'planner_tasks'), 1);
    assert.deepEqual(await answers(db), [{ goal: 'ship', role: 'engineer', focus_window: 'morning', focus_minutes: 60, derailer: 'phone', deep_work_hours: 2, week_goal: 'Launch the new homepage', week_start: '2026-11-02' }]);
    assert.equal((await db.query('select revision::int from planner_accounts')).rows[0].revision, 1);
  } finally { await db.close(); }
});

test('answers alone import without tasks and leave the planner revision alone', async () => {
  const db = await fixture();
  try {
    await send(db, payload({ tasks: [], survey: { goal: 'study', focusMinutes: 30 } }));
    assert.equal(await count(db, 'planner_tasks'), 0);
    assert.equal((await db.query('select revision::int from planner_accounts')).rows[0].revision, 0);
    assert.equal((await answers(db))[0].goal, 'study');
    // A later import keeps the earlier outcome when it has none of its own.
    await send(db, payload({ tasks: [], survey }));
    await send(db, payload({ tasks: [], survey: { goal: 'business' } }));
    const [row] = await answers(db);
    assert.deepEqual([row.goal, row.role, row.week_goal, row.week_start], ['business', null, 'Launch the new homepage', '2026-11-02']);
  } finally { await db.close(); }
});

test('malformed answers reject the whole import, tasks included', async () => {
  const db = await fixture();
  try {
    for (const bad of [
      'yes', [], { name: 'Ada' }, { goal: 7 }, { focusMinutes: '60' }, { goal: 'world domination' },
      { focusMinutes: 45 }, { deepWorkHours: 9 }, { weekGoal: 'Launch' }, { weekStart: '2026-11-02' },
      { weekGoal: 'Launch', weekStart: '2026-11-03' }, { weekGoal: 'Launch', weekStart: 'next week' },
      { weekGoal: 'x'.repeat(201), weekStart: '2026-11-02' }, { weekGoal: null, weekStart: '2026-11-02' },
    ]) await assert.rejects(send(db, payload({ survey: bad })), /Invalid onboarding answers|Invalid or conflicting/, JSON.stringify(bad));
    for (const table of ['planner_tasks', 'planner_onboarding', 'planner_guest_imports'])
      assert.equal(await count(db, table), 0, table);
  } finally { await db.close(); }
});

test('only the service role can read a week outcome, and only for its own week', async () => {
  const db = await fixture();
  try {
    await send(db, payload({ tasks: [], survey }));
    const goal = (week) => db.query(`select public.planner_week_goal('${user}', '${week}') as goal`);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(goal('2026-11-02'), /permission denied/, role);
      await assert.rejects(db.query('select * from public.planner_onboarding'), /permission denied/, role);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await goal('2026-11-02')).rows[0].goal, 'Launch the new homepage');
    assert.equal((await goal('2026-11-09')).rows[0].goal, null);
    await db.exec('reset role');
  } finally { await db.close(); }
});

test('funnel totals join the anonymous counter with the same bounds', async () => {
  const db = await fixture();
  try {
    const record = (metrics) => db.exec(`set role anon; select public.guest_record_usage('${JSON.stringify(metrics)}'::jsonb); reset role;`);
    await record({ funnel_survey_shown: 1, funnel_survey_started: 1 });
    await record({ funnel_control_shown: 1, tasks_created: 1, focus_minutes: 25 });
    const totals = Object.fromEntries((await db.query('select metric, total::int as total from guest_usage_daily')).rows.map((row) => [row.metric, row.total]));
    assert.deepEqual(totals, { funnel_survey_shown: 1, funnel_survey_started: 1, funnel_control_shown: 1, tasks_created: 1, focus_minutes: 25 });
    for (const metrics of [{ funnel_survey_shown: 2 }, { funnel_survey_goal: 1 }, { funnel_survey_shown: 'ship' }]) {
      await db.exec('reset role');
      await assert.rejects(record(metrics), /Invalid guest usage/, JSON.stringify(metrics));
    }
  } finally { await db.close(); }
});
