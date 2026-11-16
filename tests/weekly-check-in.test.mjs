import assert from "node:assert/strict";
import test from "node:test";
import { owner, reviewFixture } from "./helpers/review-db.mjs";

const fixture = () =>
  reviewFixture([
    "20261112000500_reviews_every_ten_tasks.sql",
    "20261116000100_weekly_check_in.sql",
  ]);
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

test("a check-in covers the seven days before the check-in day", async () => {
  const db = await fixture();
  let overview = await db.overview();
  assert.equal(overview.status, "no_data", "an empty week makes no AI request");
  assert.equal(overview.checkIn.day, 0);
  assert.equal(overview.checkIn.plan, null);
  assert.equal(overview.progress, undefined, "no task-count unlocks any more");
  const { start, end } = overview.week;
  assert.equal(shift(start, 6), end);
  assert.equal(new Date(`${shift(end, 1)}T12:00:00Z`).getUTCDay(), 0, "Sunday by default");
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

test("moving the check-in day never reviews the same days twice", async () => {
  const db = await fixture();
  const { start, end } = (await db.overview()).week;
  await addTask(db, end, end);
  const input = await db.input();
  assert.equal(await db.finish(await db.reserve(input)), true);
  for (let day = 0; day < 7; day++) {
    const overview = await call(db, "set_check_in_day", { day });
    assert.equal(overview.checkIn.day, day);
    assert.notEqual(overview.status, "pending", `day ${day} overlaps the saved check-in`);
    assert.equal((await db.input()).activity.tasks.length, 0);
  }
  await assert.rejects(call(db, "set_check_in_day", { day: 7 }));
  await assert.rejects(call(db, "set_check_in_day", { day: "1" }));
  assert.ok(start);
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
