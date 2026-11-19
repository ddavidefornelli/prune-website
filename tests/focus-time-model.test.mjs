import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TZ = "Europe/Rome";
const { FocusTime } = await import("../src/planner/focus-time.ts");
const formatMinute = (minute) => new FocusTime(minute).label();
const parseMinute = (value) => FocusTime.parse(value)?.minute ?? null;
const googleCalendarUrl = (minute, weekdaysOnly, site, now, zone) =>
  new FocusTime(minute).googleCalendarUrl(weekdaysOnly, site, now, zone);
const calendarFile = (minute, weekdaysOnly, site, now) =>
  new FocusTime(minute).calendarFile(weekdaysOnly, site, now);

test("focus times format and parse as HH:MM", () => {
  assert.equal(formatMinute(540), "09:00");
  assert.equal(formatMinute(7 * 60 + 5), "07:05");
  assert.equal(parseMinute("14:30"), 870);
  assert.equal(parseMinute("24:00"), null);
  assert.equal(parseMinute("9:00"), null);
});

test("calendar entries repeat at the focus time and carry no task text", () => {
  const now = new Date("2026-11-18T10:00:00");
  const url = new URL(googleCalendarUrl(9 * 60, false, "https://www.prune.win/", now, "Europe/Rome"));
  // 09:00 has passed today, so the series starts tomorrow, in the owner's zone.
  assert.equal(url.searchParams.get("dates"), "20261119T090000/20261119T093000");
  assert.equal(url.searchParams.get("ctz"), "Europe/Rome");
  assert.equal(url.searchParams.get("recur"), "RRULE:FREQ=DAILY");
  assert.equal(url.searchParams.get("text"), "Focus time · prune");
  const ics = calendarFile(14 * 60, true, "https://www.prune.win/", now);
  assert.ok(ics.includes("DTSTART:20261118T140000\r\n"), "later today: starts today");
  assert.ok(ics.includes("DTEND:20261118T143000\r\n"));
  assert.ok(ics.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\n"));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
});
