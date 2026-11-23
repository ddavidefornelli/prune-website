import assert from "node:assert/strict";
import { test } from "node:test";
import { Week } from "../src/calendar/week.ts";
import { TaskList } from "../src/tasks/task-list.ts";

const T = Date.UTC(2026, 10, 23, 12);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a task is planned, moved and taken off; each change is saved for the cloud", () => {
  const list = TaskList.empty().add("Write the bio", T, id(1));
  assert.equal(list.find(id(1)).startAt, null);
  const planned = list.schedule(id(1), T + 3_600_000.7, T + 10);
  assert.equal(planned.find(id(1)).startAt, T + 3_600_000);
  assert.equal(planned.saved.pending[id(1)], T + 10);
  // The same plan again changes nothing.
  assert.equal(planned.schedule(id(1), T + 3_600_000, T + 20), planned);
  assert.equal(planned.schedule(id(1), Number.NaN, T + 20), planned);
  assert.equal(planned.schedule(id(1), null, T + 30).find(id(1)).startAt, null);
});

test("lists saved before the calendar read as unplanned; a bad start is refused", () => {
  const old = { id: id(1), title: "Old", done: false, createdAt: T, updatedAt: T, doneAt: null };
  const list = TaskList.parse({ tasks: [old, { ...old, id: id(2), startAt: "noon" }], pending: {}, owner: null });
  assert.deepEqual(list.tasks.map((task) => [task.id, task.startAt]), [[id(1), null]]);
});

test("a week runs Monday to Sunday in local time, whatever the day it starts from", () => {
  const sunday = new Date(2026, 10, 29, 23, 30).getTime();
  const week = Week.of(sunday);
  assert.equal(week.start, new Date(2026, 10, 23).getTime());
  assert.equal(week.end, new Date(2026, 10, 30).getTime());
  assert.equal(week.dayOf(sunday), 6);
  assert.equal(week.dayOf(week.end), -1);
  assert.equal(week.at(2, 14), new Date(2026, 10, 25, 14).getTime());
  assert.equal(week.minutes(2, new Date(2026, 10, 25, 9, 30).getTime()), 570);
  assert.equal(week.shift(1).start, week.end);
  assert.equal(week.shift(-1).shift(1).start, week.start);
});

test("a week across a daylight-saving change keeps its days at midnight", () => {
  // Weeks around the European and American changes; harmless in zones without one.
  for (const date of [new Date(2026, 2, 29, 12), new Date(2026, 9, 25, 12), new Date(2026, 2, 8, 12), new Date(2026, 10, 1, 12)]) {
    const week = Week.of(date.getTime());
    for (const day of week.days) assert.deepEqual([day.getHours(), day.getMinutes()], [0, 0]);
    assert.equal(week.dayOf(date.getTime()), (date.getDay() + 6) % 7);
  }
});

test("overlapping items sit side by side; the rest take the whole width", () => {
  const placed = Week.place([
    { item: "bio", from: 600, to: 660 },
    { item: "standup", from: 600, to: 630 },
    { item: "dentist", from: 660, to: 720 },
    { item: "call", from: 640, to: 700 },
    { item: "rent", from: 900, to: 960 },
  ]);
  const by = Object.fromEntries(placed.map((p) => [p.item, [p.lane, p.lanes]]));
  assert.deepEqual(by.rent, [0, 1]);
  assert.deepEqual(by.bio, [0, 2]);
  assert.deepEqual(by.standup, [1, 2]);
  assert.deepEqual(by.call, [1, 2]);
  assert.deepEqual(by.dentist, [0, 2]);
});

test("a description keeps its lines and is trimmed and capped; a duration snaps to 15 minutes", async () => {
  const list = TaskList.empty().add("Call the bank", T, id(1));
  const described = list.setNotes(id(1), "  Line one\r\nhttps://example.com\u0007\n ", T + 1);
  assert.equal(described.find(id(1)).notes, "Line one\nhttps://example.com");
  assert.equal(described.setNotes(id(1), "Line one\nhttps://example.com", T + 2), described);
  assert.equal(list.setNotes(id(1), "x".repeat(2500), T + 1).find(id(1)).notes.length, 2000);
  assert.deepEqual([50, 52, 5, 2000, Number.NaN].map((m) => TaskList.cleanMinutes(m)), [45, 45, 15, 720, 60]);
  assert.equal(list.setMinutes(id(1), 92, T + 1).find(id(1)).minutes, 90);
  assert.equal(list.setMinutes(id(1), 60, T + 1), list);
});

test("links in a description: web addresses only, without trailing punctuation, each once", async () => {
  const { findLinks } = await import("../src/calendar/links.ts");
  const found = findLinks("See https://example.com/a?b=1. And (http://x.test/path), https://example.com/a?b=1 javascript:alert(1) ftp://no.test");
  assert.deepEqual(found, [
    { href: "https://example.com/a?b=1", label: "example.com/a?b=1" },
    { href: "http://x.test/path", label: "x.test/path" },
  ]);
});

test("a server answer without the calendar fields never wipes this device's plan, length or description", () => {
  const local = TaskList.empty()
    .add("Call the bank", T, id(1))
    .schedule(id(1), T + 3_600_000, T + 1)
    .setMinutes(id(1), 90, T + 2)
    .setNotes(id(1), "Agenda", T + 3);
  const batch = local.batch();
  const sent = local.find(id(1));
  // An older backend answers with the task as it knows it: no calendar fields.
  const { startAt, minutes, notes, ...old } = sent;
  const confirmed = local.confirm(batch, { tasks: [old], rejected: [] });
  assert.deepEqual(
    [confirmed.find(id(1)).startAt, confirmed.find(id(1)).minutes, confirmed.find(id(1)).notes],
    [T + 3_600_000, 90, "Agenda"],
  );
  // A current backend that says the task left the calendar is believed.
  const cleared = local.confirm(batch, { tasks: [{ ...sent, startAt: null }], rejected: [] });
  assert.equal(cleared.find(id(1)).startAt, null);
});
