import type { Dashboard } from "./types";
import { DAY_MS } from "./time.ts";

export type Completion = Dashboard["completions"][number];
export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;
/** How far back the calendar pages, counting the current month. */
export const CALENDAR_MONTHS = 12;

/** Months are counted from the current one: 0 is this month, -1 the last. */
export function monthStart(today: string, offset = 0): Date {
  return new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1 + offset,
      1,
    ),
  );
}

/** One month laid out Monday-first, like the landing page preview. */
export function calendarMonth(
  today: string,
  completions: readonly Completion[],
  offset = 0,
) {
  const start = monthStart(today, offset);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (start.getUTCDay() + 6) % 7;
  const counts = new Map(completions.map(({ day, count }) => [day, count]));
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const day = date.toISOString().slice(0, 10);
    return {
      day,
      column: (lead + index) % 7,
      week: Math.floor((lead + index) / 7),
      count: day <= today ? (counts.get(day) ?? 0) : 0,
      future: day > today,
    };
  });
  return {
    year,
    month,
    weeks: Math.ceil((lead + dayCount) / 7),
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
  };
}

export type CalendarMonth = ReturnType<typeof calendarMonth>;
export type CalendarDay = CalendarMonth["days"][number];
