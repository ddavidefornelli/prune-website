import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const sync = async (db, args = {}, timezone = "UTC") =>
  (await db.query("select public.planner_list('sync', $1::jsonb, $2) as result", [JSON.stringify(args), timezone])).rows[0].result;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.now();
const task = (n, fields = {}) => ({ id: id(n), title: `Task ${n}`, done: false, createdAt: NOW + n, updatedAt: NOW + n, doneAt: null, ...fields });

/** The hosted schema after every migration, with two users. */
async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email) values ($1, 'owner@example.test'), ($2, 'other@example.test')", [owner, other]);
  await as(db, owner);
  return db;
}

test("a sync saves new tasks and returns the whole list, newest first", async () => {
  const db = await fixture();
  const result = await sync(db, { save: [task(1), task(2, { title: "  Call Ana  " })] });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(
    result.tasks.map((t) => [t.id, t.title, t.done]),
    [
      [id(2), "Call Ana", false],
      [id(1), "Task 1", false],
    ],
  );
  assert.equal(result.tasks[1].createdAt, NOW + 1);
  assert.equal(result.tasks[1].doneAt, null);
  // A sync with nothing to send reads the list back.
  assert.equal((await sync(db)).tasks.length, 2);
});

test("the newest edit wins and an older or repeated edit changes nothing", async () => {
  const db = await fixture();
  await sync(db, { save: [task(1)] });
  const done = task(1, { title: "Renamed", done: true, updatedAt: NOW + 100, doneAt: NOW + 100 });
  await sync(db, { save: [done] });
  // An offline device sends an edit it made before the one above.
  const stale = await sync(db, { save: [task(1, { title: "Stale", updatedAt: NOW + 50 })] });
  assert.deepEqual(
    stale.tasks.map((t) => [t.title, t.done, t.doneAt]),
    [["Renamed", true, NOW + 100]],
  );
  // Sending the same change twice is harmless.
  const again = await sync(db, { save: [done] });
  assert.deepEqual(again.tasks, stale.tasks);
  // Undone again later: done_at clears with it.
  const undone = await sync(db, { save: [task(1, { title: "Renamed", updatedAt: NOW + 200 })] });
  assert.deepEqual(
    undone.tasks.map((t) => [t.done, t.doneAt]),
    [[false, null]],
  );
});

test("removing is idempotent and never reaches another account's tasks", async () => {
  const db = await fixture();
  await sync(db, { save: [task(1), task(2)] });
  await as(db, other);
  await sync(db, { save: [task(3)] });
  // Another account cannot remove (or read) the owner's tasks by id.
  const theirs = await sync(db, { remove: [id(1), id(2)] });
  assert.deepEqual(theirs.tasks.map((t) => t.id), [id(3)]);
  await as(db, owner);
  assert.deepEqual((await sync(db, { remove: [id(1)] })).tasks.map((t) => t.id), [id(2)]);
  assert.deepEqual((await sync(db, { remove: [id(1)] })).tasks.map((t) => t.id), [id(2)]);
});

test("signed-out callers are refused; guests use the list without any reminder record", async () => {
  const db = await fixture();
  await as(db, null);
  await assert.rejects(sync(db), (error) => error.code === "PT401");
  // A guest: Supabase's anonymous user, with no email.
  await as(db, owner, { is_anonymous: true });
  const saved = await sync(db, { save: [task(1)] });
  assert.deepEqual(saved.tasks.map((t) => t.title), ["Task 1"]);
  assert.equal((await db.query("select count(*)::int as n from public.planner_email_reminders where user_id = $1", [owner])).rows[0].n, 0);
  await as(db, owner);
  await assert.rejects(
    db.query("select public.planner_list('dashboard', '{}'::jsonb, 'UTC')"),
    (error) => error.code === "PT400",
  );
});

test("erase deletes the caller's whole list, and nobody else's", async () => {
  const db = await fixture();
  await as(db, other, { is_anonymous: true });
  await sync(db, { save: [task(9)] });
  await as(db, owner, { is_anonymous: true });
  await sync(db, { save: [task(1), task(2, { done: true, doneAt: NOW })] });
  const erased = (await db.query("select public.planner_list('erase', '{}'::jsonb, 'UTC') as result")).rows[0].result;
  assert.deepEqual(erased, { tasks: [], rejected: [] });
  assert.deepEqual((await sync(db)).tasks, []);
  await as(db, other, { is_anonymous: true });
  assert.deepEqual((await sync(db)).tasks.map((t) => t.id), [id(9)]);
});

test("a deleted account refuses sessions from before the deletion, and a new sign-in restores it", async () => {
  const db = await fixture();
  // A sync that nothing refuses: the account is usable.
  const status = async () => ((await sync(db)) ? { isDeleted: false } : null);
  const signedInAt = (seconds) => as(db, owner, { amr: [{ method: "oauth", timestamp: seconds }] });
  const now = Math.floor(Date.now() / 1000);
  await signedInAt(now - 3600);
  assert.deepEqual(await status(), { isDeleted: false });
  await sync(db, { save: [task(1)] });
  await db.query(`update public.planner_accounts set "isDeleted" = true, deleted_at = now() where user_id = $1`, [owner]);
  // Another device, still signed in from before: refused, even after a token refresh.
  await assert.rejects(status(), (error) => error.code === "PT403");
  await assert.rejects(sync(db, { save: [task(2)] }), (error) => error.code === "PT403");
  await as(db, owner, { iat: now + 600, amr: [{ method: "oauth", timestamp: now - 3600 }] });
  await assert.rejects(status(), (error) => error.code === "PT403");
  // Signing in again cancels the deletion, and the list is as it was.
  await signedInAt(now + 5);
  assert.deepEqual(await status(), { isDeleted: false });
  assert.deepEqual((await sync(db)).tasks.map((t) => t.id), [id(1)]);
  const row = (await db.query(`select "isDeleted", deleted_at from public.planner_accounts where user_id = $1`, [owner])).rows[0];
  assert.deepEqual(row, { isDeleted: false, deleted_at: null });
  // A token without sign-in times falls back to when it was issued.
  await db.query(`update public.planner_accounts set "isDeleted" = true, deleted_at = now() where user_id = $1`, [owner]);
  await as(db, owner, { iat: now - 10 });
  await assert.rejects(status(), (error) => error.code === "PT403");
  await as(db, owner, { iat: now + 5 });
  assert.deepEqual(await status(), { isDeleted: false });
});

test("malformed changes are refused and nothing in the same sync is saved", async () => {
  const db = await fixture();
  for (const args of [
    { save: [task(1), { ...task(2), title: "   " }] },
    { save: [task(1), { ...task(2), title: "x".repeat(501) }] },
    { save: [task(1), { ...task(2), id: "not-a-uuid" }] },
    { save: [task(1), { ...task(2), done: "yes" }] },
    { save: [task(1), { ...task(2), updatedAt: "soon" }] },
    { save: [task(1)], remove: ["1; drop table public.planner_list_tasks"] },
    { save: Array.from({ length: 201 }, (_, n) => task(n)) },
    { save: "everything" },
  ])
    await assert.rejects(sync(db, args), (error) => error.code === "PT400", JSON.stringify(args).slice(0, 80));
  assert.deepEqual((await sync(db)).tasks, []);
  for (const action of ["wipe", "status"])
    await assert.rejects(
      db.query("select public.planner_list($1, '{}'::jsonb, 'UTC')", [action]),
      (error) => error.code === "PT400",
      action,
    );
});

test("a full list drops its oldest done task for a new one, and keeps open tasks", async () => {
  const db = await fixture();
  await db.query(
    `insert into public.planner_list_tasks(user_id, id, title, done, created_at, updated_at, done_at)
     select $1, gen_random_uuid(), 'Open ' || n, false, now(), now(), null from generate_series(1, 998) n`,
    [owner],
  );
  await sync(db, { save: [task(1, { done: true, doneAt: NOW - 5000 }), task(2, { done: true, doneAt: NOW - 1000 })] });
  const full = await sync(db, { save: [task(3)] });
  assert.deepEqual(full.rejected, []);
  assert.equal(full.tasks.length, 1000);
  const ids = new Set(full.tasks.map((t) => t.id));
  assert.ok(!ids.has(id(1)), "the oldest done task made room");
  assert.ok(ids.has(id(2)) && ids.has(id(3)));
  // Only open tasks left to drop besides the newest done one: room once more, then none.
  assert.deepEqual((await sync(db, { save: [task(4)] })).rejected, []);
  const refused = await sync(db, { save: [task(5)] });
  assert.deepEqual(refused.rejected, [id(5)]);
  assert.equal(refused.tasks.length, 1000);
  // Edits to tasks already on the list still go through.
  const renamed = await sync(db, { save: [task(4, { title: "Still editable", updatedAt: NOW + 999 })] });
  assert.equal(renamed.tasks.find((t) => t.id === id(4)).title, "Still editable");
});

test("a clock running ahead cannot claim the future", async () => {
  const db = await fixture();
  const far = Date.now() + 365 * 86_400_000;
  const saved = (await sync(db, { save: [task(1, { createdAt: far, updatedAt: far })] })).tasks[0];
  assert.ok(saved.updatedAt <= Date.now() + 61_000);
  assert.ok(saved.createdAt <= Date.now() + 61_000);
  // A correct device's edit a few minutes later still wins.
  const later = await sync(db, { save: [task(1, { title: "Fixed clock", updatedAt: Date.now() + 120_000 })] });
  assert.equal(later.tasks[0].title, "Fixed clock");
});

test("a sync counts as a visit for reminder emails and remembers a known time zone", async () => {
  const db = await fixture();
  await db.query(`insert into public.planner_accounts(user_id) values ($1)`, [owner]);
  await db.query(`insert into public.planner_email_reminders(user_id, timezone, last_seen_at, comebacks_sent) values ($1, 'UTC', now() - interval '9 days', 2)`, [owner]);
  await sync(db, {}, "Europe/Rome");
  const row = (await db.query(`select timezone, last_seen_at > now() - interval '1 minute' as fresh, comebacks_sent from public.planner_email_reminders where user_id = $1`, [owner])).rows[0];
  assert.deepEqual(row, { timezone: "Europe/Rome", fresh: true, comebacks_sent: 0 });
  await sync(db, {}, "Not/A_Zone");
  assert.equal((await db.query(`select timezone from public.planner_email_reminders where user_id = $1`, [owner])).rows[0].timezone, "Europe/Rome");
});

test("browsers can only reach the list through planner_list", async () => {
  const db = await fixture();
  const privileges = (
    await db.query(`select has_table_privilege('authenticated', 'public.planner_list_tasks', 'select,insert,update,delete') as table_access,
      has_function_privilege('authenticated', 'public.planner_list(text, jsonb, text)', 'execute') as signed_in,
      has_function_privilege('anon', 'public.planner_list(text, jsonb, text)', 'execute') as signed_out`)
  ).rows[0];
  assert.deepEqual(privileges, { table_access: false, signed_in: true, signed_out: false });
});
