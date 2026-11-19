import { CALENDAR, TIME } from "../shared/time-constants.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { CompletionHistory } from "./completion-history.ts";
import { INSIGHT_RULES, PLANNER_LIMITS } from "./constants.ts";
import type { Dashboard, Task } from "./types.ts";

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

const ENTRY_LENGTH = 3;
const PERCENT = 100;

/** The device-only log of finished tasks, and the insight shown last. */
export class InsightLog {
  entries: CompletionEntry[];
  /** The last insight shown, so the same one never drops twice in a row. */
  last: string | null;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly key: string;

  private constructor(
    storage: Pick<Storage, "getItem" | "setItem">,
    key: string,
    entries: CompletionEntry[],
    last: string | null,
  ) {
    this.storage = storage;
    this.key = key;
    this.entries = entries;
    this.last = last;
  }

  /** A missing or damaged log only means fewer insights. */
  static load(
    storage: Pick<Storage, "getItem" | "setItem">,
    accountKey: string,
  ): InsightLog {
    const key = STORAGE_KEYS.insights(accountKey);
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (saved && typeof saved === "object") {
        const { log, last } = saved as { log?: unknown; last?: unknown };
        return new InsightLog(
          storage,
          key,
          Array.isArray(log) ? log.filter(InsightLog.isEntry) : [],
          typeof last === "string" ? last : null,
        );
      }
    } catch {
      /* Start a new log. */
    }
    return new InsightLog(storage, key, [], null);
  }

  private static isEntry(entry: unknown): entry is CompletionEntry {
    return (
      Array.isArray(entry) &&
      entry.length === ENTRY_LENGTH &&
      entry.every((value) => Number.isFinite(value) && value >= 0)
    );
  }

  /** Remembers when a task was finished. No task text. */
  record(
    task: Pick<Task, "estimatedMinutes" | "actualSeconds">,
    at: Date,
  ): void {
    this.entries = [
      ...this.entries,
      [
        at.getHours(),
        Math.max(0, Math.round(task.estimatedMinutes)),
        Math.max(0, Math.round(task.actualSeconds)),
      ] satisfies CompletionEntry,
    ].slice(-INSIGHT_RULES.logLimit);
  }

  save(): void {
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({ log: this.entries, last: this.last }),
      );
    } catch {
      /* Without storage there is simply less to draw on next time. */
    }
  }
}

/** Every insight the data supports right now; empty until there is enough of it. */
export class InsightEngine {
  private readonly log: readonly CompletionEntry[];
  private readonly history: CompletionHistory;

  constructor(log: readonly CompletionEntry[], data: Dashboard) {
    this.log = log;
    this.history = CompletionHistory.of(data);
  }

  all(): Insight[] {
    return [
      this.timeOfDay(),
      this.estimates(),
      this.weekday(),
      this.streak(),
      this.weekOverWeek(),
      this.fullDays(),
    ].filter((insight): insight is Insight => insight !== null);
  }

  /** "2×", "1.5×", "12×": one decimal below ten, none when it would be ".0". */
  private static times(ratio: number): string {
    const rounded =
      ratio >= INSIGHT_RULES.wholeTimesFrom
        ? Math.round(ratio)
        : Math.round(ratio * 10) / 10;
    return `${rounded}×`;
  }

  /** A part of the day where clearly more gets finished than in the rest of it. */
  private timeOfDay(): Insight | null {
    const rules = INSIGHT_RULES.timeOfDay;
    if (this.log.length < rules.minLog) return null;
    let best: Insight | null = null;
    let bestRatio = 0;
    for (const { id, label, fromHour, toHour } of rules.windows) {
      const within = this.log.filter(
        ([hour]) => hour >= fromHour && hour < toHour,
      ).length;
      const outside = this.log.length - within;
      if (within < rules.minWithin) continue;
      if (!outside)
        return {
          id: `time:${id}`,
          figure: `${within}/${within}`,
          text: `Every one of your last ${within} tasks was finished ${label}.`,
        };
      const ratio = within / outside;
      if (ratio >= INSIGHT_RULES.clearRatio && ratio > bestRatio) {
        bestRatio = ratio;
        best = {
          id: `time:${id}`,
          figure: InsightEngine.times(ratio),
          text: `You finish ${InsightEngine.times(ratio)} more tasks ${label}.`,
        };
      }
    }
    return best;
  }

  /** How recorded focus time compares with what was estimated. */
  private estimates(): Insight | null {
    const rules = INSIGHT_RULES.estimates;
    const timed = this.log.filter(
      ([, minutes, seconds]) => minutes > 0 && seconds > 0,
    );
    if (timed.length < rules.minTimed) return null;
    const planned = timed.reduce(
      (sum, [, minutes]) => sum + minutes * TIME.secondsPerMinute,
      0,
    );
    const spent = timed.reduce((sum, [, , seconds]) => sum + seconds, 0);
    const ratio = spent / planned;
    if (ratio <= rules.fastRatio) {
      const faster = Math.round((1 - ratio) * PERCENT);
      return {
        id: "estimate:fast",
        figure: `${faster}%`,
        text: `You finish about ${faster}% faster than you estimate.`,
      };
    }
    if (ratio >= rules.slowRatio)
      return {
        id: "estimate:slow",
        figure: InsightEngine.times(ratio),
        text: `Your tasks take about ${InsightEngine.times(ratio)} your estimate. Give them room.`,
      };
    const off = Math.max(1, Math.round(Math.abs(1 - ratio) * PERCENT));
    return {
      id: "estimate:close",
      figure: `${off}%`,
      text: `Your estimates land within ${off}% of the time you actually spend.`,
    };
  }

  /** One weekday clearly ahead of the others over the last eight weeks. */
  private weekday(): Insight | null {
    const rules = INSIGHT_RULES.weekday;
    const totals = this.history.totalsByWeekday(rules.windowDays);
    const total = totals.reduce((sum, count) => sum + count, 0);
    const top = Math.max(...totals);
    const usual = (total - top) / (CALENDAR.daysPerWeek - 1);
    if (total < rules.minTotal || usual <= 0) return null;
    const ratio = top / usual;
    if (ratio < INSIGHT_RULES.clearRatio) return null;
    const name = CALENDAR.weekdayNames[totals.indexOf(top)];
    return {
      id: "weekday",
      figure: InsightEngine.times(ratio),
      text: `${name}s are your day: ${InsightEngine.times(ratio)} more done than on your other days.`,
    };
  }

  private streak(): Insight | null {
    const streak = this.history.currentStreak();
    if (streak < INSIGHT_RULES.streak.minDays) return null;
    const best = this.history.bestStreak();
    return {
      id: "streak",
      figure: String(streak),
      text:
        streak >= best
          ? `${streak} days in a row. That’s your longest streak yet.`
          : `${streak} days in a row. Your best is ${best}.`,
    };
  }

  /** Monday to Sunday, like the rest of the app. */
  private weekOverWeek(): Insight | null {
    const monday = this.history.today.weekStart();
    const thisWeek = this.history.totalSince(monday);
    const lastWeek = this.history.totalBetween(
      monday.plus(-CALENDAR.daysPerWeek),
      monday.previous(),
    );
    if (lastWeek <= 0 || thisWeek <= lastWeek) return null;
    const more = thisWeek - lastWeek;
    return {
      id: "week",
      figure: `+${more}`,
      text: `You’ve already finished ${more} more ${more === 1 ? "task" : "tasks"} than in all of last week.`,
    };
  }

  private fullDays(): Insight | null {
    const rules = INSIGHT_RULES.fullDays;
    const days = this.history.daysWithAtLeast(
      PLANNER_LIMITS.tasksPerDay,
      rules.windowDays,
    );
    if (days < rules.minDays) return null;
    return {
      id: "full-days",
      figure: `${days}/${rules.windowDays}`,
      text: `You cleared all five tasks on ${days} of the last ${rules.windowDays} days.`,
    };
  }
}

/** Picks, now and then, an insight to show after a task is finished on this device. */
export class InsightDrops {
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly accountKey: string;
  private readonly random: () => number;

  constructor(
    storage: Pick<Storage, "getItem" | "setItem">,
    accountKey: string,
    random: () => number = Math.random,
  ) {
    this.storage = storage;
    this.accountKey = accountKey;
    this.random = random;
  }

  /** Logs the finished task and, some of the time, returns an insight to show. */
  afterCompletion(
    task: Pick<Task, "estimatedMinutes" | "actualSeconds">,
    data: Dashboard,
    now = new Date(),
  ): Insight | null {
    const log = InsightLog.load(this.storage, this.accountKey);
    log.record(task, now);
    let dropped: Insight | null = null;
    if (this.random() < INSIGHT_RULES.dropChance) {
      const candidates = new InsightEngine(log.entries, data)
        .all()
        .filter((insight) => insight.id !== log.last);
      dropped =
        candidates[
          Math.min(
            candidates.length - 1,
            Math.floor(this.random() * candidates.length),
          )
        ] ?? null;
      if (dropped) log.last = dropped.id;
    }
    log.save();
    return dropped;
  }
}
