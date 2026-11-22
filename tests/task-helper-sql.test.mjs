import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const guest = "33333333-3333-4333-8333-333333333333";
const member = "11111111-1111-4111-8111-111111111111";
const claim = async (db, user, isGuest, kind) =>
  (await db.query("select public.planner_helper_claim($1, $2, $3) as result", [user, isGuest, kind])).rows[0].result;

async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email) values ($1, null), ($2, 'member@example.test')", [guest, member]);
  return db;
}

test("a guest gets three answers, then is asked to sign in; refines and calls are not counted against them", async () => {
  const db = await fixture();
  for (let n = 0; n < 3; n++) assert.equal(await claim(db, guest, true, "start"), "ok");
  assert.equal(await claim(db, guest, true, "refine"), "ok");
  assert.equal(await claim(db, guest, true, "call"), "ok");
  assert.equal(await claim(db, guest, true, "start"), "sign_in");
  // Signed in (the same user no longer anonymous), answers are counted per day only.
  assert.equal(await claim(db, guest, false, "start"), "ok");
});

test("everyone gets 30 answers and refines, and 300 calls, a day; a new day starts over", async () => {
  const db = await fixture();
  for (let n = 0; n < 30; n++) assert.equal(await claim(db, member, false, n % 2 ? "refine" : "start"), "ok");
  assert.equal(await claim(db, member, false, "start"), "daily_limit");
  assert.equal(await claim(db, member, false, "refine"), "daily_limit");
  assert.equal(await claim(db, member, false, "call"), "ok");
  await db.query("update public.planner_helper_usage set day_calls = 300 where user_id = $1", [member]);
  assert.equal(await claim(db, member, false, "call"), "daily_limit");
  await db.query("update public.planner_helper_usage set day = day - 1 where user_id = $1", [member]);
  assert.equal(await claim(db, member, false, "start"), "ok");
  assert.equal(await claim(db, member, false, "call"), "ok");
});

test("an unknown claim is refused, and runs go with their user", async () => {
  const db = await fixture();
  await assert.rejects(claim(db, member, false, "everything"), /Unsupported helper claim/);
  await db.query(
    "insert into public.planner_helper_runs(user_id, task_id, title, status) values ($1, '00000000-0000-4000-8000-000000000001', 'Write the bio', 'working')",
    [member],
  );
  await claim(db, member, false, "start");
  await db.query("delete from auth.users where id = $1", [member]);
  assert.equal((await db.query("select count(*)::int as n from public.planner_helper_runs")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from public.planner_helper_usage")).rows[0].n, 0);
});

test("the browser roles cannot reach the helper's tables or its claim", async () => {
  const db = await fixture();
  for (const role of ["anon", "authenticated"]) {
    const { rows } = await db.query(
      `select has_table_privilege($1, 'public.planner_helper_runs', 'select') as runs,
              has_table_privilege($1, 'public.planner_helper_usage', 'select') as usage,
              has_function_privilege($1, 'public.planner_helper_claim(uuid, boolean, text)', 'execute') as claim`,
      [role],
    );
    assert.deepEqual(rows[0], { runs: false, usage: false, claim: false });
  }
});

test("deleting a task from the list deletes its answer", async () => {
  const db = await fixture();
  const task = "00000000-0000-4000-8000-000000000007";
  await as(db, member);
  const at = Date.now();
  await db.query("select public.planner_list('sync', $1::jsonb, 'UTC')", [JSON.stringify({ save: [{ id: task, title: "Write the bio", done: false, createdAt: at, updatedAt: at, doneAt: null }] })]);
  await db.query("insert into public.planner_helper_runs(user_id, task_id, title, status) values ($1, $2, 'Write the bio', 'done')", [member, task]);
  await db.query("select public.planner_list('sync', $1::jsonb, 'UTC')", [JSON.stringify({ remove: [task] })]);
  assert.equal((await db.query("select count(*)::int as n from public.planner_helper_runs")).rows[0].n, 0);
});
