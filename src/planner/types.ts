/**
 * Records exchanged with the server and saved in browser storage. They stay
 * plain JSON objects: Solid stores track plain objects, and snapshots are
 * cloned and serialized. Behaviour lives in the classes that read them.
 */

export type TaskStatus = "planned" | "active" | "completed";

export interface Task {
  /** Mutation-response metadata; omitted from dashboard task rows. */
  serverRevision?: number;
  id: string;
  outcome: string;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: TaskStatus;
  startedAt: number | null;
  completedOn: string | null;
  createdAt: number;
}

export interface Completion {
  day: string;
  count: number;
}

export interface Dashboard {
  revision?: number;
  today: string;
  tomorrow: string;
  todayTasks: Task[];
  tomorrowTasks: Task[];
  activeTask: Task | null;
  completions: Completion[];
  serverNow: number;
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

type ReviewTask = Pick<
  Task,
  | "id"
  | "outcome"
  | "plannedFor"
  | "completedOn"
  | "status"
  | "estimatedMinutes"
  | "actualSeconds"
>;

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  generatedAt: number;
  model: string;
  activity: {
    tasks: ReviewTask[];
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

/** The owner's daily focus time, when prune reminds them to work. */
export interface ScheduleState {
  /** Minutes after local midnight; null when not chosen (reminders at 09:00, only for planned tasks). */
  focusMinute: number | null;
  weekdaysOnly: boolean;
  /** Browsers with notifications on for this account. */
  pushDevices: number;
}

/** Which reminder emails the account receives. */
export interface EmailPreferences {
  /** One email on days when planned tasks are still unfinished. */
  daily: boolean;
  /** At most one email a week after 7 days away. */
  comeback: boolean;
}

/** A month of the owner's own tasks, counted on the server. */
export interface MonthStats {
  month: string;
  /** Tasks planned for days so far, plus any of today's already finished. */
  planned: number;
  completed: number;
  focusSeconds: number;
}

/** What the owner accepted at a weekly check-in. */
export interface CheckInPlan {
  /** Multiplies the default estimate for new tasks, 0.5 to 3. */
  estimateFactor: number;
  /** Tasks to plan a day, 1 to 5. */
  dailyTarget: number;
  /** The last day of the check-in week this answers. */
  decidedFor: string;
}

export type PlanSettings = Omit<CheckInPlan, "decidedFor">;

export interface WeeklyOverview {
  settings: { enabled: boolean };
  model: string;
  available: boolean;
  week: {
    start: string;
    end: string;
    nextUpdate: string;
    nextUpdateAt?: string;
  };
  /** The check-in day (0 is Sunday; the weekday of the first check-in, three days after the account started) and the plan accepted at the last one; absent from older servers. */
  checkIn?: { day: number; plan: CheckInPlan | null };
  status:
    | "disabled"
    | "unavailable"
    | "pending"
    | "running"
    | "failed"
    | "no_data"
    | "up_to_date";
  error: string | null;
  reviews: WeeklyReview[];
}

export interface AuthStatus {
  configured: boolean;
  email: string | null;
  accountKey: string | null;
}

/** Successful authentication must include both identity fields. */
export interface Account extends AuthStatus {
  email: string;
  accountKey: string;
}

export function isAccount(status: AuthStatus): status is Account {
  return Boolean(status.email && status.accountKey);
}
