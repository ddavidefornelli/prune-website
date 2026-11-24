/**
 * What the browser and the task-helper Edge Function exchange. Plain JSON:
 * the server checks every request against these limits, the browser checks
 * every answer's shape before using it.
 */

/** The kinds of task the helper takes on; anything else gets no button. */
export const HELPER_KINDS = ["draft", "list", "plan", "research"] as const;
export type HelperKind = (typeof HELPER_KINDS)[number];

export const HELPER_LIMITS = {
  /** Tasks judged in one classify call. */
  classifyBatch: 20,
  /** Other open task titles sent along as context. */
  contextTasks: 30,
  /** This-or-that questions before a run. */
  questions: 3,
  /** Characters in one question, option or picked answer. */
  choiceLength: 120,
  /** Characters in one refine message. */
  messageLength: 1000,
  /** Refine messages on one answer. */
  refines: 5,
  /** Runs and refines per account per day (UTC). */
  dailyRuns: 30,
  /** Classify and choices calls per account per day (UTC). */
  dailyCalls: 300,
  /** Characters kept of one answer. */
  answerLength: 20_000,
} as const;

/** A this-or-that question: two options, or "Either is fine". */
export interface HelperChoice {
  question: string;
  options: [string, string];
}

/** What the person picked for one question; an empty answer means either is fine. */
export interface HelperPick {
  question: string;
  answer: string;
}

export interface HelperSource {
  title: string;
  url: string;
}

export interface HelperTurn {
  role: "user" | "assistant";
  text: string;
}

export type HelperStatus = "working" | "done" | "failed";

/** One task's helper answer: the latest draft and the refine conversation behind it. */
export interface HelperRun {
  taskId: string;
  status: HelperStatus;
  /** The latest answer, null while the first one is being written. */
  answer: string | null;
  sources: HelperSource[];
  /** Refine messages and the answers to them, oldest first; the first answer is not in here. */
  turns: HelperTurn[];
  /** Why the last attempt failed, for the person. */
  error: string | null;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** What the browser knows about the person without asking. */
export interface HelperLocale {
  /** IANA time zone, e.g. Europe/Rome. */
  timeZone: string;
  /** BCP 47 language tag, e.g. it-IT. */
  language: string;
}

export type HelperRequest =
  | { action: "classify"; tasks: { id: string; title: string }[] }
  | {
      action: "choices";
      taskId: string;
      title: string;
      context: string[];
      locale: HelperLocale;
    }
  | {
      action: "start";
      taskId: string;
      title: string;
      kind: HelperKind;
      context: string[];
      picks: HelperPick[];
      locale: HelperLocale;
    }
  | { action: "get"; taskIds: string[] }
  | {
      action: "refine";
      taskId: string;
      message: string;
      locale: HelperLocale;
    }
  | { action: "discard"; taskId: string }
  | { action: "erase" };

/** Error codes the browser reacts to. */
export const HELPER_ERRORS = {
  dailyLimit: "daily_limit",
  refineLimit: "refine_limit",
  busy: "busy",
  notFound: "not_found",
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  unavailable: "unavailable",
} as const;
export type HelperErrorCode =
  (typeof HELPER_ERRORS)[keyof typeof HELPER_ERRORS];
