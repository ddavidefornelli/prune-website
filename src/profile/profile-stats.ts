import { CompletionHistory } from "../planner/completion-history.ts";
import { DayPlan } from "../planner/day-plan.ts";
import type { Dashboard } from "../planner/types.ts";

/**
 * The owner's all-time and recent numbers. Calendar arithmetic uses date keys,
 * not elapsed local hours (which vary across DST). Weeks run Monday to Sunday,
 * like weekly reviews.
 */
export class ProfileStats {
  readonly totalCompleted: number;
  readonly activeDays: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly todayCompleted: number;
  readonly weekCompleted: number;
  readonly monthCompleted: number;
  /** The dashboard has no historical focus totals, so this stays scoped to today. */
  readonly todayFocusSeconds: number;
  readonly todayEstimatedMinutes: number;

  constructor(data: Dashboard, now = data.serverNow) {
    const history = CompletionHistory.of(data);
    const today = history.today;
    const plan = new DayPlan(data.todayTasks);
    this.totalCompleted = history.total;
    this.activeDays = history.activeDays;
    this.currentStreak = history.currentStreak();
    this.bestStreak = history.bestStreak();
    this.todayCompleted = history.countOn(today);
    this.weekCompleted = history.totalSince(today.weekStart());
    this.monthCompleted = history.totalSince(today.monthStart());
    this.todayFocusSeconds = plan.focusedSeconds(now);
    this.todayEstimatedMinutes = plan.estimatedMinutes;
  }
}
