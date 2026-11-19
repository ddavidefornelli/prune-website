import test from "node:test";
import assert from "node:assert/strict";
import { InsightDrops, InsightEngine } from "../src/planner/insights.ts";
import { STORAGE_KEYS } from "../src/shared/storage-keys.ts";

const insights = (log, data) => new InsightEngine(log, data).all();
const completionInsight = (storage, accountKey, task, data, at, random) =>
  new InsightDrops(storage, accountKey, random).afterCompletion(task, data, at);

const TODAY = "2026-11-13"; // a Friday
const dashboard = (completions = []) => ({
  today: TODAY,
  tomorrow: "2026-11-14",
  todayTasks: [],
  tomorrowTasks: [],
  activeTask: null,
  completions,
  serverNow: 0,
});
const days = (...entries) => entries.map(([day, count]) => ({ day, count }));
const ids = (list) => list.map((insight) => insight.id);
function memory(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

test("nothing is claimed until there is enough of the owner's data", () => {
  assert.deepEqual(insights([], dashboard()), []);
  assert.deepEqual(insights([[9, 30, 1800], [10, 30, 1800]], dashboard(days([TODAY, 2]))), []);
});

test("time of day compares one part of the day with the rest", () => {
  const log = [...Array(6).fill([9, 0, 0]), ...Array(3).fill([15, 0, 0])];
  const [found] = insights(log, dashboard());
  assert.deepEqual(found, { id: "time:morning", figure: "2×", text: "You finish 2× more tasks before 11am." });
  const evenings = insights(Array(5).fill([20, 0, 0]).concat([[21, 0, 0]]), dashboard());
  assert.equal(evenings[0].text, "Every one of your last 6 tasks was finished after 5pm.");
  // An even spread says nothing.
  assert.deepEqual(insights([[9, 0, 0], [10, 0, 0], [12, 0, 0], [13, 0, 0], [14, 0, 0], [16, 0, 0]], dashboard()), []);
});

test("estimates are compared with recorded focus time", () => {
  const five = (minutes, seconds) => Array(5).fill([13, minutes, seconds]);
  assert.equal(insights(five(30, 1350), dashboard())[0].text, "You finish about 25% faster than you estimate.");
  assert.equal(insights(five(20, 1800), dashboard())[0].text, "Your tasks take about 1.5× your estimate. Give them room.");
  assert.equal(insights(five(30, 1900), dashboard())[0].id, "estimate:close");
  // Tasks completed without a recorded timer are left out.
  assert.deepEqual(insights(five(30, 0), dashboard()), []);
});

test("history insights: streak, weekday, week over week and full days", () => {
  const streak = insights([], dashboard(days(["2026-11-11", 1], ["2026-11-12", 1], [TODAY, 1])));
  assert.deepEqual(streak, [{ id: "streak", figure: "3", text: "3 days in a row. That’s your longest streak yet." }]);

  const shorter = insights([], dashboard(days(
    ["2026-10-01", 1], ["2026-10-02", 1], ["2026-10-03", 1], ["2026-10-04", 1],
    ["2026-11-11", 1], ["2026-11-12", 1], [TODAY, 1],
  )));
  assert.equal(shorter.find((insight) => insight.id === "streak").text, "3 days in a row. Your best is 4.");

  // Tuesdays carry 9 of 15 tasks; the other six weekdays average 1.
  const weekday = insights([], dashboard(days(
    ["2026-10-20", 3], ["2026-10-27", 3], ["2026-11-03", 3],
    ["2026-10-21", 2], ["2026-10-29", 2], ["2026-11-06", 2],
  )));
  assert.equal(weekday.find((insight) => insight.id === "weekday").text, "Tuesdays are your day: 9× more done than on your other days.");

  const week = insights([], dashboard(days(["2026-11-03", 2], ["2026-11-09", 3], ["2026-11-10", 1])));
  assert.equal(week.find((insight) => insight.id === "week").text, "You’ve already finished 2 more tasks than in all of last week.");

  const full = insights([], dashboard(days(["2026-11-02", 5], ["2026-11-05", 5], ["2026-11-10", 5], ["2026-10-01", 5])));
  assert.equal(full.find((insight) => insight.id === "full-days").text, "You cleared all five tasks on 3 of the last 14 days.");
});

test("a finished task is logged without task text and only sometimes drops an insight", () => {
  const storage = memory();
  const data = dashboard(days(["2026-11-11", 1], ["2026-11-12", 1], [TODAY, 1]));
  const task = { estimatedMinutes: 30, actualSeconds: 1500, outcome: "Secret plan" };
  const at = new Date(2026, 10, 13, 9, 30);
  assert.equal(completionInsight(storage, "account", task, data, at, () => 0.9), null, "most completions stay quiet");
  assert.equal(completionInsight(storage, "account", task, data, at, () => 0).id, "streak");
  // The same insight never drops twice in a row.
  assert.equal(completionInsight(storage, "account", task, data, at, () => 0), null);
  const saved = storage.getItem(STORAGE_KEYS.insights("account"));
  assert.deepEqual(JSON.parse(saved), { log: [[9, 30, 1500], [9, 30, 1500], [9, 30, 1500]], last: "streak" });
  assert.equal(saved.includes("Secret"), false);
});

test("the log is capped and a damaged one is ignored", () => {
  const storage = memory({ [STORAGE_KEYS.insights("a")]: "{not json", [STORAGE_KEYS.insights("b")]: JSON.stringify({ log: Array(250).fill([9, 30, 60]).concat([["x", 1, 2], [1, 2]]), last: 7 }) });
  completionInsight(storage, "a", { estimatedMinutes: 25, actualSeconds: 0 }, dashboard(), new Date(2026, 10, 13, 22), () => 1);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.insights("a"))), { log: [[22, 25, 0]], last: null });
  completionInsight(storage, "b", { estimatedMinutes: 25, actualSeconds: 0 }, dashboard(), new Date(2026, 10, 13, 22), () => 1);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.insights("b"))).log.length, 200);
});
