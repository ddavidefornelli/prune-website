import { DAY_MS } from "./time.ts";
import type { Dashboard } from "./types.ts";

export interface StreakDay {
  /** One-letter weekday, Monday first. */
  label: string;
  state: "done" | "missed" | "today" | "ahead";
}

export interface Streak {
  /** Days in a row with at least one finished task. */
  days: number;
  best: number;
  /** True while today has no finished task yet and a streak is at stake. */
  open: boolean;
  /** This week, Monday to Sunday, like the rest of the app. */
  week: StreakDay[];
}

const LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const dayNumber = (day: string): number =>
  Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * A streak stays alive until a whole day passes without a finished task, so
 * yesterday's run still counts this morning. Date keys, not local hours.
 */
export function streakFor(
  data: Pick<Dashboard, "today" | "completions">,
): Streak {
  const today = dayNumber(data.today);
  const active = new Set<number>();
  for (const { day, count } of data.completions) {
    const date = dayNumber(day);
    if (date <= today && count > 0) active.add(date);
  }
  let days = 0;
  for (let day = active.has(today) ? today : today - 1; active.has(day); day--)
    days++;
  let best = days;
  for (const day of active) {
    if (active.has(day - 1)) continue;
    let run = 1;
    while (active.has(day + run)) run++;
    best = Math.max(best, run);
  }
  const weekStart = today - ((new Date(today * DAY_MS).getUTCDay() + 6) % 7);
  return {
    days,
    best,
    open: !active.has(today),
    week: LABELS.map((label, index) => {
      const day = weekStart + index;
      return {
        label,
        state: active.has(day)
          ? "done"
          : day === today
            ? "today"
            : day > today
              ? "ahead"
              : "missed",
      };
    }),
  };
}

/** One short line under the count. */
export function streakNote(streak: Streak): string {
  if (!streak.days) return "Finish one task to start a streak.";
  if (streak.open) return "Finish one task today to keep it.";
  return streak.days >= streak.best && streak.days > 1
    ? "Your longest yet."
    : `Best: ${streak.best} ${streak.best === 1 ? "day" : "days"}.`;
}
