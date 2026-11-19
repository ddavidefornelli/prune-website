import { TIME } from "../shared/time-constants.ts";
import { Estimate } from "./estimate.ts";

/** "… 1h 30m", "… 45 min", "… 2 hours" at the end of a title. */
const TRAILING_DURATION =
  /\s+(?:(\d{1,2})\s*h(?:rs?|ours?)?)?\s*(?:(\d{1,3})\s*m(?:ins?|inutes?)?)?\s*$/i;

/** Todoist-style quick entry: "Write the brief 45m" → outcome + estimate. */
export class QuickEntry {
  readonly outcome: string;
  /** The typed estimate on the dial's scale, or null when none was typed. */
  readonly minutes: number | null;

  private constructor(outcome: string, minutes: number | null) {
    this.outcome = outcome;
    this.minutes = minutes;
  }

  static parse(text: string): QuickEntry {
    const match = TRAILING_DURATION.exec(text);
    if (!match || (match[1] === undefined && match[2] === undefined))
      return new QuickEntry(text, null);
    const outcome = text.slice(0, match.index).trim();
    if (!outcome) return new QuickEntry(text, null);
    const total =
      Number(match[1] ?? 0) * TIME.minutesPerHour + Number(match[2] ?? 0);
    return new QuickEntry(outcome, Estimate.normalize(total));
  }
}
