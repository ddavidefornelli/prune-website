export interface Starter {
  outcome: string;
  minutes: number;
}

/** First-run ideas for an empty planner. */
export const STARTERS: readonly Starter[] = [
  { outcome: "Clear my inbox", minutes: 20 },
  { outcome: "Deep work on my main project", minutes: 60 },
  { outcome: "Plan the week ahead", minutes: 30 },
];
