import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.now();
const HOUR = 3_600_000;
const START = Math.floor(NOW / HOUR) * HOUR + 24 * HOUR;
const task = (n, fields = {}) => ({ id: id(n), title: `Task ${n}`, done: false, createdAt: NOW + n, updatedAt: NOW + n, doneAt: null, ...fields });
const sync = async (db, args = {}) =>
  (await db.query("select public.planner_list('sync', $1::jsonb, 'UTC') as result", [JSON.stringify(args)])).rows[0].result;

async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email) values ($1, 'owner@example.test'), ($2, 'friend@example.test'), ($3, 'third@example.test')", [owner, friend, third]);
  await as(db, owner);
  return db;
}

test("a task's start is saved, returned, moved and cleared", async () => {
  const db = await fixture();
  const saved = await sync(db, { save: [task(1, { startAt: START })] });
  assert.equal(saved.tasks[0].startAt, START);
  const moved = await sync(db, { save: [task(1, { startAt: START + HOUR, updatedAt: NOW + 10 })] });
  assert.equal(moved.tasks[0].startAt, START + HOUR);
  const cleared = await sync(db, { save: [task(1, { startAt: null, updatedAt: NOW + 20 })] });
  assert.equal(cleared.tasks[0].startAt, null);
  await assert.rejects(sync(db, { save: [task(2, { startAt: "noon" })] }), (error) => error.code === "PT400");
});

test("an older website that sends no start keeps the plan", async () => {
  const db = await fixture();
  await sync(db, { save: [task(1, { startAt: START })] });
  const { startAt, ...old } = task(1, { title: "Renamed elsewhere", updatedAt: NOW + 10 });
  const after = await sync(db, { save: [old] });
  assert.deepEqual([after.tasks[0].title, after.tasks[0].startAt], ["Renamed elsewhere", START]);
});

test("a description and a duration are saved, checked, and kept by older websites", async () => {
  const db = await fixture();
  const first = await sync(db, { save: [task(1)] });
  assert.deepEqual([first.tasks[0].notes, first.tasks[0].minutes], ["", 60]);
  const notes = "Agenda: https://example.com/doc\nBring the contract";
  const saved = await sync(db, { save: [task(1, { startAt: START, notes, minutes: 90, updatedAt: NOW + 10 })] });
  assert.deepEqual([saved.tasks[0].notes, saved.tasks[0].minutes], [notes, 90]);
  // An older website sends neither: both stay.
  const after = await sync(db, { save: [task(1, { title: "Renamed", updatedAt: NOW + 20 })] });
  assert.deepEqual([after.tasks[0].title, after.tasks[0].notes, after.tasks[0].minutes], ["Renamed", notes, 90]);
  for (const bad of [{ minutes: 5 }, { minutes: 721 }, { minutes: "1h" }, { notes: 3 }, { notes: "x".repeat(2001) }])
    await assert.rejects(sync(db, { save: [task(2, bad)] }), (error) => error.code === "PT400");
});

const call = async (db, action, args = {}) =>
  (await db.query("select public.planner_list($1, $2::jsonb, 'UTC') as result", [action, JSON.stringify(args)])).rows[0].result;
const WEEK = { from: START - 24 * HOUR, to: START + 6 * 24 * HOUR };

test("Personal shows what the person planned in their groups; a group shows its people's other plans as busy time only", async () => {
  const db = await fixture();
  const { space, token } = await call(db, "create", { name: "Trip" });
  await sync(db, { space, save: [task(1, { title: "Book the hotel", startAt: START, minutes: 30, notes: "https://example.com" }), task(2, { title: "Unplanned" })] });
  // The owner's own Personal: a dentist appointment, 1 h, and a done task (not busy any more).
  await sync(db, { save: [task(3, { title: "Dentist", startAt: START + 2 * HOUR }), task(4, { title: "Gym", startAt: START + 5 * HOUR, done: true, doneAt: NOW })] });
  await as(db, friend);
  await call(db, "join", { token });
  // The friend's Personal overlaps the owner's dentist: one merged range.
  await sync(db, { save: [task(5, { title: "Secret date", startAt: START + 2.5 * HOUR, minutes: 90 })] });
  await as(db, third);
  // Someone outside the group is never counted.
  await sync(db, { save: [task(6, { startAt: START + 8 * HOUR })] });

  await as(db, owner);
  const personal = await call(db, "calendar", WEEK);
  assert.deepEqual(personal.busy, []);
  assert.deepEqual(
    personal.elsewhere.map((t) => [t.title, t.spaceName, t.startAt, t.minutes, t.notes]),
    [["Book the hotel", "Trip", START, 30, "https://example.com"]],
  );

  const group = await call(db, "calendar", { ...WEEK, space });
  assert.deepEqual(group.elsewhere, []);
  assert.deepEqual(group.busy, [{ start: START + 2 * HOUR, end: START + 4 * HOUR }]);
  // Nothing in it says who or what.
  assert.ok(!JSON.stringify(group).includes("Secret") && !JSON.stringify(group).includes("Dentist"));
  // The friend sees the same; an outsider cannot ask.
  await as(db, friend);
  assert.deepEqual((await call(db, "calendar", { ...WEEK, space })).busy, group.busy);
  await as(db, third);
  await assert.rejects(call(db, "calendar", { ...WEEK, space }), (error) => error.code === "PT404");
  await assert.rejects(call(db, "calendar", { from: 0, to: 30 * 24 * HOUR }), (error) => error.code === "PT400");
});
