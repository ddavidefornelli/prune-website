import assert from "node:assert/strict";
import test from "node:test";
import { streakFor, streakNote } from "../src/planner/streak.ts";

// 2026-11-18 is a Wednesday.
const TODAY = "2026-11-18";
const data = (...days) => ({ today: TODAY, completions: days.map((day) => ({ day, count: 1 })) });
const states = (streak) => streak.week.map((day) => day.state);

test("no history: nothing counted, today open, the rest of the week ahead", () => {
  const streak = streakFor(data());
  assert.equal(streak.days, 0);
  assert.equal(streak.best, 0);
  assert.deepEqual(states(streak), ["missed", "missed", "today", "ahead", "ahead", "ahead", "ahead"]);
  assert.deepEqual(streak.week.map((day) => day.label), ["M", "T", "W", "T", "F", "S", "S"]);
  assert.equal(streakNote(streak), "Finish one task to start a streak.");
});

test("yesterday's run still counts until today passes without a task", () => {
  const streak = streakFor(data("2026-11-15", "2026-11-16", "2026-11-17"));
  assert.equal(streak.days, 3);
  assert.equal(streak.open, true);
  assert.deepEqual(states(streak).slice(0, 3), ["done", "done", "today"]);
  assert.equal(streakNote(streak), "Finish one task today to keep it.");
  const kept = streakFor(data("2026-11-15", "2026-11-16", "2026-11-17", TODAY));
  assert.equal(kept.days, 4);
  assert.equal(kept.open, false);
  assert.equal(streakNote(kept), "Your longest yet.");
});

test("a missed day ends the streak, and the best run is remembered", () => {
  const streak = streakFor(data("2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-16"));
  assert.equal(streak.days, 0);
  assert.equal(streak.best, 4);
  const again = streakFor(data("2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", TODAY));
  assert.equal(again.days, 1);
  assert.equal(streakNote(again), "Best: 4 days.");
  // Zero counts and future days are ignored.
  assert.equal(streakFor({ today: TODAY, completions: [{ day: TODAY, count: 0 }, { day: "2026-11-19", count: 2 }] }).days, 0);
});
