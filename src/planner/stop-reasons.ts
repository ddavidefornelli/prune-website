/**
 * One-tap reasons for stopping the timer, grouped by where the pull came from.
 *
 * Picking an area first and then a reason narrows the cause in two steps, and
 * the saved text keeps the area as a prefix ("People: A meeting"), so stops can
 * later be grouped by area and then drilled into.
 */
export const STOP_REASON_AREAS = [
  {
    area: "Inside me",
    reasons: [
      "Lost focus",
      "Tired or low energy",
      "Bored with it",
      "Anxious or overwhelmed",
      "Hungry or thirsty",
    ],
  },
  {
    area: "The task",
    reasons: [
      "Stuck on a problem",
      "Not sure what’s next",
      "Too big, needs splitting",
      "Missing information",
      "Waiting on someone",
    ],
  },
  {
    area: "People",
    reasons: [
      "Someone interrupted me",
      "A message or call",
      "A meeting",
      "Helping someone",
    ],
  },
  {
    area: "Screens",
    reasons: [
      "A notification",
      "Checked social media",
      "Email or chat",
      "Went down a rabbit hole online",
    ],
  },
  {
    area: "Surroundings",
    reasons: [
      "Too noisy",
      "Uncomfortable spot",
      "Had to move or travel",
      "Tech problem",
    ],
  },
  {
    area: "Planned",
    reasons: [
      "A planned break",
      "Something more urgent came up",
      "Done for today",
    ],
  },
] as const;

export type StopReasonArea = (typeof STOP_REASON_AREAS)[number];

/** A one-tap reason picked from an area. */
export class StopReason {
  readonly area: string;
  readonly reason: string;

  constructor(area: string, reason: string) {
    this.area = area;
    this.reason = reason;
  }

  /** The text saved for it, area first. */
  get text(): string {
    return `${this.area}: ${this.reason}`;
  }
}
