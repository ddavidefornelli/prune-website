/** Browser UI bounds mirror independently enforced database constraints. */
export const PLANNER_LIMITS = {
  tasksPerDay: 3,
  outcomeLength: 500,
  stopReasonLength: 1000,
} as const;

export const ESTIMATE = {
  min: 5,
  max: 60,
  step: 5,
  defaultMinutes: 30,
  sweep: 300,
} as const;
export const POLLING = {
  clock: 1000,
  dashboard: 30_000,
  weeklyReview: 60_000,
  pendingReview: 3000,
} as const;
export const MOBILE_QUERY = "(max-width: 759px)";
export const WEEKLY_AI_VERSION = "weekly-ai-v1";

export const VIEW_LABELS = {
  today: "Today",
  focus: "Focus",
  tomorrow: "Tomorrow",
  habits: "Overview",
  profile: "Profile",
} as const;
export type PlannerView = keyof typeof VIEW_LABELS;
export const NAVIGATION_VIEWS = [
  "today",
  "focus",
  "tomorrow",
  "habits",
] as const;
