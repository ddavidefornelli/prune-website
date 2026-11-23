import { CALENDAR } from "./constants.ts";

/** Something on the calendar for one day, in minutes from that day's midnight. */
export interface DayItem<T> {
  item: T;
  from: number;
  to: number;
}

/** A day item with its place beside the items it overlaps. */
export interface Placed<T> extends DayItem<T> {
  lane: number;
  lanes: number;
}

/**
 * A Monday-to-Sunday week in the browser's time zone. Days are built from
 * dates, not by adding 24 hours, so a daylight-saving change never shifts them.
 */
export class Week {
  /** Midnight on Monday, local time. */
  readonly start: number;
  readonly days: readonly Date[];

  private constructor(monday: Date) {
    this.start = monday.getTime();
    this.days = Array.from(
      { length: CALENDAR.days },
      (_, index) =>
        new Date(
          monday.getFullYear(),
          monday.getMonth(),
          monday.getDate() + index,
        ),
    );
  }

  /** The week that holds `time`. */
  static of(time: number): Week {
    const date = new Date(time);
    const fromMonday = (date.getDay() + 6) % 7;
    return new Week(
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() - fromMonday,
      ),
    );
  }

  /** Midnight after Sunday. */
  get end(): number {
    const last = this.days[CALENDAR.days - 1];
    return new Date(
      last.getFullYear(),
      last.getMonth(),
      last.getDate() + 1,
    ).getTime();
  }

  shift(weeks: number): Week {
    const first = this.days[0];
    return Week.of(
      new Date(
        first.getFullYear(),
        first.getMonth(),
        first.getDate() + weeks * 7,
      ).getTime(),
    );
  }

  /** Which day of this week `time` falls on, or -1. */
  dayOf(time: number): number {
    if (time < this.start || time >= this.end) return -1;
    for (let index = CALENDAR.days - 1; index >= 0; index -= 1)
      if (time >= this.days[index].getTime()) return index;
    return -1;
  }

  /** The start of `hour` on day `day` (fractions of an hour allowed). */
  at(day: number, hour: number): number {
    const date = this.days[day];
    const whole = Math.floor(hour);
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      whole,
      Math.round((hour - whole) * 60),
    ).getTime();
  }

  /** Minutes from day `day`'s midnight to `time` (may be negative or past 24 h). */
  minutes(day: number, time: number): number {
    const date = new Date(time);
    const midnight = this.days[day];
    const days = Math.round(
      (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
        midnight.getTime()) /
        CALENDAR.dayMs,
    );
    return days * 24 * 60 + date.getHours() * 60 + date.getMinutes();
  }

  /**
   * Side by side where they overlap: each item gets a lane, and every item in
   * a run of overlapping ones shares that run's number of lanes.
   */
  static place<T>(items: DayItem<T>[]): Placed<T>[] {
    const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
    const placed: Placed<T>[] = [];
    let run: Placed<T>[] = [];
    let runEnd = -Infinity;
    const close = () => {
      const lanes = run.reduce(
        (most, item) => Math.max(most, item.lane + 1),
        1,
      );
      for (const item of run) item.lanes = lanes;
      run = [];
    };
    for (const item of sorted) {
      if (item.from >= runEnd) {
        close();
        runEnd = -Infinity;
      }
      const taken = new Set(
        run.filter((other) => other.to > item.from).map((other) => other.lane),
      );
      let lane = 0;
      while (taken.has(lane)) lane += 1;
      const next = { ...item, lane, lanes: 1 };
      run.push(next);
      placed.push(next);
      runEnd = Math.max(runEnd, item.to);
    }
    close();
    return placed;
  }
}
