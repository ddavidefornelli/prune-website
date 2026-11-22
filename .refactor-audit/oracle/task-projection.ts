import type { QueuedAction } from "./commands.ts";
import { alignDashboardDate, dashboardTasks } from "./dashboard.ts";
import { trackedSeconds } from "./task-model.ts";
import { localDay } from "./time.ts";
import type { Dashboard, Task } from "./types.ts";

/** Mutates an owned snapshot. Callers clone once before replaying a journal. */
export function applyCommand(
  data: Dashboard,
  command: QueuedAction,
  result?: Task,
): Task {
  const { action, args, at } = command;
  alignDashboardDate(data, at, command.timezone);
  const tasks = dashboardTasks(data);
  let task = tasks.find((item) => item.id === args.id);
  if (action === "create_task") {
    task = {
      id: command.requestId,
      outcome: String(args.outcome).trim(),
      plannedFor: String(args.day),
      estimatedMinutes: Number(args.estimatedMinutes),
      isPriority: !tasks.some((item) => item.plannedFor === args.day),
      actualSeconds: 0,
      status: "planned",
      startedAt: null,
      completedOn: null,
      createdAt: at,
      resources: [],
    };
    tasks.push(task);
  }
  if (!task)
    throw new Error(
      "This task is not available in the local planner. Sync before changing it.",
    );

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
    case "prioritize_task":
      for (const item of tasks)
        if (item.plannedFor === task.plannedFor)
          item.isPriority = item.id === task.id;
      break;
    case "start_task":
      task.status = "active";
      task.startedAt = at;
      break;
    case "resume_task":
      task.startedAt = at;
      break;
    case "pause_task":
    case "stop_timer":
      stopTimer(task, at);
      break;
    case "complete_task": {
      const wasCompleted = task.status === "completed";
      stopTimer(task, at);
      task.status = "completed";
      task.completedOn = localDay(at, command.timezone);
      if (!wasCompleted) {
        const day = task.completedOn;
        const completion = data.completions.find((item) => item.day === day);
        if (completion) completion.count++;
        else data.completions.push({ day, count: 1 });
      }
      break;
    }
    case "add_task_link":
      task.resources.push({
        id: command.requestId,
        kind: "link",
        label: String(args.label).trim(),
        target: String(args.target).trim(),
      });
      break;
    case "remove_task_resource":
      task.resources = task.resources.filter(
        (item) => item.id !== args.resourceId,
      );
      break;
    default:
      // Unknown persisted commands must never look like successful local saves.
      throw new Error(`Unsupported saved planner action: ${String(action)}`);
  }

  data.revision = (data.revision ?? 0) + 1;
  if (result) {
    const { serverRevision, ...savedTask } = structuredClone(result);
    Object.assign(task, savedTask);
    data.revision = serverRevision ?? data.revision;
  }
  data.todayTasks = tasks.filter((item) => item.plannedFor === data.today);
  data.tomorrowTasks = tasks.filter(
    (item) => item.plannedFor === data.tomorrow,
  );
  data.activeTask = tasks.find((item) => item.status === "active") ?? null;
  data.canPlanTomorrow = true;
  return task;
}

function stopTimer(task: Task, at: number): void {
  task.actualSeconds = trackedSeconds(task, at);
  task.startedAt = null;
}

/** Pure projection for optimistic updates, receipt handling, and crash recovery. */
export function project(
  base: Dashboard,
  command: QueuedAction,
  result?: Task,
): Dashboard {
  const data = structuredClone(base);
  applyCommand(data, command, result);
  return data;
}
