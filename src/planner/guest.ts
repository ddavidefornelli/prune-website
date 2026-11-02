import type { SurveyImport } from "../survey/model.ts";
import type { QueuedAction, TaskAction, TaskArguments } from "./commands.ts";
import { ESTIMATE, PLANNER_LIMITS } from "./constants.ts";
import { alignDashboardDate, dashboardTasks } from "./dashboard.ts";
import { guestUsage, type GuestUsage } from "./guest-usage.ts";
import { applyCommand } from "./task-projection.ts";
import { localDay, nextDay } from "./time.ts";
import type { Account, Dashboard, Task } from "./types.ts";

export const GUEST_KEY = "prune:guest:v1";
export const GUEST_ACCOUNT = {
  configured: true,
  email: "Guest · this device only",
  accountKey: "guest",
} satisfies Account;
export interface GuestImport {
  importId: string;
  tasks: Task[];
  stops: { taskId: string; reason: string; at: number; day: string }[];
  /** Onboarding answers, frozen with the import identity for retries. */
  survey?: SurveyImport;
}
interface GuestState {
  version: 1;
  base: Dashboard;
  commands: QueuedAction[];
  transfer?: { accountKey: string; importId: string; survey?: SurveyImport };
}
function emptyGuestDashboard(now = Math.floor(Date.now() / 1000)): Dashboard {
  const today = localDay(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  return {
    today,
    tomorrow: nextDay(today),
    todayTasks: [],
    tomorrowTasks: [],
    activeTask: null,
    canPlanTomorrow: true,
    completions: [],
    serverNow: now,
    revision: 0,
  };
}

/** The original command journal is retained until every server receipt is confirmed. */
export class GuestStore {
  private readonly storage: Storage;
  private readonly onUsage: (usage: GuestUsage) => void;
  constructor(
    storage: Storage = localStorage,
    onUsage: (usage: GuestUsage) => void = () => {},
  ) {
    this.storage = storage;
    this.onUsage = onUsage;
  }
  private load(): GuestState {
    const raw = this.storage.getItem(GUEST_KEY);
    if (!raw) return { version: 1, base: emptyGuestDashboard(), commands: [] };
    const state = JSON.parse(raw) as GuestState;
    if (state.version !== 1 || !state.base || !Array.isArray(state.commands))
      throw new Error(
        "Guest data could not be read. Do not clear browser storage.",
      );
    return state;
  }
  private save(state: GuestState): void {
    this.storage.setItem(GUEST_KEY, JSON.stringify(state));
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    if (!navigator.locks)
      throw new Error(
        "Safe local saving requires HTTPS and a browser with Web Locks support.",
      );
    return await navigator.locks.request(GUEST_KEY, work);
  }
  hasTasks(): boolean {
    return this.load().commands.length > 0;
  }
  dashboard(): Dashboard {
    return this.project(this.load());
  }
  private project(state: GuestState): Dashboard {
    const data = structuredClone(state.base);
    for (const command of state.commands) applyCommand(data, command);
    data.serverNow = Math.floor(Date.now() / 1000);
    return alignDashboardDate(
      data,
      data.serverNow,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }
  async mutate<Action extends TaskAction>(
    action: Action,
    args: TaskArguments[Action],
    timezone: string,
  ): Promise<Task> {
    return this.lock(async () => {
      const state = this.load();
      if (state.transfer)
        throw new Error(
          "Guest tasks are being saved to an account. Finish Save & sync before making more changes.",
        );
      const data = this.project(state);
      const values: Record<string, unknown> = args;
      if (action === "create_task") {
        const outcome = String(values.outcome).trim();
        if (!outcome || outcome.length > PLANNER_LIMITS.outcomeLength)
          throw new Error(
            `Enter a task of 1–${PLANNER_LIMITS.outcomeLength} characters.`,
          );
        if (![data.today, data.tomorrow].includes(String(values.day)))
          throw new Error("Choose today or tomorrow.");
        const tasks =
          values.day === data.today ? data.todayTasks : data.tomorrowTasks;
        if (tasks.length >= PLANNER_LIMITS.tasksPerDay)
          throw new Error(
            `Focus on just ${PLANNER_LIMITS.tasksPerDay} tasks per day.`,
          );
      }
      const selected = dashboardTasks(data).find(
        (task) => task.id === values.id,
      );
      if (
        ["start_task", "resume_task"].includes(action) &&
        data.activeTask &&
        data.activeTask.id !== values.id
      )
        throw new Error("Finish the active task before starting another.");
      if (selected?.status === "completed" && action !== "save_pause_reason")
        throw new Error("This task is already complete.");
      if (action === "start_task" && selected?.plannedFor !== data.today)
        throw new Error("Only today's tasks can be started.");
      if (["create_task", "change_estimate"].includes(action)) {
        const minutes = Number(
          action === "create_task" ? values.estimatedMinutes : values.minutes,
        );
        // Existing Mac tasks allow 1–60; the web dial offers 5-minute steps.
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > ESTIMATE.max)
          throw new Error(
            `Choose an estimate between 1 and ${ESTIMATE.max} minutes.`,
          );
      }
      const command: QueuedAction = {
        requestId: crypto.randomUUID(),
        action,
        args,
        timezone,
        at: Math.floor(Date.now() / 1000),
        revision: state.commands.length,
      };
      // Return the mutated task even if completion removes it from the day lists.
      const task = applyCommand(data, command);
      const usage = guestUsage(state.commands, command, task);
      state.commands.push(command);
      this.save(state); // Never report success before durable storage succeeds.
      this.onUsage(usage);
      return structuredClone(task);
    });
  }
  /** Resolves whether onboarding answers were part of the confirmed import. */
  async transfer(
    accountKey: string,
    send: (payload: GuestImport) => Promise<{ imported: boolean }>,
    survey?: SurveyImport,
  ): Promise<boolean> {
    return this.lock(async () => {
      const state = this.load();
      if (!state.commands.length) return false;
      if (state.transfer && state.transfer.accountKey !== accountKey)
        throw new Error(
          "These guest tasks are already being saved to a different account. Sign in to that account to finish.",
        );
      state.transfer ??= {
        accountKey,
        importId: crypto.randomUUID(),
        ...(survey ? { survey } : {}),
      };
      this.save(state);
      const tasks = new Map<string, Task>();
      const stops: GuestImport["stops"] = [];
      const data = structuredClone(state.base);
      for (const command of state.commands) {
        // Keep the full task history outside the dashboard's two-day window.
        data.todayTasks = [...tasks.values()];
        data.tomorrowTasks = [];
        const selected = tasks.get(String(command.args.id));
        if (selected) data.activeTask = selected;
        const task = applyCommand(data, command);
        tasks.set(task.id, structuredClone(task));
        if (command.action === "save_pause_reason")
          stops.push({
            taskId: task.id,
            reason: String(command.args.reason),
            at: command.at,
            day: localDay(command.at, command.timezone),
          });
      }
      const result = await send({
        importId: state.transfer.importId,
        tasks: [...tasks.values()],
        stops,
        ...(state.transfer.survey ? { survey: state.transfer.survey } : {}),
      });
      if (result?.imported !== true)
        throw new Error(
          "Task transfer was not confirmed. Your guest tasks are still on this device. Retry Save & sync.",
        );
      this.storage.removeItem(GUEST_KEY);
      return Boolean(state.transfer.survey);
    });
  }
}
