import { CALENDAR, TIME } from "../shared/time-constants.ts";
import { LEGACY_CHECK_IN_HOUR } from "./constants.ts";

const pad = (value: number) => String(value).padStart(2, "0");

/** Time left until the next check-in, and how far through its week we are. */
export class ReviewCountdown {
  readonly target: Date;
  readonly due: boolean;
  /** Days, hours, minutes and seconds left. */
  readonly values: [number, number, number, number];
  /** 0 to 1 through the seven days before the check-in. */
  readonly progress: number;

  private constructor(target: Date, now: number) {
    // Calendar arithmetic keeps the weekly progress accurate across DST changes.
    const start = new Date(target);
    start.setDate(start.getDate() - (CALENDAR.daysPerWeek - 1));
    start.setHours(0, 0, 0, 0);
    const seconds = Math.max(
      0,
      Math.ceil((target.getTime() - now) / TIME.msPerSecond),
    );
    this.target = target;
    this.due = seconds === 0;
    this.values = [
      Math.floor(seconds / TIME.secondsPerDay),
      Math.floor(seconds / TIME.secondsPerHour) % TIME.hoursPerDay,
      Math.floor(seconds / TIME.secondsPerMinute) % TIME.minutesPerHour,
      seconds % TIME.secondsPerMinute,
    ];
    this.progress = Math.min(
      1,
      Math.max(
        0,
        (now - start.getTime()) / (target.getTime() - start.getTime()),
      ),
    );
  }

  /**
   * Uses the server's timezone-aware instant; older servers supply a local
   * calendar date. Null when neither is a valid time.
   */
  static of(
    week: { nextUpdate: string; nextUpdateAt?: string },
    now = Date.now(),
  ): ReviewCountdown | null {
    const target = week.nextUpdateAt
      ? new Date(week.nextUpdateAt)
      : new Date(`${week.nextUpdate}T${pad(LEGACY_CHECK_IN_HOUR)}:00:00`);
    if (!Number.isFinite(target.getTime())) return null;
    return new ReviewCountdown(target, now);
  }
}
