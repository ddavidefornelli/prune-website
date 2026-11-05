import assert from "node:assert/strict";
import { test } from "node:test";
import { isDayComplete, trackedSeconds } from "../src/planner/task-model.ts";
import { onboardingKey, shouldOfferOnboarding, shouldOfferTour, tourKey } from "../src/planner/onboarding.ts";
import { profileStats, todayFocusSeconds } from "../src/profile/profile-stats.ts";
import { reviewCountdown } from "../src/reviews/review-countdown.ts";
import { averageTaskTiming, completedTaskTimings } from "../src/shared/task-timing.ts";
import { dashboard, persistence } from "./helpers/queue.mjs";

test("day completion requires a nonempty plan with every task complete", () => {
  assert.equal(isDayComplete([]), false);
  assert.equal(isDayComplete([{ status: "completed" }, { status: "planned" }]), false);
  assert.equal(isDayComplete([{ status: "completed" }, { status: "completed" }]), true);
});

test("focus time excludes pauses and does not decrease when a clock rolls back", () => {
  assert.equal(trackedSeconds({ actualSeconds: 30, startedAt: null }, 200), 30);
  assert.equal(trackedSeconds({ actualSeconds: 30, startedAt: 100 }, 120), 50);
  assert.equal(trackedSeconds({ actualSeconds: 30, startedAt: 100 }, 90), 30);
});

test("profile statistics use calendar dates across month boundaries and ignore future totals", () => {
  const data = dashboard(Date.parse("2026-03-01T12:00:00Z") / 1000);
  data.completions = [
    { day: "2026-02-26", count: 1 }, { day: "2026-02-27", count: 1 },
    { day: "2026-02-27", count: 1 }, { day: "2026-02-28", count: 1 },
    { day: "2026-03-02", count: 99 },
  ];
  data.todayTasks = [{ actualSeconds: 30, startedAt: data.serverNow - 60, estimatedMinutes: 30 }];
  assert.deepEqual(profileStats(data), {
    totalCompleted: 4, activeDays: 3, currentStreak: 3, bestStreak: 3,
    todayCompleted: 0, weekCompleted: 4, monthCompleted: 0,
    todayFocusSeconds: 90, todayEstimatedMinutes: 30,
  });
  data.today = "2026-03-02";
  data.completions.pop();
  assert.equal(profileStats(data).currentStreak, 0);
});

test("profile streaks handle unordered history, duplicate dates, gaps, and daylight-saving boundaries", () => {
  const data = dashboard(Date.parse("2026-03-10T12:00:00Z") / 1000);
  data.completions = [
    { day: "2026-03-03", count: 2 }, { day: "2026-02-28", count: 1 },
    { day: "2026-03-01", count: 3 }, { day: "2026-03-02", count: 1 },
    { day: "2026-03-04", count: 0 }, { day: "2026-03-06", count: 1 },
    { day: "2026-03-07", count: 2 }, { day: "2026-03-07", count: 1 },
    { day: "2026-03-08", count: 1 }, { day: "2026-03-09", count: 1 },
    { day: "2026-03-11", count: 99 }, { day: "2026-02-01", count: 1 },
  ];
  const expected = {
    totalCompleted: 14, activeDays: 9, currentStreak: 4, bestStreak: 4,
    todayCompleted: 0, weekCompleted: 1, monthCompleted: 12,
    todayFocusSeconds: 0, todayEstimatedMinutes: 0,
  };
  assert.deepEqual(profileStats(data), expected);
  data.completions.reverse();
  assert.deepEqual(profileStats(data), expected);
});

test("live focus totals ignore history and exclude pauses and clock rollback", () => {
  const data = dashboard();
  data.todayTasks = [
    { actualSeconds: 10, startedAt: data.serverNow - 30 },
    { actualSeconds: 70, startedAt: null },
  ];
  Object.defineProperty(data, "completions", { get() { assert.fail("Live timing must not scan completion history"); } });
  assert.equal(todayFocusSeconds(data), 110);
  assert.equal(todayFocusSeconds(data, data.serverNow + 60), 170);
  assert.equal(todayFocusSeconds(data, data.serverNow - 60), 80);
});

test("onboarding is scoped to an account and never offered over existing history", () => {
  const { storage } = persistence();
  const data = dashboard();
  assert.equal(shouldOfferOnboarding(data, "alice", storage), true);
  storage.setItem(onboardingKey("alice"), "done");
  assert.equal(shouldOfferOnboarding(data, "alice", storage), false);
  assert.equal(shouldOfferOnboarding(data, "bob", storage), true);
  data.completions = [{ day: data.today, count: 1 }];
  assert.equal(shouldOfferOnboarding(data, "bob", storage), false);
  assert.equal(shouldOfferOnboarding(dashboard(), "alice", { getItem() { throw new Error("Storage unavailable"); } }), true);
});

test("the tour is offered once per account, with or without tasks, never over a running timer", () => {
  const { storage } = persistence();
  const data = dashboard();
  assert.equal(shouldOfferTour(data, "alice", storage), true);
  data.completions = [{ day: data.today, count: 4 }];
  assert.equal(shouldOfferTour(data, "alice", storage), true, "existing accounts get it too");
  storage.setItem(tourKey("alice"), "done");
  assert.equal(shouldOfferTour(data, "alice", storage), false);
  assert.equal(shouldOfferTour(data, "bob", storage), true);
  assert.equal(shouldOfferTour({ ...dashboard(), activeTask: { id: "t" } }, "bob", storage), false);
  assert.equal(shouldOfferTour(dashboard(), "bob", { getItem() { throw new Error("Storage unavailable"); } }), false);
});

test("review countdown honors the server instant, clamps overdue values and rejects invalid dates", () => {
  const target = Date.parse("2026-10-25T16:00:00Z");
  const week = { nextUpdate: "2026-10-25", nextUpdateAt: new Date(target).toISOString() };
  assert.deepEqual(reviewCountdown(week, target - 90_061_000).values, [1, 1, 1, 1]);
  const due = reviewCountdown(week, target + 1000);
  assert.equal(due.due, true);
  assert.deepEqual(due.values, [0, 0, 0, 0]);
  assert.equal(due.progress, 1);
  assert.equal(reviewCountdown({ nextUpdate: "not-a-date" }), null);
});

test("timing comparisons use the same completed tasks with recorded time", () => {
  const tasks = [
    { id: "recorded", status: "completed", completedOn: "2026-10-20", estimatedMinutes: 60, actualSeconds: 7200 },
    { id: "unrecorded", status: "completed", completedOn: "2026-10-21", estimatedMinutes: 30, actualSeconds: 0 },
    { id: "unfinished", status: "active", completedOn: null, estimatedMinutes: 30, actualSeconds: 1200 },
    { id: "other-week", status: "completed", completedOn: "2026-10-10", estimatedMinutes: 30, actualSeconds: 600 },
  ];
  assert.equal(completedTaskTimings(tasks, "2026-10-19", "2026-10-25").length, 2);
  assert.deepEqual(averageTaskTiming(tasks, "2026-10-19", "2026-10-25"), {
    count: 1, omittedCount: 1, estimatedSeconds: 3600, actualSeconds: 7200, differenceSeconds: 3600, severity: "red",
  });
  assert.equal(averageTaskTiming([], "2026-10-19", "2026-10-25"), null);
});
