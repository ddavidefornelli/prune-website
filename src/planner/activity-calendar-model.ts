import { CalendarDay } from "../shared/calendar-day.ts";
import { CALENDAR } from "../shared/time-constants.ts";
import type { Completion } from "./types.ts";

/** How far back the calendar pages, counting the current month. */
export const CALENDAR_MONTHS = 12;

export interface CalendarCell {
  day: string;
  column: number;
  week: number;
  count: number;
  future: boolean;
}

/** One month of finished tasks, laid out Monday-first like the landing page preview. */
export class CalendarMonth {
  readonly year: number;
  /** 0 is January. */
  readonly month: number;
  readonly weeks: number;
  readonly days: CalendarCell[];
  readonly total: number;

  /** `offset` counts months from the current one: 0 is this month, -1 the last. */
  constructor(today: string, completions: readonly Completion[], offset = 0) {
    const start = new Date(
      Date.UTC(
        Number(today.slice(0, 4)),
        Number(today.slice(5, 7)) - 1 + offset,
        1,
      ),
    );
    this.year = start.getUTCFullYear();
    this.month = start.getUTCMonth();
    const first = CalendarDay.parse(start.toISOString().slice(0, 10));
    const dayCount = new Date(
      Date.UTC(this.year, this.month + 1, 0),
    ).getUTCDate();
    const lead =
      (first.weekday + CALENDAR.daysPerWeek - 1) % CALENDAR.daysPerWeek;
    const counts = new Map(completions.map(({ day, count }) => [day, count]));
    this.days = Array.from({ length: dayCount }, (_, index) => {
      const day = first.plus(index).key;
      return {
        day,
        column: (lead + index) % CALENDAR.daysPerWeek,
        week: Math.floor((lead + index) / CALENDAR.daysPerWeek),
        count: day <= today ? (counts.get(day) ?? 0) : 0,
        future: day > today,
      };
    });
    this.weeks = Math.ceil((lead + dayCount) / CALENDAR.daysPerWeek);
    this.total = this.days.reduce((sum, day) => sum + day.count, 0);
  }

  /** "November 2026". */
  get title(): string {
    return `${CALENDAR.monthNames[this.month]} ${this.year}`;
  }
}
