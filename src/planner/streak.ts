import { CALENDAR } from "../shared/time-constants.ts";
import { CompletionHistory } from "./completion-history.ts";
import type { Dashboard } from "./types.ts";

export interface StreakDay {
  /** One-letter weekday, Monday first. */
  label: string;
  state: "done" | "missed" | "today" | "ahead";
}

/** Days in a row with at least one finished task, and this week's embers. */
export class Streak {
  readonly days: number;
  readonly best: number;
  /** True while today has no finished task yet and a streak is at stake. */
  readonly open: boolean;
  /** This week, Monday to Sunday, like the rest of the app. */
  readonly week: StreakDay[];

  constructor(history: CompletionHistory) {
    const { today } = history;
    this.days = history.currentStreak();
    this.best = Math.max(this.days, history.bestStreak());
    this.open = !history.isActive(today);
    const monday = today.weekStart();
    this.week = CALENDAR.weekdayInitials.map((label, offset) => {
      const day = monday.plus(offset);
      return {
        label,
        state: history.isActive(day)
          ? "done"
          : day.index === today.index
            ? "today"
            : day.index > today.index
              ? "ahead"
              : "missed",
      };
    });
  }

  static of(data: Pick<Dashboard, "today" | "completions">): Streak {
    return new Streak(CompletionHistory.of(data));
  }

  /** Today already has a finished task. */
  get lit(): boolean {
    return !this.open;
  }

  /** One short line under the count. */
  note(): string {
    if (!this.days) return "Finish one task to start a streak.";
    if (this.open) return "Finish one task today to keep it.";
    return this.days >= this.best && this.days > 1
      ? "Your longest yet."
      : `Best: ${this.best} ${this.best === 1 ? "day" : "days"}.`;
  }
}
