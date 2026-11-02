import type { Goal, Role, SurveyAnswers } from "../survey/answers.ts";
import { ESTIMATE } from "./constants.ts";

export interface Starter {
  outcome: string;
  minutes: number;
}

/** First-run ideas for visitors who answered nothing. */
export const DEFAULT_STARTERS: readonly Starter[] = [
  { outcome: "Clear my inbox", minutes: 20 },
  { outcome: "Deep work on my main project", minutes: 60 },
  { outcome: "Plan the week ahead", minutes: 30 },
];

const MAIN_TASK: Record<
  Goal,
  { default: string } & Partial<Record<Role, string>>
> = {
  ship: {
    default: "Move my project to its next milestone",
    student: "Push my project to its next milestone",
    engineer: "Build the next feature",
    creative: "Finish the next design draft",
    founder: "Ship one thing users will notice",
  },
  study: {
    default: "Study one topic in depth",
    student: "Study for my next exam",
    engineer: "Learn one new concept hands-on",
    creative: "Practice one new technique",
    founder: "Study one part of my market",
  },
  procrastination: { default: "Start the task I've been avoiding" },
  business: {
    default: "Move my most important project forward",
    student: "Grow my side business",
    engineer: "Fix what customers hit most",
    creative: "Finish one client deliverable",
    founder: "Work on what grows revenue",
  },
  exploring: { default: "Deep work on my main project" },
};

/** Two lighter tasks per goal: the first runs before the main block. */
const SUPPORT: Record<Goal, readonly [Starter, Starter]> = {
  ship: [
    { outcome: "List what's left before it ships", minutes: 15 },
    { outcome: "Share progress with one person", minutes: 10 },
  ],
  study: [
    { outcome: "Review yesterday's notes", minutes: 15 },
    { outcome: "Test myself on 10 questions", minutes: 20 },
  ],
  procrastination: [
    { outcome: "Split my biggest task into small steps", minutes: 10 },
    { outcome: "Clear one quick task I keep postponing", minutes: 15 },
  ],
  business: [
    { outcome: "Reply to the messages that matter", minutes: 20 },
    { outcome: "Check this week's numbers", minutes: 15 },
  ],
  exploring: [
    { outcome: "Clear my inbox", minutes: 20 },
    { outcome: "Plan the week ahead", minutes: 30 },
  ],
};

const FIRST_STEP: Starter = {
  outcome: "Write down the very first step",
  minutes: 10,
};
const PARKING_LIST: Starter = {
  outcome: "Park everything else on one list",
  minutes: 10,
};

/** One focus block: the visitor's stretch, within the planner's estimate range. */
export function focusBlockMinutes(focusMinutes?: number): number {
  return Math.min(focusMinutes ?? ESTIMATE.defaultMinutes, ESTIMATE.max);
}

/**
 * Three first-run tasks from the survey's goal, role, focus length and
 * derailer. The main task fills one focus block; lighter tasks never exceed it.
 */
export function startersFor(answers: SurveyAnswers = {}): Starter[] {
  const { goal = "exploring", role, focusMinutes, derailer } = answers;
  if (!answers.goal && !role && !focusMinutes && !derailer)
    return DEFAULT_STARTERS.map((starter) => ({ ...starter }));
  const block = focusBlockMinutes(focusMinutes);
  const titles = MAIN_TASK[goal];
  let main = (role && titles[role]) || titles.default;
  if (derailer === "phone") main += ", phone in another room";
  if (derailer === "interruptions") main += ", notifications off";
  let [before, after] = SUPPORT[goal];
  // Procrastination already opens with a ten-minute split of the hard task.
  if (derailer === "starting" && goal !== "procrastination")
    before = FIRST_STEP;
  if (derailer === "overload") after = PARKING_LIST;
  const deep = { outcome: main, minutes: block };
  // Exploring keeps today's order; a hard start opens with the small step.
  const opensSmall =
    goal === "exploring" ||
    goal === "procrastination" ||
    derailer === "starting";
  const tasks = opensSmall ? [before, deep, after] : [deep, before, after];
  return tasks.map(({ outcome, minutes }) => ({
    outcome,
    minutes: Math.min(minutes, block),
  }));
}
