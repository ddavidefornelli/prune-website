import { CalendarDay } from "../shared/calendar-day.ts";
import { RETIRED_TASK_ACTIONS, type QueuedAction } from "./commands.ts";
import { TaskTimer } from "./day-plan.ts";
import { MESSAGES } from "./messages.ts";
import type { Dashboard, Task } from "./types.ts";

/**
 * A dashboard this object owns and may change: the outbox replays saved
 * commands onto one for optimistic updates, receipts and crash recovery.
 * Rendering-independent, so the same rules run in tests and fixtures.
 */
export class PlannerSnapshot {
  readonly data: Dashboard;

  private constructor(data: Dashboard) {
    this.data = data;
  }

  /** Takes ownership of `data`; callers clone first when they must keep it. */
  static own(data: Dashboard): PlannerSnapshot {
    return new PlannerSnapshot(data);
  }

  static copy(data: Dashboard): PlannerSnapshot {
    return new PlannerSnapshot(structuredClone(data));
  }

  /** The dashboard after one command, leaving `base` untouched. */
  static project(
    base: Dashboard,
    command: QueuedAction,
    result?: Task,
  ): Dashboard {
    const snapshot = PlannerSnapshot.copy(base);
    snapshot.apply(command, result);
    return snapshot.data;
  }

  /** Today's and tomorrow's tasks, plus an older active task once. */
  tasks(): Task[] {
    const { todayTasks, tomorrowTasks, activeTask } = this.data;
    const tasks = [...todayTasks, ...tomorrowTasks];
    if (activeTask && !tasks.some((task) => task.id === activeTask.id))
      tasks.push(activeTask);
    return tasks;
  }

  /** Moves the two-day window to the local date at `at`, keeping an active timer. */
  alignTo(at: number, timezone: string): this {
    const today = CalendarDay.local(at, timezone);
    if (today.key === this.data.today) return this;
    const tasks = this.tasks();
    this.data.today = today.key;
    this.data.tomorrow = today.next().key;
    this.regroup(tasks);
    return this;
  }

  /** Applies one saved command and returns the task it changed. */
  apply(command: QueuedAction, result?: Task): Task {
    const { action, args, at } = command;
    this.alignTo(at, command.timezone);
    const tasks = this.tasks();
    let task = tasks.find((item) => item.id === args.id);
    if (action === "create_task") {
      task = {
        id: command.requestId,
        outcome: String(args.outcome).trim(),
        plannedFor: String(args.day),
        estimatedMinutes: Number(args.estimatedMinutes),
        actualSeconds: 0,
        status: "planned",
        startedAt: null,
        completedOn: null,
        createdAt: at,
      };
      tasks.push(task);
    }
    if (!task) throw new Error(MESSAGES.taskUnavailable);

    switch (action) {
      case "create_task":
      case "save_pause_reason":
        // Pause reasons live in the journal/server, not in dashboard task rows.
        break;
      case "rename_task":
        task.outcome = String(args.outcome).trim();
        break;
      case "change_estimate":
        task.estimatedMinutes = Number(args.minutes);
        break;
      case "start_task":
        task.status = "active";
        task.startedAt = at;
        break;
      case "resume_task":
        task.startedAt = at;
        break;
      case "stop_timer":
        PlannerSnapshot.stopTimer(task, at);
        break;
      case "complete_task":
        this.complete(task, at, command.timezone);
        break;
      default:
        // Unknown persisted commands must never look like successful local saves.
        if (!RETIRED_TASK_ACTIONS.includes(action))
          throw new Error(
            `Unsupported saved planner action: ${String(action)}`,
          );
    }

    this.data.revision = (this.data.revision ?? 0) + 1;
    if (result) {
      const { serverRevision, ...savedTask } = structuredClone(result);
      Object.assign(task, savedTask);
      this.data.revision = serverRevision ?? this.data.revision;
    }
    this.regroup(tasks);
    this.data.activeTask =
      tasks.find((item) => item.status === "active") ?? null;
    return task;
  }

  private complete(task: Task, at: number, timezone: string): void {
    const wasCompleted = task.status === "completed";
    PlannerSnapshot.stopTimer(task, at);
    task.status = "completed";
    task.completedOn = CalendarDay.local(at, timezone).key;
    if (wasCompleted) return;
    const day = task.completedOn;
    const completion = this.data.completions.find((item) => item.day === day);
    if (completion) completion.count++;
    else this.data.completions.push({ day, count: 1 });
  }

  private regroup(tasks: readonly Task[]): void {
    this.data.todayTasks = tasks.filter(
      (task) => task.plannedFor === this.data.today,
    );
    this.data.tomorrowTasks = tasks.filter(
      (task) => task.plannedFor === this.data.tomorrow,
    );
  }

  private static stopTimer(task: Task, at: number): void {
    task.actualSeconds = new TaskTimer(task).trackedSeconds(at);
    task.startedAt = null;
  }
}
