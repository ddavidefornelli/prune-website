import { CalendarDay } from "../shared/calendar-day.ts";
import { CALENDAR } from "../shared/time-constants.ts";
import type { Completion, Dashboard } from "./types.ts";

/**
 * Finished-task counts per day, up to today. Built once from the dashboard's
 * completion history; streaks, weekly totals and insights all read it, so the
 * history is parsed in one pass however many of them a screen shows.
 */
export class CompletionHistory {
  readonly today: CalendarDay;
  /** Day index → tasks finished that day; only days with at least one. */
  private readonly counts = new Map<number, number>();

  constructor(completions: readonly Completion[], today: string) {
    this.today = CalendarDay.parse(today);
    for (const { day, count } of completions) {
      const index = CalendarDay.parse(day).index;
      if (index <= this.today.index && count > 0)
        this.counts.set(index, (this.counts.get(index) ?? 0) + count);
    }
  }

  static of(data: Pick<Dashboard, "today" | "completions">): CompletionHistory {
    return new CompletionHistory(data.completions, data.today);
  }

  /** Days with at least one finished task. */
  get activeDays(): number {
    return this.counts.size;
  }

  get total(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  countOn(day: CalendarDay): number {
    return this.counts.get(day.index) ?? 0;
  }

  isActive(day: CalendarDay): boolean {
    return this.counts.has(day.index);
  }

  /** Tasks finished on or after `from`. */
  totalSince(from: CalendarDay): number {
    return this.totalBetween(from, this.today);
  }

  /** Tasks finished from `from` to `to`, both included. */
  totalBetween(from: CalendarDay, to: CalendarDay): number {
    let total = 0;
    for (const [index, count] of this.counts)
      if (index >= from.index && index <= to.index) total += count;
    return total;
  }

  /**
   * Days in a row with a finished task. A streak stays alive until a whole
   * day passes without one, so yesterday's run still counts this morning.
   */
  currentStreak(): number {
    let days = 0;
    const start = this.counts.has(this.today.index)
      ? this.today.index
      : this.today.index - 1;
    for (let index = start; this.counts.has(index); index--) days++;
    return days;
  }

  /** The longest run ever. Walks each run once instead of sorting the history. */
  bestStreak(): number {
    let best = 0;
    for (const index of this.counts.keys()) {
      if (this.counts.has(index - 1)) continue;
      let run = 1;
      while (this.counts.has(index + run)) run++;
      best = Math.max(best, run);
    }
    return best;
  }

  /** Totals per weekday (Sunday first) over the last `days` days. */
  totalsByWeekday(days: number): number[] {
    const totals: number[] = Array.from(
      { length: CALENDAR.daysPerWeek },
      () => 0,
    );
    for (const [index, count] of this.counts)
      if (index > this.today.index - days)
        totals[CalendarDay.fromIndex(index).weekday] += count;
    return totals;
  }

  /** Days in the last `days` days with at least `count` finished tasks. */
  daysWithAtLeast(count: number, days: number): number {
    let found = 0;
    for (const [index, finished] of this.counts)
      if (index > this.today.index - days && finished >= count) found++;
    return found;
  }
}
