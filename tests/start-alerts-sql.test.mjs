import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";
const guest = "33333333-3333-4333-8333-333333333333";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MINUTE = 60_000;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const task = (n, fields = {}) => ({ id: id(n), title: `Task ${n}`, done: false, createdAt: NOW - 10 * MINUTE + n, updatedAt: NOW - 10 * MINUTE + n, doneAt: null, ...fields });
const call = async (db, action, args = {}) =>
  (await db.query("select public.planner_list($1, $2::jsonb, 'Europe/Rome') as result", [action, JSON.stringify(args)])).rows[0].result;
const claim = async (db, at = NOW) =>
  (await db.query("select user_id::text, task_id::text, title, notes, minutes, space_name, timezone, email, unsubscribe_token is not null as can_unsubscribe, extract(epoch from start_at) * 1000 as start from public.planner_claim_start_alerts($1)", [new Date(at).toISOString()])).rows
    .map((row) => ({ ...row, start: Number(row.start) }))
    .sort((a, b) => (a.task_id + a.user_id).localeCompare(b.task_id + b.user_id));

async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email, is_anonymous) values ($1, 'owner@example.test', false), ($2, 'friend@example.test', false), ($3, '', true)", [owner, friend, guest]);
  return db;
}

test("tasks starting within 5 minutes alert everyone in their space, once per start time", async () => {
  const db = await fixture();
  await as(db, owner);
  await call(db, "sync", { save: [
    task(1, { title: "Call the bank", startAt: NOW + 5 * MINUTE, notes: "https://example.com", minutes: 30 }),
    task(2, { startAt: NOW + 6 * MINUTE }),
    task(3, { startAt: NOW + 2 * MINUTE, done: true, doneAt: NOW }),
    task(4, { startAt: NOW - MINUTE }),
  ] });
  const { space, token } = await call(db, "create", { name: "Trip" });
  await call(db, "sync", { space, save: [task(5, { title: "Board", startAt: NOW + 3 * MINUTE })] });
  await as(db, friend);
  await call(db, "sync", { save: [] });
  await call(db, "join", { token });
  await as(db, guest, { is_anonymous: true });
  await call(db, "sync", { save: [task(6, { title: "Guest task", startAt: NOW + MINUTE })] });
  await as(db, null);

  const first = await claim(db);
  assert.deepEqual(first.map((a) => [a.title, a.user_id, a.space_name, a.email]), [
    ["Call the bank", owner, null, "owner@example.test"],
    ["Board", owner, "Trip", "owner@example.test"],
    ["Board", friend, "Trip", "friend@example.test"],
    ["Guest task", guest, null, null],
  ]);
  assert.deepEqual([first[0].notes, first[0].minutes, first[0].start, first[0].timezone, first[0].can_unsubscribe], ["https://example.com", 30, NOW + 5 * MINUTE, "Europe/Rome", true]);
  // A minute later: nothing twice; task 2 is now due.
  assert.deepEqual((await claim(db, NOW + MINUTE)).map((a) => a.title), ["Task 2"]);

  // Moved to a new time, it alerts again when that comes.
  await as(db, owner);
  await call(db, "sync", { save: [task(1, { title: "Call the bank", startAt: NOW + 20 * MINUTE, updatedAt: NOW })] });
  await as(db, null);
  assert.deepEqual((await claim(db, NOW + 16 * MINUTE)).map((a) => a.title), ["Call the bank"]);
});

test("the email can be turned off with its own link; the notification still comes", async () => {
  const db = await fixture();
  await as(db, owner);
  await call(db, "sync", { save: [task(1, { startAt: NOW + 4 * MINUTE }), task(2, { startAt: NOW + 30 * MINUTE })] });
  await as(db, null);
  const token = (await db.query("select unsubscribe_token::text as t from public.planner_email_reminders where user_id = $1", [owner])).rows[0].t;
  assert.equal((await db.query("select public.planner_unsubscribe($1, 'starts') as ok", [token])).rows[0].ok, true);
  const reminders = (await db.query("select comeback_enabled, starts_enabled from public.planner_email_reminders where user_id = $1", [owner])).rows[0];
  assert.deepEqual(reminders, { comeback_enabled: true, starts_enabled: false });
  assert.deepEqual((await claim(db)).map((a) => [a.title, a.email]), [["Task 1", null]]);
});

test("the browser cannot claim alerts", async () => {
  const db = await fixture();
  await db.query("set role authenticated");
  await assert.rejects(db.query("select * from public.planner_claim_start_alerts()"), /permission denied/);
  await db.query("reset role");
});
