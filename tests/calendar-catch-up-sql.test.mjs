import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { as, backendDb, migration } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MINUTE = 60_000;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const task = (n, fields = {}) => ({ id: id(n), title: `Task ${n}`, done: false, createdAt: NOW - 60 * MINUTE + n, updatedAt: NOW - 60 * MINUTE + n, doneAt: null, ...fields });
const early = (name) => readFileSync(new URL(`./fixtures/calendar-early/${name}`, import.meta.url), "utf8");
const CATCH_UP = "20261202000100_calendar_catch_up.sql";
const call = async (db, action, args = {}) =>
  (await db.query("select public.planner_list($1, $2::jsonb, 'UTC') as result", [action, JSON.stringify(args)])).rows[0].result;

/** A database that ran the early versions of 20261201000100 and 20261201000200, as production may have. */
async function earlyDb() {
  const db = await backendDb({ until: "20261130000100_daily_push.sql" });
  await db.exec(early("20261201000100_task_start_times.sql"));
  await db.exec(early("20261201000200_google_calendar.sql"));
  await db.query("insert into auth.users(id, email) values ($1, 'owner@example.test')", [owner]);
  return db;
}

test("the early state loses a task's length: the bug this catch-up fixes", async () => {
  const db = await earlyDb();
  await as(db, owner);
  const saved = await call(db, "sync", { save: [task(1, { startAt: NOW + 60 * MINUTE, minutes: 90 })] });
  assert.equal(saved.tasks[0].startAt, NOW + 60 * MINUTE);
  assert.equal(saved.tasks[0].minutes, undefined);
});

test("after the catch-up, an early database keeps its plans and has length, description, calendars and start alerts", async () => {
  const db = await earlyDb();
  await as(db, owner);
  await call(db, "sync", { save: [task(1, { startAt: NOW + 3 * MINUTE })] });
  await as(db, null);
  await db.exec(migration(CATCH_UP));
  await as(db, owner);
  // The plan made before the catch-up is still there, with the usual hour.
  const before = (await call(db, "sync")).tasks[0];
  assert.deepEqual([before.startAt, before.minutes, before.notes], [NOW + 3 * MINUTE, 60, ""]);
  const saved = await call(db, "sync", { save: [task(1, { startAt: NOW + 3 * MINUTE, minutes: 90, notes: "https://example.com", updatedAt: NOW })] });
  assert.deepEqual([saved.tasks[0].minutes, saved.tasks[0].notes], [90, "https://example.com"]);
  await assert.rejects(call(db, "sync", { save: [task(2, { minutes: 5 })] }), (error) => error.code === "PT400");
  assert.deepEqual((await call(db, "calendar", { from: NOW, to: NOW + 24 * 60 * MINUTE })).elsewhere, []);
  await as(db, null);
  const alerts = (await db.query("select title, minutes from public.planner_claim_start_alerts($1)", [new Date(NOW).toISOString()])).rows;
  assert.deepEqual(alerts, [{ title: "Task 1", minutes: 90 }]);
  // The unused Google Calendar tables are gone.
  const google = (await db.query("select count(*)::int as n from information_schema.tables where table_name like 'planner_google_%'")).rows[0].n;
  assert.equal(google, 0);
  // A second run changes nothing.
  await db.exec(migration(CATCH_UP));
  assert.equal((await db.query("select count(*)::int as n from pg_constraint where conrelid = 'public.planner_list_tasks'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'minutes'")).rows[0].n, 1);
});

test("on a current database the catch-up changes nothing and can run again", async () => {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email) values ($1, 'owner@example.test')", [owner]);
  await as(db, owner);
  await call(db, "sync", { save: [task(1, { startAt: NOW + 3 * MINUTE, minutes: 45, notes: "Agenda" })] });
  await as(db, null);
  await db.exec(migration(CATCH_UP));
  await as(db, owner);
  const after = (await call(db, "sync")).tasks[0];
  assert.deepEqual([after.minutes, after.notes], [45, "Agenda"]);
  // One check each for the length and the description: none added twice.
  const checks = (await db.query("select count(*)::int as n from pg_constraint where conrelid = 'public.planner_list_tasks'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '(minutes|notes)'")).rows[0].n;
  assert.equal(checks, 2);
});
