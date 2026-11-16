import { PLANNER_LIMITS } from "./constants.ts";
import { DAY_MS } from "./time.ts";
import type { Dashboard } from "./types.ts";

/**
 * Small facts about the owner's own habits, dropped at random when a task is
 * finished. Everything is worked out in the browser. Time of day and estimate
 * accuracy come from a short log kept on this device only (no task text);
 * the rest comes from the completion history the planner already has.
 */
export interface Insight {
  id: string;
  /** Small label above; "About you" unless set. */
  eyebrow?: string;
  /** The number, shown large. */
  figure: string;
  /** A full sentence that also reads on its own. */
  text: string;
}

/** One finished task: local hour, estimated minutes, focused seconds. */
export type CompletionEntry = [hour: number, minutes: number, seconds: number];

interface InsightLog {
  log: CompletionEntry[];
  /** The last insight shown, so the same one never drops twice in a row. */
  last: string | null;
}

const LOG_LIMIT = 200;
/** How often a finished task drops an insight, when there is one to show. */
export const DROP_CHANCE = 0.4;
const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

export const insightKey = (accountKey: string) =>
  `prune:insights:v1:${accountKey}`;

function readLog(storage: Pick<Storage, "getItem">, key: string): InsightLog {
  try {
    const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (saved && typeof saved === "object") {
      const { log, last } = saved as Partial<InsightLog>;
      return {
        log: Array.isArray(log)
          ? log.filter(
              (entry): entry is CompletionEntry =>
                Array.isArray(entry) &&
                entry.length === 3 &&
                entry.every((value) => Number.isFinite(value) && value >= 0),
            )
          : [],
        last: typeof last === "string" ? last : null,
      };
    }
  } catch {
    /* A missing or damaged log only means fewer insights. */
  }
  return { log: [], last: null };
}

/** "2×", "1.5×", "12×": one decimal below ten, none when it would be ".0". */
function times(ratio: number): string {
  const rounded = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
  return `${rounded}×`;
}

const dayNumber = (day: string): number =>
  Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** A part of the day where clearly more gets finished than in the rest of it. */
function timeOfDay(log: CompletionEntry[]): Insight | null {
  if (log.length < 6) return null;
  const windows = [
    {
      id: "morning",
      label: "before 11am",
      inside: (hour: number) => hour < 11,
    },
    { id: "evening", label: "after 5pm", inside: (hour: number) => hour >= 17 },
  ];
  let best: Insight | null = null;
  let bestRatio = 0;
  for (const { id, label, inside } of windows) {
    const within = log.filter(([hour]) => inside(hour)).length;
    const outside = log.length - within;
    if (within < 4) continue;
    if (!outside)
      return {
        id: `time:${id}`,
        figure: `${within}/${within}`,
        text: `Every one of your last ${within} tasks was finished ${label}.`,
      };
    const ratio = within / outside;
    if (ratio >= 1.5 && ratio > bestRatio) {
      bestRatio = ratio;
      best = {
        id: `time:${id}`,
        figure: times(ratio),
        text: `You finish ${times(ratio)} more tasks ${label}.`,
      };
    }
  }
  return best;
}

/** How recorded focus time compares with what was estimated. */
function estimates(log: CompletionEntry[]): Insight | null {
  const timed = log.filter(
    ([, minutes, seconds]) => minutes > 0 && seconds > 0,
  );
  if (timed.length < 5) return null;
  const planned = timed.reduce((sum, [, minutes]) => sum + minutes * 60, 0);
  const spent = timed.reduce((sum, [, , seconds]) => sum + seconds, 0);
  const ratio = spent / planned;
  if (ratio <= 0.85) {
    const faster = Math.round((1 - ratio) * 100);
    return {
      id: "estimate:fast",
      figure: `${faster}%`,
      text: `You finish about ${faster}% faster than you estimate.`,
    };
  }
  if (ratio >= 1.2)
    return {
      id: "estimate:slow",
      figure: times(ratio),
      text: `Your tasks take about ${times(ratio)} your estimate. Give them room.`,
    };
  const off = Math.max(1, Math.round(Math.abs(1 - ratio) * 100));
  return {
    id: "estimate:close",
    figure: `${off}%`,
    text: `Your estimates land within ${off}% of the time you actually spend.`,
  };
}

function history(data: Dashboard): Insight[] {
  const today = dayNumber(data.today);
  const counts = new Map<number, number>();
  for (const { day, count } of data.completions) {
    const date = dayNumber(day);
    if (date <= today && count > 0)
      counts.set(date, (counts.get(date) ?? 0) + count);
  }
  const found: Insight[] = [];

  // One weekday clearly ahead of the others over the last eight weeks.
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const [date, count] of counts)
    if (date > today - 56)
      byWeekday[new Date(date * DAY_MS).getUTCDay()] += count;
  const total = byWeekday.reduce((sum, count) => sum + count, 0);
  const top = Math.max(...byWeekday);
  const usual = (total - top) / 6;
  if (total >= 8 && usual > 0 && top / usual >= 1.5)
    found.push({
      id: "weekday",
      figure: times(top / usual),
      text: `${WEEKDAYS[byWeekday.indexOf(top)]} are your day: ${times(top / usual)} more done than on your other days.`,
    });

  // A streak stays current until a whole day passes without a completion.
  let streak = 0;
  for (let day = counts.has(today) ? today : today - 1; counts.has(day); day--)
    streak++;
  if (streak >= 3) {
    let best = 0;
    for (const day of counts.keys()) {
      if (counts.has(day - 1)) continue;
      let run = 1;
      while (counts.has(day + run)) run++;
      best = Math.max(best, run);
    }
    found.push({
      id: "streak",
      figure: String(streak),
      text:
        streak >= best
          ? `${streak} days in a row. That’s your longest streak yet.`
          : `${streak} days in a row. Your best is ${best}.`,
    });
  }

  // Monday to Sunday, like the rest of the app.
  const weekStart = today - ((new Date(today * DAY_MS).getUTCDay() + 6) % 7);
  let thisWeek = 0;
  let lastWeek = 0;
  for (const [date, count] of counts) {
    if (date >= weekStart) thisWeek += count;
    else if (date >= weekStart - 7) lastWeek += count;
  }
  if (lastWeek > 0 && thisWeek > lastWeek)
    found.push({
      id: "week",
      figure: `+${thisWeek - lastWeek}`,
      text: `You’ve already finished ${thisWeek - lastWeek} more ${thisWeek - lastWeek === 1 ? "task" : "tasks"} than in all of last week.`,
    });

  let fullDays = 0;
  for (const [date, count] of counts)
    if (date > today - 14 && count >= PLANNER_LIMITS.tasksPerDay) fullDays++;
  if (fullDays >= 3)
    found.push({
      id: "full-days",
      figure: `${fullDays}/14`,
      text: `You cleared all five tasks on ${fullDays} of the last 14 days.`,
    });
  return found;
}

/** Every insight the data supports right now; empty until there is enough of it. */
export function insights(log: CompletionEntry[], data: Dashboard): Insight[] {
  return [timeOfDay(log), estimates(log), ...history(data)].filter(
    (insight): insight is Insight => insight !== null,
  );
}

/**
 * Call once for each task finished on this device. Remembers when it was
 * finished and, some of the time, returns an insight to show.
 */
export function completionInsight(
  storage: Pick<Storage, "getItem" | "setItem">,
  accountKey: string,
  task: { estimatedMinutes: number; actualSeconds: number },
  data: Dashboard,
  now = new Date(),
  random: () => number = Math.random,
): Insight | null {
  const key = insightKey(accountKey);
  const saved = readLog(storage, key);
  saved.log = [
    ...saved.log,
    [
      now.getHours(),
      Math.max(0, Math.round(task.estimatedMinutes)),
      Math.max(0, Math.round(task.actualSeconds)),
    ] satisfies CompletionEntry,
  ].slice(-LOG_LIMIT);
  let dropped: Insight | null = null;
  if (random() < DROP_CHANCE) {
    const candidates = insights(saved.log, data).filter(
      (insight) => insight.id !== saved.last,
    );
    dropped =
      candidates[
        Math.min(
          candidates.length - 1,
          Math.floor(random() * candidates.length),
        )
      ] ?? null;
    if (dropped) saved.last = dropped.id;
  }
  try {
    storage.setItem(key, JSON.stringify(saved));
  } catch {
    /* Without storage there is simply less to draw on next time. */
  }
  return dropped;
}
