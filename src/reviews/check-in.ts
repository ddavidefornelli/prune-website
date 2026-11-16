import { ESTIMATE, PLANNER_LIMITS } from "../planner/constants.ts";
import type { CheckInPlan, WeeklyReview } from "../planner/types.ts";

/**
 * The weekly check-in's numbers, worked out on the device from the saved
 * reviews. Like a weight trend, each one is smoothed across weeks so one odd
 * week moves it only part of the way.
 */

/** How far one new week moves a trend. */
const SMOOTHING = 0.5;
/** Fewer timed tasks than this say too little about estimates. */
const MIN_TIMED_TASKS = 3;
/** Changes smaller than this are noise: keep the plan. */
const FACTOR_STEP = 0.05;
const FACTOR_NOISE = 0.1;
export const FACTOR_RANGE = { min: 0.5, max: 3 } as const;

export const NO_PLAN: Omit<CheckInPlan, "decidedFor"> = {
  estimateFactor: 1,
  dailyTarget: PLANNER_LIMITS.tasksPerDay,
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface WeekPoint {
  start: string;
  end: string;
  planned: number;
  completed: number;
  /** Days with at least one finished task. */
  activeDays: number;
  /** Recorded focus on finished tasks over what was estimated; null without timed tasks. */
  estimateRatio: number | null;
  timedTasks: number;
  focusSeconds: number;
}

const within = (day: string | null, start: string, end: string) =>
  day !== null && day >= start && day <= end;

export function weekPoint(review: WeeklyReview): WeekPoint {
  const { weekStart: start, weekEnd: end, activity } = review;
  const done = activity.tasks.filter(
    (task) =>
      task.status === "completed" && within(task.completedOn, start, end),
  );
  const timed = done.filter((task) => task.actualSeconds > 0);
  const estimated = timed.reduce(
    (sum, task) => sum + task.estimatedMinutes * 60,
    0,
  );
  const actual = timed.reduce((sum, task) => sum + task.actualSeconds, 0);
  return {
    start,
    end,
    planned: activity.tasks.filter((task) =>
      within(task.plannedFor, start, end),
    ).length,
    completed: done.length,
    activeDays: new Set(done.map((task) => task.completedOn)).size,
    estimateRatio: estimated ? actual / estimated : null,
    timedTasks: timed.length,
    focusSeconds: done.reduce((sum, task) => sum + task.actualSeconds, 0),
  };
}

/** Oldest first, at most `limit` weeks. */
export function weekPoints(
  reviews: readonly WeeklyReview[],
  limit = 8,
): WeekPoint[] {
  return [...reviews]
    .sort((a, b) => (a.weekEnd < b.weekEnd ? -1 : 1))
    .slice(-limit)
    .map(weekPoint);
}

/** An exponentially smoothed line through the values that exist. */
export function trend(values: readonly (number | null)[]): (number | null)[] {
  let level: number | null = null;
  return values.map((value) => {
    if (value === null) return level;
    level = level === null ? value : level + SMOOTHING * (value - level);
    return level;
  });
}

const last = <T>(values: readonly (T | null)[]): T | null =>
  values.length ? (values[values.length - 1] ?? null) : null;

export interface CheckInSummary {
  points: WeekPoint[];
  /** Smoothed: recorded time over estimate. 1.3 means tasks run 30% long. */
  estimateTrend: (number | null)[];
  /** Smoothed: tasks finished on a day you worked. */
  paceTrend: (number | null)[];
  /** Smoothed: focus minutes on a day you worked. Your real capacity. */
  capacityMinutes: number | null;
  current: Omit<CheckInPlan, "decidedFor">;
  suggested: Omit<CheckInPlan, "decidedFor">;
  /** False when the suggestion is the current plan, or within noise of it. */
  changed: boolean;
  /** Why each number in the suggestion is what it is, for the plan card. */
  enoughTiming: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const roundTo = (value: number, step: number) =>
  Math.round(value / step) * step;

export function checkInSummary(
  reviews: readonly WeeklyReview[],
  plan: CheckInPlan | null | undefined,
): CheckInSummary {
  const points = weekPoints(reviews);
  const estimateTrend = trend(points.map((point) => point.estimateRatio));
  const paceTrend = trend(
    points.map((point) =>
      point.activeDays ? point.completed / point.activeDays : null,
    ),
  );
  const capacity = last(
    trend(
      points.map((point) =>
        point.activeDays ? point.focusSeconds / 60 / point.activeDays : null,
      ),
    ),
  );
  const current = plan
    ? { estimateFactor: plan.estimateFactor, dailyTarget: plan.dailyTarget }
    : NO_PLAN;
  const enoughTiming =
    points.reduce((sum, point) => sum + point.timedTasks, 0) >= MIN_TIMED_TASKS;
  const ratio = last(estimateTrend);
  const pace = last(paceTrend);
  // Estimates made under the current plan are already padded by it.
  const factor =
    enoughTiming && ratio !== null
      ? Number(
          clamp(
            roundTo(current.estimateFactor * ratio, FACTOR_STEP),
            FACTOR_RANGE.min,
            FACTOR_RANGE.max,
          ).toFixed(2),
        )
      : current.estimateFactor;
  const suggested = {
    estimateFactor:
      Math.abs(factor - current.estimateFactor) < FACTOR_NOISE
        ? current.estimateFactor
        : factor,
    dailyTarget:
      pace === null
        ? current.dailyTarget
        : clamp(Math.round(pace), 1, PLANNER_LIMITS.tasksPerDay),
  };
  return {
    points,
    estimateTrend,
    paceTrend,
    capacityMinutes: capacity === null ? null : Math.round(capacity),
    current,
    suggested,
    changed:
      suggested.estimateFactor !== current.estimateFactor ||
      suggested.dailyTarget !== current.dailyTarget,
    enoughTiming,
  };
}

/** The estimate a new task starts at under the plan. */
export function plannedEstimate(factor = 1): number {
  return clamp(
    roundTo(ESTIMATE.defaultMinutes * factor, ESTIMATE.step),
    ESTIMATE.min,
    ESTIMATE.max,
  );
}

/** "30% over", "10% under", "On estimate". */
export function ratioLabel(ratio: number): string {
  const percent = Math.round((ratio - 1) * 100);
  if (Math.abs(percent) < 5) return "On estimate";
  return `${Math.abs(percent)}% ${percent > 0 ? "over" : "under"}`;
}
