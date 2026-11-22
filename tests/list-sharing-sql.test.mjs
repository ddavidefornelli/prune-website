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
const spaces = (result) => result.spaces.map((s) => [s.kind, s.name, Number(s.people), s.owner]);

async function fixture({ until } = {}) {
  const db = await backendDb(until ? { until } : {});
  await db.query(
    "insert into auth.users(id, email) values ($1, 'owner@example.test'), ($2, 'friend@example.test'), ($3, 'stranger@example.test')",
    [owner, friend, stranger],
  );
  return db;
}

/** The owner shares Personal (with one task); returns the new group space and its link token. */
async function shared(db) {
  await as(db, owner);
  await sync(db, { save: [task(1)] });
  return call(db, "share");
}

test("everyone starts with Personal; sync without a space is Personal", async () => {
  const db = await fixture();
  await as(db, owner);
  const first = await sync(db, { save: [task(1)] });
  assert.deepEqual(spaces(first), [["personal", "", 1, true]]);
  assert.equal(first.spaces[0].id, owner);
  assert.deepEqual(titles(await sync(db, { space: owner })), ["Task 1"]);
});

test("sharing Personal makes a group space of its tasks and leaves Personal empty", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.notEqual(space, owner);
  const personal = await sync(db);
  assert.deepEqual(personal.tasks, []);
  assert.deepEqual(spaces(personal), [["personal", "", 1, true], ["group", "Shared list", 1, true]]);
  assert.deepEqual(titles(await sync(db, { space })), ["Task 1"]);
  // Sharing the group space again gives the same link.
  assert.deepEqual(await call(db, "share", { space }), { space, token });
  // A new Personal task stays personal.
  await sync(db, { save: [task(2)] });
  assert.deepEqual(titles(await sync(db, { space })), ["Task 1"]);
});

test("joining adds the group space and keeps the joiner's Personal apart", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  await as(db, friend);
  await sync(db, { save: [task(5)] });
  assert.deepEqual(await call(db, "join", { token: token.toUpperCase() }), { space });
  assert.deepEqual(titles(await sync(db)), ["Task 5"]);
  const group = await sync(db, { space, save: [task(3)] });
  assert.deepEqual(titles(group), ["Task 3", "Task 1"]);
  assert.deepEqual(spaces(group), [["personal", "", 1, true], ["group", "Shared list", 2, false]]);
  // Anyone in it renames it; everyone sees the name.
  await call(db, "rename", { space, name: "  Trip  " });
  await as(db, owner);
  const theirs = await sync(db, { space, remove: [id(3)] });
  assert.deepEqual(titles(theirs), ["Task 1"]);
  assert.deepEqual(spaces(theirs)[1], ["group", "Trip", 2, true]);
  // Joining again changes nothing.
  await as(db, friend);
  assert.deepEqual(await call(db, "join", { token }), { space });
  assert.equal(Number((await sync(db, { space })).spaces[1].people), 2);
});

test("guests cannot share or join; wrong links and other people's spaces are refused", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  await as(db, friend, { is_anonymous: true });
  await assert.rejects(call(db, "share"), (error) => error.code === "PT400");
  await assert.rejects(call(db, "join", { token }), (error) => error.code === "PT400");
  await as(db, friend);
  await assert.rejects(call(db, "join", { token: "0".repeat(32) }), (error) => error.code === "PT404");
  await assert.rejects(call(db, "join", {}), (error) => error.code === "PT404");
  // Without the link, the space cannot be read, written or renamed.
  await assert.rejects(sync(db, { space }), (error) => error.code === "PT404");
  await assert.rejects(sync(db, { space, save: [task(9)] }), (error) => error.code === "PT404");
  await assert.rejects(call(db, "rename", { space, name: "Mine" }), (error) => error.code === "PT404");
  // Nor another person's Personal.
  await assert.rejects(sync(db, { space: owner }), (error) => error.code === "PT404");
  await assert.rejects(sync(db, { space: "not-a-uuid" }), (error) => error.code === "PT400");
  await assert.rejects(call(db, "leave", { space: friend }), (error) => error.code === "PT400");
});

test("a member leaves; the owner deletes the space for everyone", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  assert.deepEqual(await call(db, "leave", { space }), { left: true });
  assert.deepEqual(spaces(await sync(db)), [["personal", "", 1, true]]);
  await as(db, owner);
  assert.deepEqual(titles(await sync(db, { space })), ["Task 1"]);
  await as(db, friend);
  await call(db, "join", { token });
  await as(db, owner);
  await call(db, "leave", { space });
  assert.equal((await db.query("select count(*)::int as n from public.planner_list_tasks")).rows[0].n, 0);
  await as(db, friend);
  await assert.rejects(sync(db, { space }), (error) => error.code === "PT404");
  await assert.rejects(call(db, "join", { token }), (error) => error.code === "PT404");
});

test("erase deletes the spaces one owns and leaves the others", async () => {
  const db = await fixture();
  const mine = await shared(db);
  await as(db, friend);
  await sync(db, { save: [task(5)] });
  await call(db, "join", { token: mine.token });
  const theirs = await call(db, "share");
  await as(db, owner);
  await call(db, "join", { token: theirs.token });
  await as(db, friend);
  await call(db, "erase");
  // The friend's space is gone; the owner's stays, without the friend.
  await as(db, owner);
  const after = await sync(db, { space: mine.space });
  assert.deepEqual(spaces(after), [["personal", "", 1, true], ["group", "Shared list", 1, true]]);
});

test("a deleted shared task takes everyone's helper answers with it", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  await db.query(
    "insert into public.planner_helper_runs(user_id, task_id, kind, title, status) values ($1, $2, 'draft', 'Task 1', 'done')",
    [friend, id(1)],
  );
  await as(db, owner);
  await sync(db, { space, remove: [id(1)] });
  assert.equal((await db.query("select count(*)::int as n from public.planner_helper_runs")).rows[0].n, 0);
});

test("shared lists from before spaces become group spaces with the same link and people", async () => {
  const db = await fixture({ until: "20261127000200_list_realtime.sql" });
  await as(db, owner);
  await call(db, "sync", { save: [task(1)] });
  const { token } = await call(db, "share");
  await as(db, friend);
  await call(db, "sync", { save: [task(5)] });
  await call(db, "join", { token });
  await as(db, stranger);
  await call(db, "sync", { save: [task(9)] });
  await db.exec((await import("./helpers/backend-db.mjs")).migration("20261128000100_spaces.sql"));

  await as(db, owner);
  const personal = await sync(db);
  assert.deepEqual(personal.tasks, []);
  const group = personal.spaces[1];
  assert.deepEqual([group.kind, group.name, Number(group.people), group.owner], ["group", "Shared list", 2, true]);
  // The friend's tasks had moved into the shared list when they joined.
  assert.deepEqual(titles(await sync(db, { space: group.id })), ["Task 5", "Task 1"]);
  await as(db, friend);
  assert.deepEqual(await call(db, "join", { token }), { space: group.id });
  await as(db, stranger);
  assert.deepEqual(titles(await sync(db)), ["Task 9"]);
});

/** A stand-in for Supabase Realtime's send, recording each broadcast. */
async function recordBroadcasts(db) {
  await db.exec(`
    create schema if not exists realtime;
    create table realtime.sent (topic text, event text, private boolean, payload jsonb);
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as 'insert into realtime.sent values (topic, event, private, payload)';
    grant usage on schema realtime to public;
    grant insert on realtime.sent to public;
  `);
  return async () => {
    const rows = (await db.query("select topic, event, private, payload->>'space' as space from realtime.sent order by topic")).rows;
    await db.exec("delete from realtime.sent");
    return rows;
  };
}

test("a change to a group space tells everyone in it, at once; Personal tells nobody", async () => {
  const db = await fixture();
  const sent = await recordBroadcasts(db);
  const { space, token } = await shared(db);
  await sync(db, { save: [task(2)] });
  assert.deepEqual(await sent(), []);
  await as(db, friend);
  await call(db, "join", { token });
  // Joining tells both (the count changed).
  assert.deepEqual((await sent()).map((row) => row.topic), [`list:${owner}`, `list:${friend}`]);
  await sync(db, { space, save: [task(3)] });
  assert.deepEqual(await sent(), [
    { topic: `list:${owner}`, event: "changed", private: true, space },
    { topic: `list:${friend}`, event: "changed", private: true, space },
  ]);
  await sync(db, { space, remove: [id(3)] });
  assert.equal((await sent()).length, 2);
  await sync(db, { space });
  assert.deepEqual(await sent(), []);
  await sync(db, { save: [task(9)] });
  assert.deepEqual(await sent(), []);
  // The owner deletes it: the friend hears, so it leaves their switcher.
  await as(db, owner);
  await call(db, "leave", { space });
  assert.ok((await sent()).some((row) => row.topic === `list:${friend}`));
});

test("without Realtime, syncs carry on", async () => {
  const db = await fixture();
  const { space, token } = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  assert.deepEqual(titles(await sync(db, { space, save: [task(2)] })), ["Task 2", "Task 1"]);
});

test("+ makes an empty group space with its link; Personal stays as it was", async () => {
  const db = await fixture();
  await as(db, owner);
  await sync(db, { save: [task(1)] });
  const { space, token } = await call(db, "create", { name: "  Flat  " });
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.deepEqual((await sync(db, { space })).tasks, []);
  const personal = await sync(db);
  assert.deepEqual(titles(personal), ["Task 1"]);
  assert.deepEqual(spaces(personal), [["personal", "", 1, true], ["group", "Flat", 1, true]]);
  assert.equal((await call(db, "create")).space === space, false);
  assert.equal(spaces(await sync(db))[2][1], "Shared list");
  // Others join it by its link, as any group space.
  await as(db, friend);
  assert.deepEqual(await call(db, "join", { token }), { space });
  // Guests make no spaces.
  await as(db, stranger, { is_anonymous: true });
  await assert.rejects(call(db, "create", { name: "Mine" }), (error) => error.code === "PT400");
});

test("people in a space see each other's names and emails; nobody else does", async () => {
  const db = await fixture();
  await db.query(`update auth.users set raw_user_meta_data = '{"full_name": "Ana Owner"}' where id = $1`, [owner]);
  const { space, token } = await shared(db);
  await as(db, friend);
  await call(db, "join", { token });
  const { people } = await call(db, "people", { space });
  assert.deepEqual(people, [
    { name: "Ana Owner", email: "owner@example.test", owner: true, you: false },
    { name: null, email: "friend@example.test", owner: false, you: true },
  ]);
  // Personal: just the caller.
  assert.deepEqual((await call(db, "people")).people.map((p) => p.email), ["friend@example.test"]);
  await as(db, stranger);
  await assert.rejects(call(db, "people", { space }), (error) => error.code === "PT404");
});
