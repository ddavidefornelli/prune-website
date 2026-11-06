import test from "node:test";
import assert from "node:assert/strict";
import { calendarMonth } from "../src/planner/activity-calendar-model.ts";

test("month is laid out Monday-first with the right number of weeks", () => {
  // November 2026 starts on a Sunday, so it begins in the last column.
  const calendar = calendarMonth("2026-11-06", []);
  assert.equal(calendar.year, 2026);
  assert.equal(calendar.month, 10);
  assert.equal(calendar.days.length, 30);
  assert.deepEqual([calendar.days[0].column, calendar.days[0].week], [6, 0]);
  assert.deepEqual([calendar.days[1].column, calendar.days[1].week], [0, 1]);
  assert.equal(calendar.days.at(-1).day, "2026-11-30");
  assert.equal(calendar.weeks, 6);
});

test("leap February and earlier months are reached by offset across the year", () => {
  const february = calendarMonth("2024-11-15", [], -9);
  assert.equal(february.days.length, 29);
  assert.equal(february.days[0].day, "2024-02-01");
  assert.equal(february.days[0].column, 3);
  const december = calendarMonth("2025-01-10", [], -1);
  assert.equal(december.days[0].day, "2024-12-01");
  assert.equal(december.year, 2024);
});

test("counts only this month's past days and marks the rest as upcoming", () => {
  const calendar = calendarMonth("2023-11-15", [
    { day: "2023-10-31", count: 10 },
    { day: "2023-11-01", count: 2 },
    { day: "2023-11-15", count: 1 },
    { day: "2023-11-16", count: 4 },
  ]);
  assert.equal(calendar.total, 3);
  assert.equal(calendar.days.find((day) => day.day === "2023-11-15").future, false);
  assert.equal(calendar.days.find((day) => day.day === "2023-11-16").count, 0);
  assert.equal(calendar.days.find((day) => day.day === "2023-11-16").future, true);
  assert.equal(calendar.days.filter((day) => !day.future).length, 15);
});
