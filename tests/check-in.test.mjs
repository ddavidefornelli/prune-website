import assert from "node:assert/strict";
import test from "node:test";
import { checkInSummary, plannedEstimate, ratioLabel, trend, weekPoint } from "../src/reviews/check-in.ts";

const report = (weekStart, weekEnd, tasks) => ({
  weekStart, weekEnd, generatedAt: 0, model: "m",
  activity: { tasks, stops: [], totalStops: 0, omittedStops: 0 },
  analysis: { summary: "s", mainReasons: [], improvements: ["i"] },
});
const task = (id, day, done, estimatedMinutes, actualSeconds) => ({
  id, outcome: id, plannedFor: day, completedOn: done ? day : null,
  status: done ? "completed" : "planned", estimatedMinutes, actualSeconds,
});

test("a week counts planned and finished tasks, days worked and estimate accuracy", () => {
  const point = weekPoint(report("2026-11-02", "2026-11-08", [
    task("a", "2026-11-02", true, 30, 2700),
    task("b", "2026-11-02", true, 30, 0), // no recorded time: not in the ratio
    task("c", "2026-11-04", true, 60, 3600),
    task("d", "2026-11-05", false, 30, 600),
    task("e", "2026-10-30", false, 30, 0), // planned before the week
  ]));
  assert.equal(point.planned, 4);
  assert.equal(point.completed, 3);
  assert.equal(point.activeDays, 2);
  assert.equal(point.timedTasks, 2);
  assert.equal(point.estimateRatio, 6300 / 5400);
});

test("the trend moves half way toward each new week and skips empty ones", () => {
  assert.deepEqual(trend([2, null, 1, 1]), [2, 2, 1.5, 1.25]);
  assert.deepEqual(trend([null, 4]), [null, 4]);
});

test("the plan compounds on the accepted factor and ignores noise", () => {
  const week = (start, end, ratio) => report(start, end, [0, 1, 2].map((i) => task(`${start}${i}`, start, true, 30, 1800 * ratio)));
  const weeks = [week("2026-11-02", "2026-11-08", 1.5), week("2026-11-09", "2026-11-15", 1.5)];
  let summary = checkInSummary(weeks, null);
  assert.deepEqual(summary.suggested, { estimateFactor: 1.5, dailyTarget: 3 });
  assert.equal(summary.changed, true);
  // Estimates already padded by 1.5 that still run 20% long move it to 1.8.
  const padded = [0, 1, 2].map((i) => ({ ...task(`p${i}`, "2026-11-16", true, 45, 45 * 60 * 1.2) }));
  summary = checkInSummary([report("2026-11-16", "2026-11-22", padded)], { estimateFactor: 1.5, dailyTarget: 3, decidedFor: "2026-11-15" });
  assert.equal(summary.suggested.estimateFactor, 1.8);
  // A 5% drift is noise: the plan stays.
  summary = checkInSummary([week("2026-11-02", "2026-11-08", 1.05)], { estimateFactor: 1, dailyTarget: 3, decidedFor: "2026-11-01" });
  assert.equal(summary.suggested.estimateFactor, 1);
  assert.equal(summary.changed, false);
});

test("too few timed tasks never move estimates, and targets stay within 1 to 5", () => {
  const sparse = report("2026-11-02", "2026-11-08", [task("a", "2026-11-02", true, 30, 7200)]);
  const summary = checkInSummary([sparse], null);
  assert.equal(summary.enoughTiming, false);
  assert.equal(summary.suggested.estimateFactor, 1);
  assert.equal(summary.suggested.dailyTarget, 1);
  assert.equal(checkInSummary([], null).changed, false);
});

test("estimates start where the plan puts them, within the dial's range", () => {
  assert.equal(plannedEstimate(), 30);
  assert.equal(plannedEstimate(1.3), 40);
  assert.equal(plannedEstimate(3), 60);
  assert.equal(plannedEstimate(0.5), 15);
  assert.equal(ratioLabel(1.28), "28% over");
  assert.equal(ratioLabel(0.9), "10% under");
  assert.equal(ratioLabel(1.02), "On estimate");
});
