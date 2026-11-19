import { TIME } from "../shared/time-constants.ts";
import type {
  PlanSettings,
  CheckInPlan,
  WeeklyReview,
} from "../planner/types.ts";
import { CHECK_IN, NO_PLAN } from "./constants.ts";

/**
 * The weekly check-in's numbers, worked out on the device from the saved
 * reviews. Like a weight trend, each one is smoothed across weeks so one odd
 * week moves it only part of the way.
 */

const PERCENT = 100;

const within = (day: string | null, start: string, end: string) =>
  day !== null && day >= start && day <= end;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** One reviewed week, as the trends read it. */
export class WeekPoint {
  readonly start: string;
  readonly end: string;
  readonly planned: number;
  readonly completed: number;
  /** Days with at least one finished task. */
  readonly activeDays: number;
  /** Recorded focus on finished tasks over what was estimated; null without timed tasks. */
  readonly estimateRatio: number | null;
  readonly timedTasks: number;
  readonly focusSeconds: number;

  constructor(review: WeeklyReview) {
    const { weekStart: start, weekEnd: end, activity } = review;
    const done = activity.tasks.filter(
      (task) =>
        task.status === "completed" && within(task.completedOn, start, end),
    );
    const timed = done.filter((task) => task.actualSeconds > 0);
    const estimated = timed.reduce(
      (sum, task) => sum + task.estimatedMinutes * TIME.secondsPerMinute,
      0,
    );
    const actual = timed.reduce((sum, task) => sum + task.actualSeconds, 0);
    this.start = start;
    this.end = end;
    this.planned = activity.tasks.filter((task) =>
      within(task.plannedFor, start, end),
    ).length;
    this.completed = done.length;
    this.activeDays = new Set(done.map((task) => task.completedOn)).size;
    this.estimateRatio = estimated ? actual / estimated : null;
    this.timedTasks = timed.length;
    this.focusSeconds = done.reduce((sum, task) => sum + task.actualSeconds, 0);
  }

  /** Tasks finished on a day worked. */
  get pace(): number | null {
    return this.activeDays ? this.completed / this.activeDays : null;
  }

  /** Focus minutes on a day worked. */
  get capacityMinutes(): number | null {
    return this.activeDays
      ? this.focusSeconds / TIME.secondsPerMinute / this.activeDays
      : null;
  }

  /** Oldest first, at most `limit` weeks. */
  static fromReviews(
    reviews: readonly WeeklyReview[],
    limit: number = CHECK_IN.weeks,
  ): WeekPoint[] {
    return [...reviews]
      .sort((a, b) => (a.weekEnd < b.weekEnd ? -1 : 1))
      .slice(-limit)
      .map((review) => new WeekPoint(review));
  }
}

/** An exponentially smoothed line through the values that exist. */
export class Trend {
  readonly values: (number | null)[];

  constructor(samples: readonly (number | null)[]) {
    let level: number | null = null;
    this.values = samples.map((value) => {
      if (value === null) return level;
      level =
        level === null ? value : level + CHECK_IN.smoothing * (value - level);
      return level;
    });
  }

  get latest(): number | null {
    return this.values.at(-1) ?? null;
  }
}

/** What the weeks say, and the plan they suggest for the next one. */
export class CheckInSummary {
  readonly points: WeekPoint[];
  /** Smoothed: recorded time over estimate. 1.3 means tasks run 30% long. */
  readonly estimateTrend: (number | null)[];
  /** Smoothed: tasks finished on a day you worked. */
  readonly paceTrend: (number | null)[];
  /** Smoothed: focus minutes on a day you worked. Your real capacity. */
  readonly capacityMinutes: number | null;
  readonly current: PlanSettings;
  readonly suggested: PlanSettings;
  /** False when the suggestion is the current plan, or within noise of it. */
  readonly changed: boolean;
  /** Enough timed tasks for the estimate suggestion to mean something. */
  readonly enoughTiming: boolean;

  constructor(
    reviews: readonly WeeklyReview[],
    plan: CheckInPlan | null | undefined,
  ) {
    this.points = WeekPoint.fromReviews(reviews);
    const estimates = new Trend(
      this.points.map((point) => point.estimateRatio),
    );
    const pace = new Trend(this.points.map((point) => point.pace));
    const capacity = new Trend(
      this.points.map((point) => point.capacityMinutes),
    ).latest;
    this.estimateTrend = estimates.values;
    this.paceTrend = pace.values;
    this.capacityMinutes = capacity === null ? null : Math.round(capacity);
    this.current = plan
      ? { estimateFactor: plan.estimateFactor, dailyTarget: plan.dailyTarget }
      : NO_PLAN;
    this.enoughTiming =
      this.points.reduce((sum, point) => sum + point.timedTasks, 0) >=
      CHECK_IN.minTimedTasks;
    this.suggested = {
      estimateFactor: this.suggestFactor(estimates.latest),
      dailyTarget:
        pace.latest === null
          ? this.current.dailyTarget
          : clamp(
              Math.round(pace.latest),
              CHECK_IN.targetRange.min,
              CHECK_IN.targetRange.max,
            ),
    };
    this.changed =
      this.suggested.estimateFactor !== this.current.estimateFactor ||
      this.suggested.dailyTarget !== this.current.dailyTarget;
  }

  /** "30% over", "10% under", "On estimate". */
  static ratioLabel(ratio: number): string {
    const percent = Math.round((ratio - 1) * PERCENT);
    if (Math.abs(percent) < CHECK_IN.onEstimatePercent) return "On estimate";
    return `${Math.abs(percent)}% ${percent > 0 ? "over" : "under"}`;
  }

  /** Estimates made under the current plan are already padded by it. */
  private suggestFactor(ratio: number | null): number {
    const current = this.current.estimateFactor;
    if (!this.enoughTiming || ratio === null) return current;
    const { factorStep, factorRange, factorNoise } = CHECK_IN;
    const factor = Number(
      clamp(
        Math.round((current * ratio) / factorStep) * factorStep,
        factorRange.min,
        factorRange.max,
      ).toFixed(2),
    );
    return Math.abs(factor - current) < factorNoise ? current : factor;
  }
}
