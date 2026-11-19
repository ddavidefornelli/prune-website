import { ESTIMATE } from "./constants.ts";

/** Estimates are whole steps between the dial's ends. */
export class Estimate {
  /** Rounds to the dial's step and clamps to its range. */
  static normalize(minutes: number): number {
    const stepped = Math.round(minutes / ESTIMATE.step) * ESTIMATE.step;
    return Math.min(ESTIMATE.max, Math.max(ESTIMATE.min, stepped));
  }

  /** Where a new task's estimate starts under a check-in plan's factor. */
  static forFactor(factor = 1): number {
    return Estimate.normalize(ESTIMATE.defaultMinutes * factor);
  }
}
