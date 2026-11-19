import type {
  Dashboard,
  EmailPreferences,
  MonthStats,
  WeeklyOverview,
} from "./types.ts";

/** Non-queued RPC results; destructive account operations must stay online. */
export interface PlannerQueries {
  dashboard: Dashboard;
  account_status: { isDeleted: boolean };
  delete_account: { isDeleted: boolean };
  weekly_overview: WeeklyOverview;
  set_weekly_ai_enabled: WeeklyOverview;
  set_check_in_plan: WeeklyOverview;
  month_stats: MonthStats;
  email_preferences: EmailPreferences;
  set_email_preferences: EmailPreferences;
}

/** Task commands the web UI queues. */
export interface TaskArguments {
  create_task: { outcome: string; day: string; estimatedMinutes: number };
  rename_task: { id: string; outcome: string };
  change_estimate: { id: string; minutes: number };
  start_task: { id: string };
  stop_timer: { id: string };
  save_pause_reason: { id: string; reason: string };
  resume_task: { id: string };
  complete_task: { id: string };
}

export type TaskAction = keyof TaskArguments;

/**
 * Commands no client sends any more (task priority, pausing by the old name,
 * the Mac app's resources). A browser outbox saved before they were retired
 * can still hold one: it replays without changing the local plan, and the
 * server's acknowledgement settles the task.
 */
export const RETIRED_TASK_ACTIONS: readonly string[] = [
  "prioritize_task",
  "pause_task",
  "add_task_link",
  "remove_task_resource",
];

/** Persisted wire format. Never rename fields without a storage migration. */
export interface QueuedAction {
  requestId: string;
  action: TaskAction;
  args: Record<string, unknown>;
  timezone: string;
  at: number;
  revision: number;
}

export interface CloudTransport {
  onAccountChange: () => void;
  execute<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  dispose(): Promise<void>;
}
