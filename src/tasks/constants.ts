import { TIME } from "../shared/time-constants.ts";

/** Mirrors the limits planner_list enforces (20261124000100_task_list.sql). */
export const TASK_LIMITS = {
  titleLength: 500,
  tasks: 1000,
  savesPerSync: 200,
  removesPerSync: 1000,
} as const;

/**
 * Open tasks one list may hold, checked here (2026-11-22: a short list on
 * purpose, not a place for power use). Done tasks do not count.
 */
export const OPEN_TASK_LIMIT = 5;

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

/** A mouse or trackpad: the page can open ready to type without a keyboard covering it. */
export const FINE_POINTER = "(pointer: fine)";

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

/** When "Do it for me" talks to the helper. */
export const HELPER_TIMING = {
  /** New tasks are sorted in a batch this long after the last change. */
  classifyDebounceMs: 1500,
  /** After a failed sort, wait this long before trying again. */
  classifyRetryMs: TIME.minuteMs,
  /** How often an answer being written is checked on. */
  pollMs: 3 * TIME.msPerSecond,
} as const;

/** A shared list's link: `/?join=<token>` (see planner_list 'share'). */
export const SHARE = {
  joinParam: "join",
  tokenPattern: /^[0-9a-f]{32}$/i,
  /** How long "Copied" shows on the button. */
  copiedMs: 1500,
} as const;

/** Spaces (see planner_list): names on screen and the server's limits. */
export const SPACES = {
  personalName: "Personal",
  /** A group space nobody named yet. */
  groupName: "Shared list",
  nameLength: 60,
} as const;
