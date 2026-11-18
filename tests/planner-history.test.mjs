import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const migration = readFileSync(
  new URL("../supabase/migrations/20261122000100_planner_history.sql", import.meta.url),
  "utf8",
);
const as = (db, sub, extra = {}) =>
  db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub, role: "authenticated", ...extra }),
  ]);
const track = (db, event, detail = {}) =>
  db.query("select public.planner_track($1, $2::jsonb)", [event, JSON.stringify(detail)]);
const history = async (db, user = owner) =>
  (
    await db.query(
      "select kind, event, task_id, detail from public.planner_history where user_id = $1 order by id",
      [user],
    )
  ).rows;

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    insert into auth.users values ('${owner}', 'owner@example.test'), ('${other}', 'other@example.test');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create table public.planner_accounts(user_id uuid primary key references auth.users on delete cascade, "isDeleted" boolean not null default false);
    create table public.planner_tasks(id uuid primary key, user_id uuid not null references auth.users on delete cascade,
      outcome text, planned_for date, slot integer, estimated_minutes integer, actual_seconds bigint not null default 0,
      status text not null default 'planned', started_at bigint, completed_on date, updated_at timestamptz default now());
    create table public.planner_stops(user_id uuid not null references auth.users on delete cascade,
      task_id uuid references public.planner_tasks on delete cascade, reason text, stopped_at bigint, stopped_on date);
    insert into public.planner_accounts(user_id) values ('${owner}'), ('${other}');
  `);
  await db.exec(migration);
  return db;
}

test("records each stage of a task without copying its title", async () => {
  const db = await fixture();
  await db.query(
    "insert into public.planner_tasks(id, user_id, outcome, planned_for, slot, estimated_minutes) values ($1, $2, 'Secret plan', '2026-11-18', 1, 25)",
    [taskId, owner],
  );
  await db.query("update public.planner_tasks set status = 'active', started_at = 100 where id = $1", [taskId]);
  await db.query("update public.planner_tasks set status = 'planned', started_at = null, actual_seconds = 600 where id = $1", [taskId]);
  await db.query("insert into public.planner_stops values ($1, $2, 'People: A meeting', 700, '2026-11-18')", [owner, taskId]);
  await db.query("update public.planner_tasks set estimated_minutes = 45 where id = $1", [taskId]);
  await db.query("update public.planner_tasks set outcome = 'Other secret' where id = $1", [taskId]);
  await db.query("update public.planner_tasks set updated_at = now() + interval '1 minute' where id = $1", [taskId]);
  await db.query("update public.planner_tasks set planned_for = '2026-11-19' where id = $1", [taskId]);
  await db.query("update public.planner_tasks set status = 'completed', completed_on = '2026-11-19' where id = $1", [taskId]);
  await db.query("delete from public.planner_tasks where id = $1", [taskId]);

  const rows = await history(db);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.event]),
    [
      ["task", "task_created"],
      ["task", "task_started"],
      ["task", "task_stopped"],
      ["stop", "stop_recorded"],
      ["task", "estimate_changed"],
      ["task", "task_renamed"],
      // The bookkeeping-only update is not recorded.
      ["task", "task_moved"],
      ["task", "task_completed"],
      ["task", "task_deleted"],
    ],
  );
  assert.ok(rows.every((r) => r.task_id === taskId));
  assert.equal(rows[0].detail.outcome, "set");
  assert.equal(rows[0].detail.estimated_minutes, 25);
  assert.deepEqual(rows[2].detail.actual_seconds, [0, 600]);
  assert.deepEqual(rows[3].detail, { stopped_on: "2026-11-18", has_reason: true });
  assert.deepEqual(rows[5].detail, { outcome: "changed" });
  assert.ok(!JSON.stringify(rows).includes("secret"), "titles and reasons are never copied");
  assert.ok(!JSON.stringify(rows).includes("Secret"));
  assert.ok(!JSON.stringify(rows).includes("meeting"));
});

test("journey events are allowlisted, coded and per account", async () => {
  const db = await fixture();
  await as(db, owner);
  await track(db, "planner_opened", { new_account: true, from: "reminder" });
  await track(db, "focus_time_saved", { minute: 540, weekdays_only: false });
  for (const [event, detail] of [
    ["made_up", {}],
    ["error_shown", { message: "Free text with spaces" }],
    ["error_shown", { Bad: "x" }],
    ["error_shown", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }],
    ["error_shown", { nested: { a: 1 } }],
  ])
    await assert.rejects(track(db, event, detail), /Invalid history event/);

  await as(db, owner, { is_anonymous: true });
  await assert.rejects(track(db, "planner_opened"), /Sign in/);

  assert.deepEqual(
    (await history(db)).map((r) => [r.kind, r.event, r.detail]),
    [
      ["journey", "planner_opened", { new_account: true, from: "reminder" }],
      ["journey", "focus_time_saved", { minute: 540, weekdays_only: false }],
    ],
  );
  assert.deepEqual(await history(db, other), []);
});

test("journey events stop at the daily cap and for deleted accounts", async () => {
  const db = await fixture();
  await db.exec(`insert into public.planner_history (user_id, kind, event)
    select '${owner}', 'journey', 'tour_shown' from generate_series(1, 300)`);
  await as(db, owner);
  await track(db, "tour_finished");
  assert.equal((await history(db)).length, 300);

  await db.exec(`update public.planner_accounts set "isDeleted" = true where user_id = '${other}'`);
  await as(db, other);
  await track(db, "tour_shown");
  assert.deepEqual(await history(db, other), []);
});

test("old rows are pruned and history goes with the account", async () => {
  const db = await fixture();
  await db.exec(`insert into public.planner_history (user_id, at, kind, event)
    values ('${owner}', now() - interval '181 days', 'journey', 'tour_shown')`);
  await db.query(
    "insert into public.planner_tasks(id, user_id, outcome, planned_for, slot) values ($1, $2, 'x', '2026-11-18', 1)",
    [taskId, owner],
  );
  assert.deepEqual((await history(db)).map((r) => r.event), ["task_created"]);

  // Deleting the user cascades through tasks; their delete triggers must not block it.
  await db.query("delete from auth.users where id = $1", [owner]);
  const left = await db.query("select count(*)::int as n from public.planner_history");
  assert.equal(left.rows[0].n, 0);
});

test("only service_role can read the history", () => {
  assert.match(migration, /revoke all on public\.planner_history from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.planner_track\(text, jsonb\) to authenticated;/);
});
