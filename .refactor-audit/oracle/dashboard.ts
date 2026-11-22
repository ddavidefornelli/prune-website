import { localDay, nextDay } from "./time.ts";
import type { Dashboard, Task } from "./types.ts";

/** Include an older active task once, even when it is outside the two-day plan. */
export function dashboardTasks(data: Dashboard): Task[] {
  const tasks = [...data.todayTasks, ...data.tomorrowTasks];
  const active = data.activeTask;
  if (active && !tasks.some((task) => task.id === active.id))
    tasks.push(active);
  return tasks;
}

/** Mutates an owned snapshot, preserving the active timer across midnight. */
export function alignDashboardDate(
  data: Dashboard,
  at: number,
  timezone: string,
): Dashboard {
  const today = localDay(at, timezone);
  if (today === data.today) return data;
  const tasks = dashboardTasks(data);
  data.today = today;
  data.tomorrow = nextDay(today);
  data.todayTasks = tasks.filter((task) => task.plannedFor === data.today);
  data.tomorrowTasks = tasks.filter(
    (task) => task.plannedFor === data.tomorrow,
  );
  data.canPlanTomorrow = true;
  return data;
}
