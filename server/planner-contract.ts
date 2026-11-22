/**
 * The day planner's contract, as the backend functions that still serve it
 * (weekly reviews, task suggestions, reminders) read it. The website became a
 * plain task list on 2026-11-22 and no longer calls the review or suggestion
 * functions; delete this file together with them.
 */

export type TaskStatus = "planned" | "active" | "completed";

interface PlannerTask {
  id: string;
  outcome: string;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: TaskStatus;
  completedOn: string | null;
}

export type SuggestionTarget = "today" | "tomorrow";

/** AI proposal for a day, derived server-side from the day before. */
export interface TaskSuggestion {
  outcome: string;
  estimatedMinutes: number;
  basis: "carry_over" | "follow_up";
}

interface ReviewStop {
  id: number;
  taskId: string;
  reason: string;
  stoppedOn: string;
}

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  generatedAt: number;
  model: string;
  activity: {
    tasks: PlannerTask[];
    stops: ReviewStop[];
    totalStops: number;
    omittedStops: number;
  };
  analysis: {
    summary: string;
    mainReasons: { reason: string; evidenceStopIds: number[] }[];
    improvements: string[];
  };
}

/** Bounds the database enforces on planner tasks. */
export const PLANNER_LIMITS = {
  tasksPerDay: 5,
  outcomeLength: 500,
  stopReasonLength: 1000,
} as const;

export const ESTIMATE = {
  min: 5,
  max: 60,
  step: 5,
  defaultMinutes: 30,
} as const;

/** The consent version the weekly-review function checks. */
export const WEEKLY_AI_VERSION = "weekly-ai-v1";

/** Reminder links open /?start=next. */
export const START_LINK = { param: "start", value: "next" } as const;

/** Estimates are whole steps between the dial's ends. */
export class Estimate {
  /** Rounds to the dial's step and clamps to its range. */
  static normalize(minutes: number): number {
    const stepped = Math.round(minutes / ESTIMATE.step) * ESTIMATE.step;
    return Math.min(ESTIMATE.max, Math.max(ESTIMATE.min, stepped));
  }
}
