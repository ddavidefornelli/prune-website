import { PLANNER_LIMITS } from "../planner/constants.ts";
import { GUEST_KEY } from "../planner/guest.ts";
import {
  FUNNEL_METRICS,
  type FunnelMetric,
  type GuestUsage,
} from "../planner/guest-usage.ts";
import { PRIVACY_ACKNOWLEDGEMENT_KEY } from "../planner/privacy-state.ts";
import { formatMinutes } from "../planner/quick-entry.ts";
import {
  focusBlockMinutes,
  startersFor,
  type Starter,
} from "../planner/starters.ts";
import {
  ANSWER_LIMITS,
  CHOICES,
  isChoice,
  type ChoiceKey,
  type FocusWindow,
  type Goal,
  type SurveyAnswers,
} from "./answers.ts";

export const SURVEY_KEY = "prune:survey:v1";

/** Questions plus the one interstitial, numbered "step X / 9" in the UI. */
export const QUESTION_STEPS = [
  "name",
  "goal",
  "role",
  "window",
  "length",
  "fact",
  "derailer",
  "target",
  "outcome",
] as const;
export const STEPS = [
  "intro",
  ...QUESTION_STEPS,
  "building",
  "plan",
  "save",
] as const;
export type SurveyStep = (typeof STEPS)[number];

/** Single-choice steps and the answer each one sets. */
export const CHOICE_STEPS = {
  goal: "goal",
  role: "role",
  window: "focusWindow",
  length: "focusMinutes",
  derailer: "derailer",
  target: "deepWorkHours",
} as const satisfies Partial<Record<SurveyStep, ChoiceKey>>;
export type ChoiceStep = keyof typeof CHOICE_STEPS;

export type SurveyFlag = "off" | "on" | "split";
export type SurveyVariant = "survey" | "control";
export type FunnelEvent =
  | "shown"
  | "started"
  | "finished"
  | "plan_shown"
  | "google_clicked"
  | "signed_up"
  | "skipped";

export interface SurveyState {
  version: 1;
  /** Persisted experiment assignment; null while the flow is off. */
  variant: SurveyVariant | null;
  status: "new" | "active" | "skipped" | "done";
  step: SurveyStep;
  answers: SurveyAnswers;
  /** Local Monday of the week the outcome was written for. */
  weekStart: string | null;
  /** "pending" once the visitor keeps the plan; the next planner to open adds it to Today. */
  plan: "none" | "pending" | "applied";
  /** Funnel metrics already counted from this browser. */
  counted: FunnelMetric[];
  /** Answers already transferred with a guest import. */
  synced: boolean;
}

/** What travels with a guest import after sign-in. Never the name. */
export type SurveyImport = Omit<SurveyAnswers, "name"> & { weekStart?: string };

type SurveyStorage = Pick<Storage, "getItem" | "setItem">;

export function emptySurvey(): SurveyState {
  return {
    version: 1,
    variant: null,
    status: "new",
    step: "intro",
    answers: {},
    weekStart: null,
    plan: "none",
    counted: [],
    synced: false,
  };
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? [...trimmed].slice(0, max).join("") : undefined;
}

const oneOf = <Value extends string>(
  value: unknown,
  values: readonly Value[],
): value is Value => values.includes(value as Value);

/** Unreadable or unknown values start over instead of blocking the planner. */
export function parseSurvey(raw: string | null): SurveyState {
  const state = emptySurvey();
  let saved: unknown;
  try {
    saved = raw === null ? null : JSON.parse(raw);
  } catch {
    return state;
  }
  if (
    typeof saved !== "object" ||
    saved === null ||
    (saved as { version?: unknown }).version !== 1
  )
    return state;
  const value = saved as Record<string, unknown>;
  if (oneOf(value.variant, ["survey", "control"]))
    state.variant = value.variant;
  if (oneOf(value.status, ["new", "active", "skipped", "done"]))
    state.status = value.status;
  if (oneOf(value.step, STEPS)) state.step = value.step;
  if (oneOf(value.plan, ["none", "pending", "applied"]))
    state.plan = value.plan;
  const answers =
    typeof value.answers === "object" && value.answers !== null
      ? (value.answers as Record<string, unknown>)
      : {};
  const name = text(answers.name, ANSWER_LIMITS.name);
  if (name) state.answers.name = name;
  const weekGoal = text(answers.weekGoal, ANSWER_LIMITS.weekGoal);
  if (weekGoal) state.answers.weekGoal = weekGoal;
  for (const key of Object.keys(CHOICES) as ChoiceKey[])
    if (isChoice(key, answers[key])) state.answers[key] = answers[key] as never;
  if (
    typeof value.weekStart === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.weekStart)
  )
    state.weekStart = value.weekStart;
  if (Array.isArray(value.counted))
    state.counted = value.counted.filter((metric) =>
      oneOf(metric, FUNNEL_METRICS),
    );
  state.synced = value.synced === true;
  return state;
}

// A refused write keeps the flow working for this page instead of losing answers.
const unsaved = new WeakMap<object, SurveyState>();

export function readSurvey(storage: SurveyStorage): SurveyState {
  const pending = unsaved.get(storage);
  if (pending) return pending;
  try {
    return parseSurvey(storage.getItem(SURVEY_KEY));
  } catch {
    return emptySurvey();
  }
}

export function writeSurvey(
  storage: SurveyStorage,
  state: SurveyState,
): SurveyState {
  try {
    storage.setItem(SURVEY_KEY, JSON.stringify(state));
    unsaved.delete(storage);
  } catch {
    unsaved.set(storage, state);
  }
  return state;
}

/** Re-reads before writing so the planner and session never undo each other. */
export function updateSurvey(
  storage: SurveyStorage,
  change: (state: SurveyState) => SurveyState,
): SurveyState {
  return writeSurvey(storage, change(readSurvey(storage)));
}

export function parseFlag(value: unknown): SurveyFlag {
  return value === "on" || value === "split" ? value : "off";
}

/** `split` assigns each browser once, 50/50; the caller persists the result. */
export function assignVariant(
  flag: SurveyFlag,
  saved: SurveyVariant | null,
  random: () => number = Math.random,
): SurveyVariant | null {
  if (flag === "off") return null;
  if (flag === "on") return "survey";
  return saved ?? (random() < 0.5 ? "survey" : "control");
}

/** No guest journal and no notice ever accepted: a first visit to prune. */
export function isFreshVisitor(storage: Pick<Storage, "getItem">): boolean {
  try {
    return (
      storage.getItem(GUEST_KEY) === null &&
      storage.getItem(PRIVACY_ACKNOWLEDGEMENT_KEY) === null
    );
  } catch {
    return false;
  }
}

/** Only fresh visitors start the questions; anyone already in them can finish. */
export function surveyVisible(state: SurveyState, fresh: boolean): boolean {
  return (
    state.variant === "survey" &&
    (state.status === "active" || (state.status === "new" && fresh))
  );
}

export function nextStep(step: SurveyStep): SurveyStep {
  return STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]!;
}

/** Back skips the transient building screen and stops at the intro. */
export function previousStep(step: SurveyStep): SurveyStep {
  if (step === "plan") return "outcome";
  return STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]!;
}

export function questionNumber(step: SurveyStep): number | null {
  const index = (QUESTION_STEPS as readonly string[]).indexOf(step);
  return index < 0 ? null : index + 1;
}

export function weekStartOf(date: Date): string {
  const monday = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - ((date.getDay() + 6) % 7),
  );
  return [
    monday.getFullYear(),
    String(monday.getMonth() + 1).padStart(2, "0"),
    String(monday.getDate()).padStart(2, "0"),
  ].join("-");
}

export function start(state: SurveyState): SurveyState {
  return { ...state, status: "active", step: "name" };
}

/** Records an answer (empty text clears it) and moves to the next step. */
export function answer(
  state: SurveyState,
  patch: SurveyAnswers,
  now: Date,
): SurveyState {
  const answers: SurveyAnswers = { ...state.answers, ...patch };
  for (const key of ["name", "weekGoal"] as const) {
    const value = text(answers[key], ANSWER_LIMITS[key]);
    if (value) answers[key] = value;
    else delete answers[key];
  }
  const weekStart =
    "weekGoal" in patch
      ? answers.weekGoal
        ? weekStartOf(now)
        : null
      : state.weekStart;
  return {
    ...state,
    status: "active",
    answers,
    weekStart,
    step: nextStep(state.step),
  };
}

export function back(state: SurveyState): SurveyState {
  return { ...state, step: previousStep(state.step) };
}

export function skip(state: SurveyState): SurveyState {
  return { ...state, status: "skipped" };
}

/** "Save my plan": the plan waits for whichever planner opens next. */
export function keepPlan(state: SurveyState): SurveyState {
  return {
    ...state,
    step: "save",
    plan: state.plan === "applied" ? "applied" : "pending",
  };
}

/** "Not now": finish as a guest; the guest planner adds the plan. */
export function finishAsGuest(state: SurveyState): SurveyState {
  return {
    ...state,
    status: "done",
    plan: state.plan === "applied" ? "applied" : "pending",
  };
}

export function finishSignedIn(state: SurveyState): SurveyState {
  return state.status === "active" ? { ...state, status: "done" } : state;
}

export function funnelMetric(
  variant: SurveyVariant,
  event: FunnelEvent,
): FunnelMetric | null {
  const metric = `funnel_${variant}_${event}`;
  return oneOf(metric, FUNNEL_METRICS) ? metric : null;
}

/**
 * Each event counts once per browser and variant. Sign-ups count only after
 * the browser was counted as shown, so both variants share one denominator.
 */
export function countEvent(
  state: SurveyState,
  event: FunnelEvent,
): { state: SurveyState; usage: GuestUsage } {
  const metric = state.variant && funnelMetric(state.variant, event);
  const shown = state.variant && funnelMetric(state.variant, "shown");
  if (
    !metric ||
    state.counted.includes(metric) ||
    (event === "signed_up" && !state.counted.includes(shown!))
  )
    return { state, usage: {} };
  return {
    state: { ...state, counted: [...state.counted, metric] },
    usage: { [metric]: 1 },
  };
}

/** Never the name, and a week outcome only while its week is current. */
export function surveyImport(
  state: SurveyState,
  now: Date,
): SurveyImport | undefined {
  if (state.synced) return undefined;
  const payload: SurveyImport = {};
  for (const key of Object.keys(CHOICES) as ChoiceKey[])
    if (state.answers[key] !== undefined)
      payload[key] = state.answers[key] as never;
  if (state.answers.weekGoal && state.weekStart === weekStartOf(now)) {
    payload.weekGoal = state.answers.weekGoal;
    payload.weekStart = state.weekStart;
  }
  return Object.keys(payload).length ? payload : undefined;
}

const WINDOWS: Record<FocusWindow, string> = {
  morning: "Mornings",
  afternoon: "Afternoons",
  evening: "Evenings",
  varies: "Any time",
};
const GOAL_PHRASES: Record<Goal, string> = {
  ship: "shipping your project",
  study: "your studies",
  procrastination: "beating procrastination",
  business: "running your business",
  exploring: "a first day with prune",
};
/** Each line names a change startersFor actually makes for that derailer. */
const DERAILER_LINES = {
  phone: "Keeping your phone out of the main block",
  overload: "Parking everything else on one list",
  starting: "Opening with a 10-minute first step",
  interruptions: "Turning notifications off for the main block",
} as const;

export interface FocusPlan {
  tasks: Starter[];
  blockMinutes: number;
  /** For example "Mornings, 60-minute blocks". */
  focus: string;
  plannedMinutes: number;
  /** The building checklist: one line per thing buildPlan computed. */
  checklist: string[];
}

export function buildPlan(answers: SurveyAnswers): FocusPlan {
  const tasks = startersFor(answers);
  const block = focusBlockMinutes(answers.focusMinutes);
  const plannedMinutes = tasks.reduce((sum, task) => sum + task.minutes, 0);
  const window = answers.focusWindow ?? "varies";
  const checklist = [
    answers.focusMinutes && answers.focusMinutes > block
      ? `Capping blocks at ${block} minutes, prune’s longest estimate`
      : `Sizing tasks to your ${block}-minute focus`,
    window === "varies"
      ? `Keeping ${block}-minute blocks flexible`
      : `Matching ${block}-minute blocks to your ${WINDOWS[window].toLowerCase()}`,
    `Choosing ${tasks.length} tasks for ${GOAL_PHRASES[answers.goal ?? "exploring"]}`,
  ];
  if (answers.derailer) checklist.push(DERAILER_LINES[answers.derailer]);
  if (answers.deepWorkHours) {
    const target =
      answers.deepWorkHours === 4 ? "4+ hour" : `${answers.deepWorkHours}-hour`;
    checklist.push(
      plannedMinutes >= answers.deepWorkHours * 60
        ? `Planning ${formatMinutes(plannedMinutes * 60)}, your full ${target} target`
        : `Planning ${formatMinutes(plannedMinutes * 60)} of your ${target} target`,
    );
  }
  if (answers.weekGoal) checklist.push("Setting this week’s outcome");
  return {
    tasks,
    blockMinutes: block,
    focus: `${WINDOWS[window]}, ${block}-minute blocks`,
    plannedMinutes,
    checklist,
  };
}

/** The plan's tasks that still fit today, skipping titles already planned. */
export function tasksToAdd(
  tasks: readonly Starter[],
  planned: readonly { outcome: string }[],
): Starter[] {
  const titles = new Set(
    planned.map((task) => task.outcome.trim().toLocaleLowerCase()),
  );
  return tasks
    .filter((task) => !titles.has(task.outcome.toLocaleLowerCase()))
    .slice(0, Math.max(0, PLANNER_LIMITS.tasksPerDay - planned.length));
}
