import { PLANNER_LIMITS } from "../planner/constants.ts";
import type { PlanSettings } from "../planner/types.ts";

/** How the weekly check-in turns saved reviews into a plan. */
export const CHECK_IN = {
  /** How far one new week moves a trend. */
  smoothing: 0.5,
  /** Fewer timed tasks than this say too little about estimates. */
  minTimedTasks: 3,
  /** Weeks of reviews the trends look at. */
  weeks: 8,
  /** Suggested factors are rounded to this. */
  factorStep: 0.05,
  /** Changes smaller than this are noise: keep the plan. */
  factorNoise: 0.1,
  factorRange: { min: 0.5, max: 3 },
  targetRange: { min: 1, max: PLANNER_LIMITS.tasksPerDay },
  /** Within this many percent, an estimate is "on estimate". */
  onEstimatePercent: 5,
} as const;

/** The plan before any check-in was accepted. */
export const NO_PLAN: PlanSettings = {
  estimateFactor: 1,
  dailyTarget: PLANNER_LIMITS.tasksPerDay,
};

/** Older servers send only a date; their check-ins land at this local hour. */
export const LEGACY_CHECK_IN_HOUR = 16;
