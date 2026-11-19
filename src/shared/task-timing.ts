import { TIME } from "./time-constants.ts";

/** How far an average task may miss its estimate before it is coloured. */
const TIMING_SEVERITY = {
  /** Within the larger of these is on target. */
  toleranceSeconds: 60,
  toleranceShare: 0.1,
  yellowShare: 0.25,
  orangeShare: 0.5,
} as const;

interface TimedTask {
  id: string;
  status: string;
  completedOn: string | null;
  estimatedMinutes: number;
  actualSeconds: number;
}

export interface CompletedTaskTiming {
  taskId: string;
  estimatedSeconds: number;
  actualSeconds: number;
  differenceSeconds: number;
  hasRecordedTime: boolean;
}

export type TimingSeverity = "green" | "yellow" | "orange" | "red";

export interface AverageTaskTiming {
  count: number;
  omittedCount: number;
  estimatedSeconds: number;
  actualSeconds: number;
  differenceSeconds: number;
  severity: TimingSeverity;
}

/**
 * Estimates against recorded focus for the tasks completed in a review's
 * dates. Recorded time is the task's lifetime focus, not wall-clock duration
 * or time worked in this week. The weekly-review prompt and the report share it.
 */
export class TaskTimingReport {
  readonly completed: CompletedTaskTiming[];

  constructor(tasks: readonly TimedTask[], weekStart: string, weekEnd: string) {
    this.completed = tasks
      .filter(
        (task) =>
          task.status === "completed" &&
          task.completedOn !== null &&
          task.completedOn >= weekStart &&
          task.completedOn <= weekEnd,
      )
      .map((task) => {
        const estimatedSeconds = task.estimatedMinutes * TIME.secondsPerMinute;
        return {
          taskId: task.id,
          estimatedSeconds,
          actualSeconds: task.actualSeconds,
          differenceSeconds: task.actualSeconds - estimatedSeconds,
          hasRecordedTime: task.actualSeconds > 0,
        };
      });
  }

  /**
   * Per-task averages over the same completed tasks with recorded time. The
   * colour marks deviation in either direction, not task value.
   */
  average(): AverageTaskTiming | null {
    const recorded = this.completed.filter((task) => task.hasRecordedTime);
    if (!recorded.length) return null;
    const estimated =
      recorded.reduce((sum, task) => sum + task.estimatedSeconds, 0) /
      recorded.length;
    const actual =
      recorded.reduce((sum, task) => sum + task.actualSeconds, 0) /
      recorded.length;
    const estimatedSeconds = Math.round(estimated);
    const actualSeconds = Math.round(actual);
    return {
      count: recorded.length,
      omittedCount: this.completed.length - recorded.length,
      estimatedSeconds,
      actualSeconds,
      differenceSeconds: actualSeconds - estimatedSeconds,
      severity: TaskTimingReport.severity(estimated, actual),
    };
  }

  private static severity(estimated: number, actual: number): TimingSeverity {
    const deviation = Math.abs(actual - estimated);
    const share = deviation / estimated;
    if (
      deviation <=
      Math.max(
        TIMING_SEVERITY.toleranceSeconds,
        estimated * TIMING_SEVERITY.toleranceShare,
      )
    )
      return "green";
    if (share <= TIMING_SEVERITY.yellowShare) return "yellow";
    if (share <= TIMING_SEVERITY.orangeShare) return "orange";
    return "red";
  }
}
