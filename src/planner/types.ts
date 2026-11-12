export interface TaskResource {
  id: string;
  label: string;
  target: string;
  kind: "link" | "file";
}

export interface Task {
  /** Mutation-response metadata; omitted from dashboard task rows. */
  serverRevision?: number;
  id: string;
  outcome: string;
  /** Shared-backend compatibility; all tasks are equal in the web UI. */
  isPriority: boolean;
  plannedFor: string;
  estimatedMinutes: number;
  actualSeconds: number;
  status: "planned" | "active" | "completed";
  startedAt: number | null;
  completedOn: string | null;
  createdAt: number;
  /** Mac-only metadata is preserved, never rendered as browser links. */
  resources: TaskResource[];
}

export interface Dashboard {
  revision?: number;
  today: string;
  tomorrow: string;
  todayTasks: Task[];
  tomorrowTasks: Task[];
  activeTask: Task | null;
  canPlanTomorrow: boolean;
  completions: { day: string; count: number }[];
  serverNow: number;
}

/** AI proposal for today, derived server-side from yesterday's tasks. */
export interface TaskSuggestion {
  outcome: string;
  estimatedMinutes: number;
  basis: "carry_over" | "follow_up";
}

export interface ReviewStop {
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
    tasks: Pick<
      Task,
      | "id"
      | "outcome"
      | "plannedFor"
      | "completedOn"
      | "status"
      | "estimatedMinutes"
      | "actualSeconds"
    >[];
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

/** A month of the owner's own tasks, counted on the server. */
/** Which reminder emails the account receives. */
export interface EmailPreferences {
  /** One email on days when planned tasks are still unfinished. */
  daily: boolean;
  /** At most one email a week after 7 days away. */
  comeback: boolean;
}

export interface MonthStats {
  month: string;
  /** Tasks planned for days so far, plus any of today's already finished. */
  planned: number;
  completed: number;
  focusSeconds: number;
}

export interface WeeklyOverview {
  developmentUnlimited?: boolean;
  settings: { enabled: boolean };
  model: string;
  available: boolean;
  week: {
    start: string;
    end: string;
    nextUpdate: string;
    nextUpdateAt?: string;
  };
  /** Completed tasks toward the next review; absent from servers that still review weekly. */
  progress?: { completed: number; target: number };
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
