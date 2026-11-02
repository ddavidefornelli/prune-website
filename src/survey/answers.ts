/**
 * One-tap survey options. Values are stable identifiers kept on this device
 * and, after sign-in, validated again by planner_import_guest; labels are copy.
 */
export const GOALS = [
  { value: "ship", label: "Ship a project" },
  { value: "study", label: "Study" },
  { value: "procrastination", label: "Stop procrastinating" },
  { value: "business", label: "Run my business" },
  { value: "exploring", label: "Just exploring" },
] as const;
export const ROLES = [
  { value: "student", label: "Student" },
  { value: "engineer", label: "Engineer" },
  { value: "creative", label: "Designer or creative" },
  { value: "founder", label: "Founder" },
  { value: "other", label: "Other" },
] as const;
export const FOCUS_WINDOWS = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
  { value: "varies", label: "It varies" },
] as const;
export const FOCUS_LENGTHS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "60 min" },
  { value: 90, label: "90+ min" },
] as const;
export const DERAILERS = [
  { value: "phone", label: "My phone" },
  { value: "overload", label: "Too many tasks" },
  { value: "starting", label: "Not knowing where to start" },
  { value: "interruptions", label: "Interruptions" },
] as const;
export const DEEP_WORK_HOURS = [
  { value: 1, label: "1 hour" },
  { value: 2, label: "2 hours" },
  { value: 3, label: "3 hours" },
  { value: 4, label: "4+ hours" },
] as const;

type Value<Options extends readonly { value: unknown }[]> =
  Options[number]["value"];
export type Goal = Value<typeof GOALS>;
export type Role = Value<typeof ROLES>;
export type FocusWindow = Value<typeof FOCUS_WINDOWS>;
export type FocusLength = Value<typeof FOCUS_LENGTHS>;
export type Derailer = Value<typeof DERAILERS>;
export type DeepWorkHours = Value<typeof DEEP_WORK_HOURS>;

export const ANSWER_LIMITS = { name: 40, weekGoal: 200 } as const;

export interface SurveyAnswers {
  /** Only used to address the visitor; it never leaves this browser. */
  name?: string;
  goal?: Goal;
  role?: Role;
  focusWindow?: FocusWindow;
  focusMinutes?: FocusLength;
  derailer?: Derailer;
  deepWorkHours?: DeepWorkHours;
  weekGoal?: string;
}

/** The single-choice questions, keyed by the answer each one sets. */
export const CHOICES = {
  goal: GOALS,
  role: ROLES,
  focusWindow: FOCUS_WINDOWS,
  focusMinutes: FOCUS_LENGTHS,
  derailer: DERAILERS,
  deepWorkHours: DEEP_WORK_HOURS,
} as const;
export type ChoiceKey = keyof typeof CHOICES;

export function isChoice<Key extends ChoiceKey>(
  key: Key,
  value: unknown,
): value is SurveyAnswers[Key] {
  return CHOICES[key].some((option) => option.value === value);
}
