import assert from "node:assert/strict";
import { test } from "node:test";
import { as, backendDb } from "./helpers/backend-db.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const claim = async (db, now, limit = 100) =>
  (await db.query("select * from public.planner_claim_reminders($1, $2::timestamptz) order by email", [limit, now])).rows;
const who = (rows) => rows.map((row) => [row.email.split("@")[0], row.kind]);
const seen = (db, user, iso) => db.query("update public.planner_email_reminders set last_seen_at = $2 where user_id = $1", [user, iso]);
const token = async (db, user) =>
  (await db.query("select unsubscribe_token from public.planner_email_reminders where user_id = $1", [user])).rows[0].unsubscribe_token;
const unsubscribe = async (db, value, kind) => (await db.query("select public.planner_unsubscribe($1, $2) as ok", [value, kind])).rows[0].ok;

/** Two accounts from before guests, both last seen on 2026-11-01. */
async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email) values ($1, 'owner@example.test'), ($2, 'other@example.test')", [owner, other]);
  await db.query("insert into public.planner_accounts(user_id) values ($1), ($2)", [owner, other]);
  await db.query("insert into public.planner_email_reminders(user_id, timezone, last_seen_at) values ($1, 'UTC', '2026-11-01T20:00:00Z'), ($2, 'UTC', '2026-11-01T20:00:00Z')", [owner, other]);
  return db;
}

test("the come-back email goes after a week away, in the morning, once a week and four times at most", async () => {
  const db = await fixture();
  try {
    await seen(db, owner, "2026-11-08T20:00:00Z");
    assert.deepEqual(await claim(db, "2026-11-13T15:05:00Z"), [], "outside the morning window");
    assert.deepEqual(who(await claim(db, "2026-11-13T09:05:00Z")), [["other", "comeback"]], "five days away is not enough");
    assert.deepEqual(await claim(db, "2026-11-14T09:05:00Z"), [], "not again the next day");
    const theirs = async (day) => (await claim(db, `${day}T09:05:00Z`)).filter((row) => row.email.startsWith("other"));
    for (const day of ["2026-11-20", "2026-11-27", "2026-12-04"]) assert.equal((await theirs(day)).length, 1, day);
    assert.deepEqual(await theirs("2026-12-11"), [], "capped at four in a row");
  } finally {
    await db.close();
  }
});

test("coming back resets the count; guests never get a reminder record", async () => {
  const db = await fixture();
  try {
    for (const day of ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"]) await claim(db, `${day}T09:05:00Z`);
    assert.deepEqual(await claim(db, "2026-12-11T09:05:00Z"), []);
    await as(db, owner);
    await db.query("select public.planner_list('sync', '{}'::jsonb, 'Europe/Rome')");
    assert.deepEqual((await db.query("select comebacks_sent, timezone from public.planner_email_reminders where user_id = $1", [owner])).rows[0], { comebacks_sent: 0, timezone: "Europe/Rome" });
    const guest = "33333333-3333-4333-8333-333333333333";
    await db.query("insert into auth.users(id, is_anonymous) values ($1, true)", [guest]);
    await as(db, guest, { is_anonymous: true });
    await db.query("select public.planner_list('sync', '{}'::jsonb, 'UTC')");
    assert.equal((await db.query("select count(*)::int as n from public.planner_email_reminders where user_id = $1", [guest])).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("the focus time chosen in the day planner still sets the window, and weekdays only still skips weekends", async () => {
  const db = await fixture();
  try {
    await db.query("update public.planner_email_reminders set focus_minute = 19 * 60, weekdays_only = true where user_id = $1", [owner]);
    // Friday 13 November: 09:05 is too early for a 19:00 focus time; 19:05 is in it.
    assert.deepEqual(who(await claim(db, "2026-11-13T09:05:00Z")), [["other", "comeback"]]);
    assert.deepEqual(who(await claim(db, "2026-11-13T19:05:00Z")), [["owner", "comeback"]]);
    await db.query("update public.planner_email_reminders set last_comeback_at = null, comebacks_sent = 0 where user_id = $1", [owner]);
    assert.deepEqual(await claim(db, "2026-11-14T19:05:00Z"), [], "Saturday");
  } finally {
    await db.close();
  }
});

test("turned off, or a deleted account: no come-back email", async () => {
  const db = await fixture();
  try {
    await db.query("update public.planner_email_reminders set comeback_enabled = false where user_id = $1", [owner]);
    await db.query(`update public.planner_accounts set "isDeleted" = true, deleted_at = now() where user_id = $1`, [other]);
    assert.deepEqual(await claim(db, "2026-11-13T09:05:00Z"), []);
  } finally {
    await db.close();
  }
});

test("a lost race claims nothing twice; the batch limit holds; a released claim goes out next run", async () => {
  const db = await fixture();
  try {
    const [first, second] = await Promise.all([claim(db, "2026-11-13T09:05:00Z", 1), claim(db, "2026-11-13T09:06:00Z", 1)]);
    assert.equal(first.length + second.length, 2);
    assert.deepEqual(await claim(db, "2026-11-13T09:07:00Z"), []);
    await db.query("select public.planner_release_reminder($1, 'comeback')", [owner]);
    await db.query("select public.planner_release_reminder($1, 'daily')", [other]);
    assert.deepEqual(who(await claim(db, "2026-11-13T10:05:00Z")), [["owner", "comeback"]]);
  } finally {
    await db.close();
  }
});

test("an unsubscribe link turns the come-back email off; the day planner's old links answer and change nothing", async () => {
  const db = await fixture();
  try {
    const mine = await token(db, owner);
    for (const kind of ["daily", "session"]) assert.equal(await unsubscribe(db, mine, kind), true, kind);
    assert.equal(await unsubscribe(db, mine, "everything"), false);
    assert.equal(await unsubscribe(db, other, "comeback"), false, "a user id is not a token");
    assert.deepEqual((await db.query("select comeback_enabled from public.planner_email_reminders order by user_id")).rows.map((row) => row.comeback_enabled), [true, true]);
    assert.equal(await unsubscribe(db, mine, "comeback"), true);
    assert.deepEqual((await db.query("select comeback_enabled from public.planner_email_reminders order by user_id")).rows.map((row) => row.comeback_enabled), [false, true]);
  } finally {
    await db.close();
  }
});

test("browsers cannot reach the reminder functions or table", async () => {
  const db = await fixture();
  try {
    for (const fn of ["planner_claim_reminders(integer, timestamptz)", "planner_release_reminder(uuid, text)", "planner_unsubscribe(uuid, text)", "planner_push_targets(uuid[])", "planner_push_result(text, text)"])
      for (const role of ["anon", "authenticated"])
        assert.equal((await db.query(`select has_function_privilege('${role}', 'public.${fn}', 'execute') as ok`)).rows[0].ok, false, `${role} ${fn}`);
    for (const table of ["planner_email_reminders", "planner_push_subscriptions"])
      assert.equal((await db.query(`select has_table_privilege('authenticated', 'public.${table}', 'select') as ok`)).rows[0].ok, false, table);
  } finally {
    await db.close();
  }
});
