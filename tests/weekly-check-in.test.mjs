import assert from "node:assert/strict";
import test from "node:test";
import { owner, reviewFixture } from "./helpers/review-db.mjs";

const fixture = () =>
  reviewFixture([
    "20261112000500_reviews_every_ten_tasks.sql",
    "20261116000100_weekly_check_in.sql",
    "20261117000100_check_in_day_after_start.sql",
    "20261118000100_first_check_in_after_three_days.sql",
  ]);
const startedDaysAgo = (db, days) =>
  db.rows("update auth.users set created_at = now() - make_interval(days => $1)", [days]);
const localToday = async (db) =>
  (await db.rows("select (now() at time zone 'Europe/Rome')::date::text d"))[0].d;
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const call = (db, action, args = {}) =>
  db.rows("select public.planner_call($1, $2::jsonb, 'Europe/Rome') r", [action, JSON.stringify(args)]).then((r) => r[0].r);
const shift = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function addTask(db, plannedFor, completedOn = null) {
  const [{ r }] = await db.rows(
    `insert into public.planner_tasks(user_id, outcome, planned_for, status, completed_on)
     values ($1, 'a task', $2::date, $3, $4::date) returning id r`,
    [owner, plannedFor, completedOn ? "completed" : "planned", completedOn],
  );
  return r;
}

test("the first check-in is three days after the account started", async () => {
  const db = await fixture();
  const today = await localToday(db);
  for (const back of [0, 1, 2]) {
    await startedDaysAgo(db, back);
    const overview = await db.overview();
    const first = shift(today, 3 - back);
    assert.equal(overview.week.nextUpdate, first, `started ${back} days ago`);
    assert.equal(overview.checkIn.day, weekday(first));
    // Nothing is due yet, even with work in the days before.
    await addTask(db, today, today);
    assert.notEqual((await db.overview()).status, "pending", `started ${back} days ago`);
    assert.equal((await db.input()).activity.tasks.length, 0);
    await db.rows("delete from public.planner_tasks");
  }
  // On the third day the first check-in covers the seven days before it.
  await startedDaysAgo(db, 3);
  await addTask(db, shift(today, -1), shift(today, -1));
  const overview = await db.overview();
  assert.equal(overview.status, "pending");
  assert.equal(overview.week.end, shift(today, -1));
  assert.equal(overview.week.start, shift(today, -7));
  assert.equal(overview.week.nextUpdate, today);
  assert.equal(overview.checkIn.day, weekday(today));
});

test("after the first, a check-in is due every seven days", async () => {
  const db = await fixture();
  const today = await localToday(db);
  for (let back = 3; back < 24; back++) {
    await startedDaysAgo(db, back);
    const overview = await db.overview();
    const sinceFirst = (back - 3) % 7;
    const due = shift(today, -sinceFirst);
    assert.equal(overview.week.end, shift(due, -1), `started ${back} days ago`);
    assert.equal(overview.week.nextUpdate, shift(due, 7), "nothing to check in on: next week");
    assert.equal(overview.checkIn.day, weekday(due));
  }
});

test("a check-in covers the seven days before the check-in day", async () => {
  const db = await fixture();
  await startedDaysAgo(db, 9);
  let overview = await db.overview();
  assert.equal(overview.status, "no_data", "an empty week makes no AI request");
  const today = await localToday(db);
  assert.equal(overview.checkIn.day, weekday(shift(today, 1)), "the weekday of start + 3");
  assert.equal(overview.checkIn.plan, null);
  assert.equal(overview.progress, undefined, "no task-count unlocks any more");
  const { start, end } = overview.week;
  assert.equal(shift(start, 6), end);
  assert.equal(end, shift(today, -7), "the first check-in was six days ago");
  assert.equal(overview.week.nextUpdate, shift(end, 8), "nothing to check in on: next week");

  await addTask(db, start, start);
  await addTask(db, end); // planned and not finished still counts
  await addTask(db, shift(start, -1)); // outside the week
  overview = await db.overview();
  assert.equal(overview.status, "pending");
  assert.equal(overview.week.nextUpdate, shift(end, 1));
  assert.ok(overview.week.nextUpdateAt);

  const input = await db.input();
  assert.equal(input.weekStart, start);
  assert.equal(input.weekEnd, end);
  assert.equal(input.activity.tasks.length, 2);
  assert.equal(
    (await db.reserve(input, { ...input.activity, tasks: input.activity.tasks.slice(1) })).outcome,
    "invalid",
  );
  const claim = await db.reserve(input);
  assert.equal(claim.outcome, "reserved");
  assert.equal(await db.finish(claim), true);

  overview = await db.overview();
  assert.equal(overview.status, "up_to_date");
  assert.equal(overview.reviews[0].weekStart, start);
  assert.equal(overview.reviews[0].weekEnd, end);
  assert.equal(overview.week.nextUpdate, shift(end, 8));
  assert.equal((await db.input()).activity.tasks.length, 0, "a saved check-in is never paid for again");
});

test("the day can't be changed, and no account change ever re-reviews covered days", async () => {
  const db = await fixture();
  await startedDaysAgo(db, 3);
  await assert.rejects(call(db, "set_check_in_day", { day: 3 }));
  const { end } = (await db.overview()).week;
  await addTask(db, end, end);
  assert.equal(await db.finish(await db.reserve(await db.input())), true);
  // Whatever weekday the account started on, a window that begins on or before
  // the saved check-in's last day is already covered: no second paid call.
  for (let back = 3; back < 10; back++) {
    await startedDaysAgo(db, back);
    const overview = await db.overview();
    assert.notEqual(overview.status, "pending", `started ${back} days ago`);
    assert.equal((await db.input()).activity.tasks.length, 0, `started ${back} days ago`);
    assert.equal((await db.reserve(await db.input(), { tasks: [], stops: [], totalStops: 0, omittedStops: 0 })).outcome === "reserved", false);
  }
  assert.equal((await db.rows("select count(*)::int n from public.ai_review_requests"))[0].n, 1);
});

test("the next week after a check-in is due again", async () => {
  const db = await fixture();
  // An account that started 13 days ago has a check-in due this week.
  await startedDaysAgo(db, 13);
  const first = (await db.overview()).week;
  await addTask(db, first.start, first.start);
  assert.equal(await db.finish(await db.reserve(await db.input())), true);
  // A review that ended the day before this window starts doesn't cover it.
  await db.rows("update public.planner_reviews set week_start = $1::date", [shift(first.start, -1)]);
  assert.equal((await db.overview()).status, "pending");
});

test("the accepted plan is validated and returned with the overview", async () => {
  const db = await fixture();
  const decidedFor = (await db.overview()).week.end;
  const overview = await call(db, "set_check_in_plan", { estimateFactor: 1.25, dailyTarget: 3, decidedFor });
  assert.deepEqual(overview.checkIn.plan, { estimateFactor: 1.25, dailyTarget: 3, decidedFor });
  for (const bad of [
    { estimateFactor: 0.4, dailyTarget: 3, decidedFor },
    { estimateFactor: 1.234, dailyTarget: 3, decidedFor },
    { estimateFactor: 1, dailyTarget: 6, decidedFor },
    { estimateFactor: 1, dailyTarget: 2.5, decidedFor },
    { estimateFactor: 1, dailyTarget: 2, decidedFor: "2999-01-01" },
    { estimateFactor: "1", dailyTarget: 2, decidedFor },
  ])
    await assert.rejects(call(db, "set_check_in_plan", bad), JSON.stringify(bad));
});
