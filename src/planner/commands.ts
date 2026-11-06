import type { Dashboard, MonthStats, WeeklyOverview } from "./types.ts";

/** Non-queued RPC results; destructive account operations must stay online. */
export interface PlannerQueries {
  dashboard: Dashboard;
  account_status: { isDeleted: boolean };
  delete_account: { isDeleted: boolean };
  weekly_overview: WeeklyOverview;
  set_weekly_ai_enabled: WeeklyOverview;
  month_stats: MonthStats;
}

/** Commands sent by the web UI, plus legacy commands kept for saved outboxes. */
export interface TaskArguments {
  create_task: { outcome: string; day: string; estimatedMinutes: number };
  rename_task: { id: string; outcome: string };
  change_estimate: { id: string; minutes: number };
  start_task: { id: string };
  stop_timer: { id: string };
  save_pause_reason: { id: string; reason: string };
  resume_task: { id: string };
  complete_task: { id: string };
  prioritize_task: { id: string };
  pause_task: { id: string };
  add_task_link: { id: string; label: string; target: string };
  remove_task_resource: { id: string; resourceId: string };
}

export type TaskAction = keyof TaskArguments;

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
