import { Week } from "./week.ts";

/** Dates and hours in the browser's language. */
export class CalendarFormat {
  private static readonly narrow = new Intl.DateTimeFormat(undefined, {
    weekday: "narrow",
  });
  private static readonly short = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  });
  private static readonly long = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  private static readonly hourFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
  });
  private static readonly timeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  private static readonly dayTime = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  private static readonly dateTime = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  private static readonly range = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });

  static weekday(date: Date, wide: boolean): string {
    return (wide ? CalendarFormat.short : CalendarFormat.narrow).format(date);
  }

  static day(date: Date): string {
    return CalendarFormat.long.format(date);
  }

  static hour(hour: number): string {
    return CalendarFormat.hourFormat.format(new Date(2000, 0, 1, hour));
  }

  static time(at: number): string {
    return CalendarFormat.timeFormat.format(at);
  }

  /** "Tue 14:00" this week, "24 Nov, 14:00" further away. */
  static when(at: number, now = Date.now()): string {
    const week = Week.of(now);
    return at >= week.start && at < week.end
      ? CalendarFormat.dayTime.format(at)
      : CalendarFormat.dateTime.format(at);
  }

  /** "Tue 2:00 – 3:30 PM" for a task's time on the calendar. */
  static span(start: number, minutes: number): string {
    return `${CalendarFormat.dayTime.formatRange(start, start + minutes * 60_000)}`;
  }

  /** "2:00 – 3:30 PM", for a block whose day is already in sight. */
  static hours(start: number, minutes: number): string {
    return CalendarFormat.timeFormat.formatRange(
      start,
      start + minutes * 60_000,
    );
  }

  /** "45 min", "1 h", "1 h 30 min". */
  static duration(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min`;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }

  static week(week: Week): string {
    return CalendarFormat.range.formatRange(week.days[0], week.days[6]);
  }
}
