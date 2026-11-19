import { CALENDAR, TIME } from "./time-constants.ts";

/**
 * A calendar date as its "YYYY-MM-DD" key. Arithmetic works on whole UTC days,
 * so moving between dates never depends on daylight-saving changes. Plans,
 * completions and reviews all store dates as these keys.
 */
export class CalendarDay {
  /** Intl construction is slow; the outbox replays many commands per zone. */
  private static readonly formatters = new Map<string, Intl.DateTimeFormat>();

  readonly key: string;
  /** Whole days since 1970-01-01. */
  readonly index: number;

  private constructor(key: string, index: number) {
    this.key = key;
    this.index = index;
  }

  static parse(key: string): CalendarDay {
    return new CalendarDay(
      key,
      Math.round(Date.parse(`${key}T00:00:00Z`) / TIME.dayMs),
    );
  }

  static fromIndex(index: number): CalendarDay {
    return new CalendarDay(
      new Date(index * TIME.dayMs).toISOString().slice(0, 10),
      index,
    );
  }

  /** The local date at `at` (epoch seconds) in an IANA time zone. */
  static local(at: number, timezone: string): CalendarDay {
    let formatter = CalendarDay.formatters.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      CalendarDay.formatters.set(timezone, formatter);
    }
    const parts = formatter.formatToParts(at * TIME.msPerSecond);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)!.value;
    return CalendarDay.parse(`${part("year")}-${part("month")}-${part("day")}`);
  }

  plus(days: number): CalendarDay {
    return CalendarDay.fromIndex(this.index + days);
  }

  next(): CalendarDay {
    return this.plus(1);
  }

  previous(): CalendarDay {
    return this.plus(-1);
  }

  /** 0 is Sunday, like `Date.getUTCDay`. */
  get weekday(): number {
    return new Date(this.index * TIME.dayMs).getUTCDay();
  }

  /** Monday of this date's week: the app's weeks run Monday to Sunday. */
  weekStart(): CalendarDay {
    return this.plus(
      -((this.weekday + CALENDAR.daysPerWeek - 1) % CALENDAR.daysPerWeek),
    );
  }

  monthStart(): CalendarDay {
    return CalendarDay.parse(`${this.key.slice(0, 7)}-01`);
  }

  /** Whole days from `other` to this date. */
  daysSince(other: CalendarDay): number {
    return this.index - other.index;
  }

  toString(): string {
    return this.key;
  }
}
