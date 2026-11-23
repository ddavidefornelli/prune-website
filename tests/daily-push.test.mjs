import assert from "node:assert/strict";
import { test } from "node:test";
import { DailyNudges, DailyPushJob } from "../server/reminders/daily-push.ts";
import { ReminderJob } from "../server/reminders/handler.ts";
import { as, backendDb } from "./helpers/backend-db.mjs";

const guest = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
const endpoint = (n) => `https://push.example.test/${n}`;
const call = async (db, action, args, timezone = "Europe/Rome") =>
  (await db.query("select public.planner_call($1, $2::jsonb, $3) as result", [action, JSON.stringify(args), timezone])).rows[0].result;
const claim = async (db, at) =>
  (await db.query("select endpoint, timezone from public.planner_claim_daily_pushes(500, $1::timestamptz) order by endpoint", [at])).rows;

async function fixture() {
  const db = await backendDb();
  await db.query("insert into auth.users(id, email, is_anonymous) values ($1, null, true), ($2, 'member@example.test', false)", [guest, member]);
  return db;
}

test("guests and accounts store this browser's subscription; bad ones are refused", async () => {
  const db = await fixture();
  await as(db, guest, { is_anonymous: true });
  assert.deepEqual(await call(db, "save_push", { endpoint: endpoint(1), ...keys }), { push: true });
  await assert.rejects(call(db, "save_push", { endpoint: "http://insecure", ...keys }), (e) => e.code === "PT400");
  await assert.rejects(call(db, "save_push", { endpoint: endpoint(2), p256dh: "short", auth: keys.auth }), (e) => e.code === "PT400");
  // A guest still cannot delete an account.
  await assert.rejects(call(db, "delete_account", {}), (e) => e.code === "PT401");
  // The same browser signing in moves to the account.
  await as(db, member);
  await call(db, "save_push", { endpoint: endpoint(1), ...keys });
  const rows = (await db.query("select user_id, timezone from public.planner_push_subscriptions")).rows;
  assert.deepEqual(rows, [{ user_id: member, timezone: "Europe/Rome" }]);
  // Nobody else can remove it.
  await as(db, guest, { is_anonymous: true });
  await call(db, "remove_push", { endpoint: endpoint(1) });
  assert.equal((await db.query("select count(*)::int as n from public.planner_push_subscriptions")).rows[0].n, 1);
  await as(db, member);
  await call(db, "remove_push", { endpoint: endpoint(1) });
  assert.equal((await db.query("select count(*)::int as n from public.planner_push_subscriptions")).rows[0].n, 0);
});

test("one notification a day at 10:00 local, not on days prune was opened, none after 30 days away", async () => {
  const db = await fixture();
  await as(db, guest, { is_anonymous: true });
  await call(db, "save_push", { endpoint: endpoint(1), ...keys });
  await call(db, "save_push", { endpoint: endpoint(2), ...keys }, "America/New_York");
  // Both last opened prune two days ago.
  await db.query("update public.planner_push_subscriptions set last_seen_at = '2026-11-21 12:00Z'");
  // 09:30 in Rome: too early for both.
  assert.deepEqual(await claim(db, "2026-11-23 08:30Z"), []);
  // 10:05 in Rome (04:05 in New York).
  assert.deepEqual(await claim(db, "2026-11-23 09:05Z"), [{ endpoint: endpoint(1), timezone: "Europe/Rome" }]);
  // Once a day: the next run in the same hour claims nothing.
  assert.deepEqual(await claim(db, "2026-11-23 09:55Z"), []);
  // 10:05 in New York.
  assert.deepEqual(await claim(db, "2026-11-23 15:05Z"), [{ endpoint: endpoint(2), timezone: "America/New_York" }]);
  // Opened today in Rome before 10:00: nothing that day.
  await db.query("update public.planner_push_subscriptions set last_seen_at = '2026-11-24 07:00Z' where endpoint = $1", [endpoint(1)]);
  assert.deepEqual(await claim(db, "2026-11-24 09:05Z"), []);
  assert.equal((await claim(db, "2026-11-25 09:05Z")).length, 1);
  // Away for more than 30 days: no more.
  assert.deepEqual(await claim(db, "2026-12-30 09:05Z"), []);
});

test("a deleted account's browsers get nothing, and browsers cannot claim", async () => {
  const db = await fixture();
  await as(db, member);
  await call(db, "save_push", { endpoint: endpoint(1), ...keys });
  await db.query("update public.planner_push_subscriptions set last_seen_at = '2026-11-21 12:00Z'");
  await call(db, "delete_account", {});
  assert.deepEqual(await claim(db, "2026-11-23 09:05Z"), []);
  assert.deepEqual(await call(db, "save_push", { endpoint: endpoint(1), ...keys }), { push: false });
  const privileges = (await db.query(`select has_function_privilege('authenticated', 'public.planner_claim_daily_pushes(integer, timestamptz)', 'execute') as claim`)).rows[0];
  assert.deepEqual(privileges, { claim: false });
});

test("each day has a mood line, the same everywhere that day, with no task content", () => {
  const monday = DailyNudges.payload("https://www.prune.win", new Date("2026-11-23T09:05:00Z"), "Europe/Rome");
  const tuesday = DailyNudges.payload("https://www.prune.win", new Date("2026-11-24T09:05:00Z"), "Europe/Rome");
  assert.notEqual(monday.title, tuesday.title);
  assert.equal(monday.url, "https://www.prune.win");
  assert.equal(monday.tag, "prune-daily");
  // An unknown zone falls back to UTC.
  assert.ok(DailyNudges.payload("https://x.test", new Date(), "Not/A_Zone").title);
  for (const nudge of DailyNudges.all) assert.ok(nudge.title.endsWith("?") && nudge.title.length <= 60);
});

test("the job sends to every claimed browser and records each result", async () => {
  const recorded = [];
  const job = new DailyPushJob({
    siteUrl: "https://www.prune.win",
    claim: async () => [1, 2, 3].map((n) => ({ endpoint: endpoint(n), ...keys, timezone: "UTC" })),
    send: async (target) => (target.endpoint.endsWith("2") ? "gone" : "sent"),
    record: async (at, result) => { recorded.push([at, result]); },
  });
  assert.equal(await job.run(), 2);
  assert.equal(recorded.length, 3);
  assert.equal(await new DailyPushJob({ siteUrl: "x", claim: async () => { throw new Error("down"); }, send: async () => "sent", record: async () => {} }).run(), 0);
});

test("the reminder run sends daily notifications even when email is not configured", async () => {
  const handler = new ReminderJob({
    secret: "s3cret",
    siteUrl: "https://www.prune.win",
    unsubscribeEndpoint: "https://api.example.test/unsubscribe",
    daily: { run: async () => 4 },
    claim: async () => { throw new Error("Email is not configured"); },
    release: async () => {},
    send: async () => "sent",
  }).handle;
  const response = await handler(new Request("https://fn.test", { method: "POST", headers: { Authorization: "Bearer s3cret" } }));
  assert.deepEqual(await response.json(), { error: "claim_failed", daily: 4 });
});
