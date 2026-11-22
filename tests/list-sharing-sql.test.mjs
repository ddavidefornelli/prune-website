import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";
const stranger = "33333333-3333-4333-8333-333333333333";
const call = async (db, action, args = {}) =>
  (await db.query("select public.planner_list($1, $2::jsonb, 'UTC') as result", [action, JSON.stringify(args)])).rows[0].result;
const sync = (db, args) => call(db, "sync", args);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.now();
const task = (n, fields = {}) => ({ id: id(n), title: `Task ${n}`, done: false, createdAt: NOW + n, updatedAt: NOW + n, doneAt: null, ...fields });
const titles = (result) => result.tasks.map((t) => t.title);

async function fixture() {
  const db = await backendDb();
  await db.query(
    "insert into auth.users(id, email) values ($1, 'owner@example.test'), ($2, 'friend@example.test'), ($3, 'stranger@example.test')",
    [owner, friend, stranger],
  );
  return db;
}

/** The owner shares a list with one task; returns the link token. */
async function shared(db) {
  await as(db, owner);
  await sync(db, { save: [task(1)] });
  return (await call(db, "share")).token;
}

test("sharing gives one stable link, and the list says who else is in it", async () => {
  const db = await fixture();
  const token = await shared(db);
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal((await call(db, "share")).token, token);
  // Nobody joined yet: not shared.
  assert.equal((await sync(db)).shared, null);
});

test("joining moves the friend's tasks in, and both edit the same list", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await sync(db, { save: [task(2)] });
  assert.deepEqual(await call(db, "join", { token: token.toUpperCase() }), { joined: true });
  const theirs = await sync(db, { save: [task(3)] });
  assert.deepEqual(titles(theirs), ["Task 3", "Task 2", "Task 1"]);
  assert.deepEqual(theirs.shared, { role: "member", people: 2 });
  // A member gets the same link to pass on.
  assert.equal((await call(db, "share")).token, token);
  await as(db, owner);
  const mine = await sync(db, { remove: [id(2)] });
  assert.deepEqual(titles(mine), ["Task 3", "Task 1"]);
  assert.deepEqual(mine.shared, { role: "owner", people: 2 });
  // Joining again, or one's own link, changes nothing.
  assert.deepEqual(await call(db, "join", { token }), { joined: true });
  await as(db, friend);
  assert.deepEqual(await call(db, "join", { token }), { joined: true });
  assert.deepEqual(titles(await sync(db)), ["Task 3", "Task 1"]);
});

test("guests cannot share or join, and a wrong link is refused", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend, { is_anonymous: true });
  await assert.rejects(call(db, "share"), (error) => error.code === "PT400");
  await assert.rejects(call(db, "join", { token }), (error) => error.code === "PT400");
  await as(db, friend);
  await assert.rejects(call(db, "join", { token: "0".repeat(32) }), (error) => error.code === "PT404");
  await assert.rejects(call(db, "join", {}), (error) => error.code === "PT404");
  // A stranger without the link never sees the list.
  await as(db, stranger);
  assert.deepEqual((await sync(db)).tasks, []);
});

test("a member who leaves gets an empty list; the shared list stays", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  assert.deepEqual(await call(db, "leave"), { left: true });
  const after = await sync(db);
  assert.deepEqual(after.tasks, []);
  assert.equal(after.shared, null);
  await as(db, owner);
  assert.deepEqual(titles(await sync(db)), ["Task 1"]);
});

test("stopping sharing removes every member and the old link stops working", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  await as(db, owner);
  await call(db, "leave");
  assert.equal((await sync(db)).shared, null);
  await as(db, friend);
  assert.deepEqual((await sync(db)).tasks, []);
  await assert.rejects(call(db, "join", { token }), (error) => error.code === "PT404");
  // Sharing again makes a new link.
  await as(db, owner);
  assert.notEqual((await call(db, "share")).token, token);
});

test("an owner with members cannot join another list; erase by a member only leaves", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  await as(db, stranger);
  const other = (await call(db, "share")).token;
  await as(db, owner);
  await assert.rejects(call(db, "join", { token: other }), (error) => error.code === "PT409");
  await as(db, friend);
  await call(db, "erase");
  await as(db, owner);
  const list = await sync(db);
  assert.deepEqual(titles(list), ["Task 1"]);
  assert.equal(list.shared, null);
  // The owner's erase empties the list and stops sharing.
  await as(db, friend);
  await call(db, "join", { token });
  await as(db, owner);
  await call(db, "erase");
  await as(db, friend);
  assert.deepEqual((await sync(db)).tasks, []);
  await assert.rejects(call(db, "join", { token }), (error) => error.code === "PT404");
});

test("a deleted shared task takes members' helper answers with it", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  await db.query(
    "insert into public.planner_helper_runs(user_id, task_id, kind, title, status) values ($1, $2, 'draft', 'Task 1', 'done')",
    [friend, id(1)],
  );
  await as(db, owner);
  await sync(db, { remove: [id(1)] });
  assert.equal((await db.query("select count(*)::int as n from public.planner_helper_runs")).rows[0].n, 0);
});

/** A stand-in for Supabase Realtime's send, recording each broadcast. */
async function recordBroadcasts(db) {
  await db.exec(`
    create schema if not exists realtime;
    create table realtime.sent (topic text, event text, private boolean);
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as 'insert into realtime.sent values (topic, event, private)';
    grant usage on schema realtime to public;
    grant insert on realtime.sent to public;
  `);
  return async () => {
    const rows = (await db.query("select topic, event, private from realtime.sent order by topic")).rows;
    await db.exec("delete from realtime.sent");
    return rows;
  };
}

test("a change to a shared list tells everyone in it, at once; other lists tell nobody", async () => {
  const db = await fixture();
  const sent = await recordBroadcasts(db);
  const token = await shared(db);
  // Not shared yet: nothing to tell.
  await sync(db, { save: [task(2)] });
  assert.deepEqual(await sent(), []);
  await as(db, friend);
  await call(db, "join", { token });
  await sent();
  await sync(db, { save: [task(3)] });
  assert.deepEqual(await sent(), [
    { topic: `list:${owner}`, event: "changed", private: true },
    { topic: `list:${friend}`, event: "changed", private: true },
  ]);
  // A tick and a delete tell them too; a sync that changes nothing does not.
  await sync(db, { save: [task(3, { done: true, doneAt: NOW + 50, updatedAt: NOW + 50 })] });
  assert.equal((await sent()).length, 2);
  await sync(db, { remove: [id(3)] });
  assert.equal((await sent()).length, 2);
  await sync(db);
  assert.deepEqual(await sent(), []);
  // A stranger's own list tells nobody.
  await as(db, stranger);
  await sync(db, { save: [task(9)] });
  assert.deepEqual(await sent(), []);
});

test("without Realtime, syncs carry on", async () => {
  const db = await fixture();
  const token = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  assert.deepEqual(titles(await sync(db, { save: [task(2)] })), ["Task 2", "Task 1"]);
});
