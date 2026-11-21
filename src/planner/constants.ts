import { TIME } from "../shared/time-constants.ts";

/** Browser UI bounds mirror independently enforced database constraints. */
export const PLANNER_LIMITS = {
  tasksPerDay: 5,
  outcomeLength: 500,
  stopReasonLength: 1000,
  emailLength: 254,
} as const;

export const ESTIMATE = {
  min: 5,
  max: 60,
  step: 5,
  defaultMinutes: 30,
  /** The one-tap choices on the first-task screen. */
  quickPicks: [15, 30, 45, 60],
  /** Degrees of the dial's arc. */
  sweep: 300,
} as const;

export const POLLING = {
  clock: 1000,
  dashboard: 30_000,
  weeklyReview: 60_000,
  pendingReview: 3000,
} as const;

export const MEDIA_QUERIES = {
  mobile: "(max-width: 759px)",
  desktop: "(hover: hover) and (min-width: 760px)",
  reducedMotion: "(prefers-reduced-motion: reduce)",
  standalone: "(display-mode: standalone)",
  finePointer: "(pointer: fine)",
} as const;

/** Sent with `set_weekly_ai_enabled`; the server checks it. */
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
] as const satisfies readonly PlannerView[];

/** The durable outbox and the server protocol it speaks. */
export const QUEUE = {
  /** Part of the storage key: a new format needs a new version. */
  storageVersion: 1,
  /** `queue_protocol` must answer this before any write is sent. */
  protocolVersion: 1,
  initialRetryMs: 1000,
  maxRetryMs: 60_000,
} as const;

/** Moments the planner reacts to, in milliseconds. */
export const PLANNER_TIMING = {
  /** How long after pressing Complete task the streak may light the party. */
  partyWindowMs: 15_000,
  /** Away at least this long and back: counted as another visit. */
  returnAfterMs: 30 * TIME.minuteMs,
} as const;

/** When the one-time tips on Today appear. */
export const HINT_RULES = {
  /** "Plan tomorrow" shows from this local hour. */
  eveningHour: 17,
  /** The Overview tip shows while lifetime completions are at most this. */
  progressMaxCompleted: 3,
  /** Keyboard shortcuts are suggested from this visit on, on desktops. */
  shortcutsAfterVisits: 3,
} as const;

/** Onboarding's first task. */
export const ONBOARDING_RULES = {
  /** From this local hour, the first task is planned for tomorrow. */
  lateHour: 20,
} as const;

/** The words for a daily target, "one" to "five". */
export const COUNT_WORDS = ["one", "two", "three", "four", "five"] as const;

/** Reminder links open /?start=next. */
export const START_LINK = { param: "start", value: "next" } as const;

/** Query parameters the Google sign-in redirect adds and the app removes. */
export const OAUTH_CALLBACK = {
  marker: "oauth",
  provider: "google",
  code: "code",
  error: "error",
  params: ["oauth", "code", "error", "error_code", "error_description"],
} as const;

/** When a finished task drops a fact about the owner's habits. */
export const INSIGHT_RULES = {
  /** How often a finished task drops an insight, when there is one to show. */
  dropChance: 0.4,
  /** Completions remembered on this device. */
  logLimit: 200,
  /** "Clearly more" means at least this ratio. */
  clearRatio: 1.5,
  timeOfDay: {
    minLog: 6,
    minWithin: 4,
    windows: [
      { id: "morning", label: "before 11am", fromHour: 0, toHour: 11 },
      { id: "evening", label: "after 5pm", fromHour: 17, toHour: 24 },
    ],
  },
  estimates: {
    minTimed: 5,
    /** At or below: "faster than you estimate". */
    fastRatio: 0.85,
    /** At or above: tasks run long. */
    slowRatio: 1.2,
  },
  weekday: { windowDays: 56, minTotal: 8 },
  streak: { minDays: 3 },
  fullDays: { windowDays: 14, minDays: 3 },
  /** Below this, a ratio shows one decimal ("1.5×"). */
  wholeTimesFrom: 10,
} as const;
