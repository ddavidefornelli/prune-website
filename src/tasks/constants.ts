import { TIME } from "../shared/time-constants.ts";

/** Mirrors the limits planner_list enforces (20261124000100_task_list.sql). */
export const TASK_LIMITS = {
  titleLength: 500,
  tasks: 1000,
  savesPerSync: 200,
  removesPerSync: 1000,
} as const;

/** When the list talks to the cloud. */
export const LIST_SYNC = {
  /** A burst of edits goes out together. */
  debounceMs: 400,
  /** Picks up edits from other devices while the page is visible. */
  pollMs: 30 * TIME.msPerSecond,
  initialRetryMs: 2 * TIME.msPerSecond,
  maxRetryMs: TIME.minuteMs,
  /**
   * Making a guest is retried more slowly: Supabase allows each address only
   * so many new anonymous users an hour.
   */
  maxIdentityRetryMs: 5 * TIME.minuteMs,
} as const;

/** Moments the list waits for, in milliseconds. */
export const LIST_TIMING = {
  /** A ticked task stays in place this long before it moves to Done. */
  settleMs: 700,
  /** How long Undo is offered after deleting. */
  undoMs: 6 * TIME.msPerSecond,
  /**
   * An edit ends this long after the editor loses focus, so a tap on the row's
   * × (which takes focus first on phones) still lands while × is showing.
   */
  blurGraceMs: 250,
} as const;
