import { TIME } from "../shared/time-constants.ts";
import type { Task } from "./types.ts";

/** Timer arithmetic for one task, in epoch seconds. */
export class TaskTimer {
  private readonly task: Pick<
    Task,
    "actualSeconds" | "startedAt" | "estimatedMinutes"
  >;

  constructor(
    task: Pick<Task, "actualSeconds" | "startedAt" | "estimatedMinutes">,
  ) {
    this.task = task;
  }

  get running(): boolean {
    return this.task.startedAt !== null;
  }

  /** Saved time plus the running segment; pauses and clock rollback add nothing. */
  trackedSeconds(now: number): number {
    return (
      this.task.actualSeconds +
      (this.task.startedAt === null
        ? 0
        : Math.max(0, now - this.task.startedAt))
    );
  }

  /** Estimated time still to go; never negative. */
  remainingSeconds(now: number): number {
    return Math.max(
      0,
      this.task.estimatedMinutes * TIME.secondsPerMinute -
        this.trackedSeconds(now),
    );
  }
}

export interface DaySummary {
  completed: number;
  remainingSeconds: number;
  focusedSeconds: number;
  /** When the remaining estimates would be done, or null when nothing is left. */
  finishAt: number | null;
}

/** One day's tasks: what is done, what is left, and the next one up. */
export class DayPlan {
  readonly tasks: readonly Task[];

  constructor(tasks: readonly Task[]) {
    this.tasks = tasks;
  }

  get isComplete(): boolean {
    return (
      this.tasks.length > 0 &&
      this.tasks.every((task) => task.status === "completed")
    );
  }

  get completedCount(): number {
    return this.tasks.filter((task) => task.status === "completed").length;
  }

  get estimatedMinutes(): number {
    return this.tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0);
  }

  nextPlanned(): Task | null {
    return this.tasks.find((task) => task.status === "planned") ?? null;
  }

  focusedSeconds(now: number): number {
    return this.tasks.reduce(
      (sum, task) => sum + new TaskTimer(task).trackedSeconds(now),
      0,
    );
  }

  /** What's left, what's done, and when it would end. One pass. */
  summary(now: number): DaySummary {
    let remainingSeconds = 0;
    let focusedSeconds = 0;
    let completed = 0;
    for (const task of this.tasks) {
      const timer = new TaskTimer(task);
      focusedSeconds += timer.trackedSeconds(now);
      if (task.status === "completed") completed += 1;
      else remainingSeconds += timer.remainingSeconds(now);
    }
    return {
      completed,
      remainingSeconds,
      focusedSeconds,
      finishAt: remainingSeconds > 0 ? now + remainingSeconds : null,
    };
  }
}
