import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb, migration, RETIREMENT } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const started = "22222222-2222-4222-8222-222222222222";
const deleted = "33333333-3333-4333-8333-333333333333";
const guest = "44444444-4444-4444-8444-444444444444";
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const RETIRED_TABLES = ["planner_tasks", "planner_stops", "planner_reviews", "planner_receipts", "planner_review_tasks", "planner_history", "planner_suggestion_usage", "ai_controls", "ai_usage", "ai_review_requests"];
const KEPT_TABLES = ["error_log", "planner_accounts", "planner_email_reminders", "planner_list_tasks", "planner_push_subscriptions"];
const KEPT_FUNCTIONS = ["log_client_error", "planner_call", "planner_claim_reminders", "planner_list", "planner_push_result", "planner_push_targets", "planner_release_reminder", "planner_unsubscribe"];

/** The hosted schema just before the retirement, with day planner data in it. */
async function beforeRetirement() {
  const db = await backendDb({ until: "20261124000200_comeback_reminders_only.sql" });
  await db.query(
    `insert into auth.users(id, email, is_anonymous) values
      ($1, 'owner@example.test', false), ($2, 'started@example.test', false), ($3, 'deleted@example.test', false), ($4, null, true)`,
    [owner, started, deleted, guest],
  );
  await db.query(`insert into public.planner_accounts(user_id) values ($1), ($2), ($3), ($4)`, [owner, started, deleted, guest]);
  await db.query(`update public.planner_accounts set list_started_at = now() where user_id = $1`, [started]);
  await db.query(`update public.planner_accounts set "isDeleted" = true, deleted_at = now() where user_id = $1`, [deleted]);
  await db.query(`insert into public.planner_email_reminders(user_id, timezone) values ($1, 'UTC'), ($2, 'UTC')`, [owner, started]);
  const add = (user, planned, status, outcome, slot, createdAt = 1_700_000_000) =>
    db.query(
      `insert into public.planner_tasks(user_id, outcome, planned_for, status, slot, created_at, completed_on)
       values ($1, $2, $3::date, $4, $5, $6, case when $4 = 'completed' then $3::date end) returning id`,
      [user, outcome, planned, status, slot, createdAt],
    );
  await add(owner, day(0), "planned", "  Write report  ", 1, 1_700_000_000);
  await add(owner, day(0), "active", "Call Ana", 2, 1_700_000_100);
  await add(owner, day(1), "planned", "Book flights", 1, 1_700_000_200);
  const done = await add(owner, day(0), "completed", "Already done", 3);
  await add(owner, day(-1), "planned", "Missed yesterday", 1);
  await add(owner, day(0), "planned", "   ", 4);
  await add(started, day(0), "planned", "Already in the list", 1);
  await add(deleted, day(0), "planned", "Deleted account's", 1);
  await db.query(`insert into public.planner_stops(user_id, task_id, reason) values ($1, $2, 'distracted')`, [owner, done.rows[0].id]);
  await db.query(`insert into public.planner_reviews(user_id, week_start, report) values ($1, $2, '{}')`, [owner, day(-7)]);
  await db.query(`insert into public.planner_receipts(user_id, mutation_id, result) values ($1, gen_random_uuid(), '{}')`, [owner]);
  return db;
}

const listOf = async (db, user) =>
  (await db.query(`select title, done, floor(extract(epoch from created_at))::bigint as created from public.planner_list_tasks where user_id = $1 order by created_at desc`, [user])).rows;
const names = async (db, sql) => (await db.query(sql)).rows.map((row) => row.name).sort();
const tables = (db) => names(db, `select tablename as name from pg_catalog.pg_tables where schemaname = 'public'`);
const functions = (db) =>
  names(db, `select p.proname as name from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
const columns = async (db, table) =>
  (await db.query(`select column_name as name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])).rows.map((row) => row.name);

test("open planner tasks move into the list before the day planner's tables go", async () => {
  const db = await beforeRetirement();
  await db.exec(migration(RETIREMENT));
  assert.deepEqual(await listOf(db, owner), [
    { title: "Book flights", done: false, created: 1_700_000_200 },
    { title: "Call Ana", done: false, created: 1_700_000_100 },
    { title: "Write report", done: false, created: 1_700_000_000 },
  ]);
  // Already copied by its first sync, or deleted: nothing more.
  assert.deepEqual(await listOf(db, started), []);
  assert.deepEqual(await listOf(db, deleted), []);
  // The list carries on from there, and copies nothing a second time.
  await as(db, owner);
  const synced = (await db.query("select public.planner_list('sync', '{}'::jsonb, 'UTC') as r")).rows[0].r;
  assert.deepEqual(synced.tasks.map((t) => t.title), ["Book flights", "Call Ana", "Write report"]);
});

test("only the list, accounts, come-back emails, push and the error log are left", async () => {
  const db = await beforeRetirement();
  await db.exec(migration(RETIREMENT));
  assert.deepEqual(await tables(db), KEPT_TABLES);
  assert.deepEqual(await functions(db), KEPT_FUNCTIONS);
  for (const table of RETIRED_TABLES) assert.equal((await db.query("select to_regclass($1) as r", [`public.${table}`])).rows[0].r, null, table);
  assert.deepEqual(await columns(db, "planner_accounts"), ["user_id", "isDeleted", "deleted_at"]);
  assert.deepEqual(await columns(db, "planner_email_reminders"), [
    "user_id", "timezone", "last_seen_at", "comeback_enabled", "unsubscribe_token", "last_comeback_at", "comebacks_sent", "weekdays_only", "focus_minute",
  ]);
  const grants = (
    await db.query(`select
      has_function_privilege('authenticated', 'public.planner_list(text,jsonb,text)', 'execute') as list,
      has_function_privilege('authenticated', 'public.planner_call(text,jsonb,text)', 'execute') as call,
      has_function_privilege('anon', 'public.planner_call(text,jsonb,text)', 'execute') as anon_call,
      has_function_privilege('authenticated', 'public.planner_claim_reminders(integer,timestamptz)', 'execute') as claim,
      has_function_privilege('service_role', 'public.planner_claim_reminders(integer,timestamptz)', 'execute') as job`)
  ).rows[0];
  assert.deepEqual(grants, { list: true, call: true, anon_call: false, claim: false, job: true });
});

test("planner_call only deletes an account from before guests, and only once", async () => {
  const db = await beforeRetirement();
  await db.exec(migration(RETIREMENT));
  const call = async (action) => (await db.query("select public.planner_call($1, '{}'::jsonb, 'UTC') as r", [action])).rows[0].r;
  const deletedAt = async () => (await db.query(`select deleted_at from public.planner_accounts where user_id = $1`, [owner])).rows[0].deleted_at;
  await as(db, null);
  await assert.rejects(call("delete_account"), (error) => error.code === "PT401");
  await as(db, guest, { is_anonymous: true });
  await assert.rejects(call("delete_account"), (error) => error.code === "PT401");
  await as(db, owner);
  for (const action of ["dashboard", "add_task", "account_status", "set_email_preferences"])
    await assert.rejects(call(action), (error) => error.code === "PT400", action);
  assert.deepEqual(await call("delete_account"), { isDeleted: true });
  const first = await deletedAt();
  assert.ok(first);
  assert.deepEqual(await call("delete_account"), { isDeleted: true });
  assert.deepEqual(await deletedAt(), first, "a retry never restarts the 30 days");
});

test("anything unknown still depending on a retired table stops the migration, which changes nothing", async () => {
  const db = await beforeRetirement();
  await db.exec("create view public.old_reviews as select * from public.planner_reviews");
  await assert.rejects(db.exec(migration(RETIREMENT)), /depend/);
  await db.exec("rollback");
  assert.ok((await tables(db)).includes("planner_tasks"));
  assert.ok((await functions(db)).includes("planner_execute"));
  assert.deepEqual(await listOf(db, owner), []);
});
