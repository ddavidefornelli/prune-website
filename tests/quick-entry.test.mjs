import assert from "node:assert/strict";
import { test } from "node:test";
import { DayPlan } from "../src/planner/day-plan.ts";
import { QuickEntry } from "../src/planner/quick-entry.ts";
import { Duration } from "../src/shared/duration.ts";

const parseQuickEntry = (text) => ({ ...QuickEntry.parse(text) });
const summarizeDay = (tasks, now) => new DayPlan(tasks).summary(now);

test("quick entry reads a trailing duration and clamps it to the dial", () => {
  assert.deepEqual(parseQuickEntry("Write the brief 45m"), { outcome: "Write the brief", minutes: 45 });
  assert.deepEqual(parseQuickEntry("Review deck 1h"), { outcome: "Review deck", minutes: 60 });
  assert.deepEqual(parseQuickEntry("Inbox zero 12 min"), { outcome: "Inbox zero", minutes: 10 });
  assert.deepEqual(parseQuickEntry("Deep work 2 hours"), { outcome: "Deep work", minutes: 60 });
  assert.deepEqual(parseQuickEntry("Stretch 2m"), { outcome: "Stretch", minutes: 5 });
});

test("quick entry leaves ordinary outcomes untouched", () => {
  for (const text of ["Call mom", "Meet at 3pm", "Ship v2", "45m", "Read 2 chapters", "Plan "]) {
    assert.deepEqual(parseQuickEntry(text), { outcome: text, minutes: null });
  }
});

test("day summary projects remaining focus from estimates and tracked time", () => {
  const tasks = [
    { status: "completed", estimatedMinutes: 30, actualSeconds: 1500, startedAt: null },
    { status: "active", estimatedMinutes: 30, actualSeconds: 600, startedAt: 1000 },
    { status: "planned", estimatedMinutes: 20, actualSeconds: 0, startedAt: null },
  ];
  const summary = summarizeDay(tasks, 1300);
  assert.equal(summary.completed, 1);
  assert.equal(summary.focusedSeconds, 1500 + 900);
  assert.equal(summary.remainingSeconds, 900 + 1200);
  assert.equal(summary.finishAt, 1300 + 2100);
  assert.equal(summarizeDay([tasks[0]], 0).finishAt, null);
  assert.equal(new Duration(5400).rounded(), "1 h 30 min");
});
