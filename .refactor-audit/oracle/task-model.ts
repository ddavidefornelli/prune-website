import type { Task } from "./types.ts";

export function isDayComplete(tasks: readonly Task[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "completed");
}

/** Saved time plus the current running segment; pauses and clock rollback add nothing. */
export function trackedSeconds(
  task: Pick<Task, "actualSeconds" | "startedAt">,
  now: number,
): number {
  return (
    task.actualSeconds +
    (task.startedAt === null ? 0 : Math.max(0, now - task.startedAt))
  );
}
