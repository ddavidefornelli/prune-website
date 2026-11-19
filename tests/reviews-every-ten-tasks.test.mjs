import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewValidator } from "../server/weekly-review/domain.ts";

const validateInput = ReviewValidator.input;
import { owner, reviewFixture as fixture } from "./helpers/review-db.mjs";

test("a review is due after every 10 completed tasks, counting from the switch", async () => {
  const db = await fixture();
  assert.equal(new Date(`${db.since}T00:00:00Z`).getUTCDay(), 1, "counting starts on a Monday");
  // Completed before the switch: already covered by weekly reviews.
  await db.complete(4, "2026-01-05");
  const [first] = await db.complete(9);
  await db.rows(`insert into public.planner_stops(user_id, task_id, reason, stopped_on) values
    ($1, $2, 'Phone call', $3::date), ($1, $2, 'Reason not provided', $3::date)`, [owner, first, db.since]);

  let overview = await db.overview();
  assert.deepEqual(overview.progress, { completed: 9, target: 10 });
  assert.equal(overview.status, "no_data");
  assert.equal((await db.input()).activity.tasks.length, 0, "no AI input before 10 tasks");

  await db.complete(2);
  overview = await db.overview();
  assert.equal(overview.status, "pending");
  assert.deepEqual(overview.progress, { completed: 10, target: 10 });

  const input = await db.input();
  assert.equal(input.activity.tasks.length, 10);
  assert.deepEqual(input.activity.tasks.map((task) => task.outcome), Array.from({ length: 10 }, (_, i) => `task ${i + 5}`));
  assert.deepEqual(input.activity.stops.map((stop) => stop.reason), ["Phone call"]);

  // Only the batch that is due can be reserved.
  assert.equal((await db.reserve(input, { ...input.activity, tasks: input.activity.tasks.slice(1) })).outcome, "invalid");
  const claim = await db.reserve(input);
  assert.equal(claim.outcome, "reserved");
  assert.equal((await db.reserve(input)).outcome, "running");
  assert.equal((await db.overview()).status, "running");
  assert.equal(await db.finish(claim), true);

  overview = await db.overview();
  assert.equal(overview.status, "up_to_date");
  assert.deepEqual(overview.progress, { completed: 1, target: 10 }, "the 11th task starts the next batch");
  assert.equal(overview.reviews.length, 1);
  assert.equal(overview.reviews[0].weekStart, db.since);
  assert.equal(overview.reviews[0].activity.tasks.length, 10);

  // The next batch, on later days, gets its own review.
  const next = new Date(Date.parse(`${db.since}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  await db.complete(9, next);
  const second = await db.input();
  assert.equal(second.activity.tasks[0].outcome, "task 15");
  assert.equal(second.weekEnd, next);
  const claim2 = await db.reserve(second);
  assert.equal(claim2.outcome, "reserved");
  assert.equal(await db.finish(claim2), true);
  overview = await db.overview();
  assert.equal(overview.reviews.length, 2);
  assert.deepEqual(overview.progress, { completed: 0, target: 10 });
});

test("a failing batch retries hourly, then daily, and is never stuck", async () => {
  const db = await fixture();
  await db.complete(10);
  const input = await db.input();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const claim = await db.reserve(input);
    assert.equal(claim.outcome, "reserved", `attempt ${attempt}`);
    await db.rows("update public.ai_review_requests set status = 'failed' where id = $1", [claim.id]);
    assert.equal((await db.overview()).status, "failed");
    assert.equal((await db.reserve(input)).outcome, "rate_limited");
    await db.rows("update public.ai_review_requests set last_attempt_at = now() - interval '2 hours'");
    if (attempt >= 3) {
      assert.equal((await db.reserve(input)).outcome, "rate_limited", "after three failures, wait a day");
      await db.rows("update public.ai_review_requests set last_attempt_at = now() - interval '25 hours'");
    }
  }
});

test("turning reviews on returns the progress overview and clients can't read the helpers", async () => {
  const db = await fixture();
  await db.rows("update public.planner_accounts set ai_enabled = false where user_id = $1", [owner]);
  assert.equal((await db.overview()).status, "disabled");
  const enabled = (await db.rows("select public.planner_call('set_weekly_ai_enabled', '{\"enabled\":true}'::jsonb, 'UTC') r"))[0].r;
  assert.ok(enabled.progress);
  await db.rows("set role authenticated");
  await assert.rejects(db.rows("select public.planner_review_batch($1)", [owner]));
  await assert.rejects(db.rows("select public.planner_review_input($1, 'UTC')", [owner]));
  await assert.rejects(db.rows("select * from public.planner_review_tasks"));
});

test("the Edge Function accepts a batch spanning any dates up to tomorrow", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const task = (id, day) => ({ id, outcome: `t${id}`, plannedFor: day, completedOn: day, status: "completed", estimatedMinutes: 25, actualSeconds: 60 });
  const body = (weekStart, weekEnd) => ({
    consentVersion: "weekly-ai-v1",
    weekStart,
    weekEnd,
    activity: { tasks: [task("a", weekStart), task("b", weekEnd)], stops: [], totalStops: 0, omittedStops: 0 },
  });
  assert.equal(validateInput(body("2026-10-28", "2026-11-12"), now).weekStart, "2026-10-28");
  assert.equal(validateInput(body("2026-11-12", "2026-11-12"), now).weekEnd, "2026-11-12");
  assert.throws(() => validateInput(body("2026-11-12", "2026-11-10"), now));
  assert.throws(() => validateInput(body("2026-11-12", "2026-11-15"), now));
});
