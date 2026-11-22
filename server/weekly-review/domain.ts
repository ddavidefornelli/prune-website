import {
  ESTIMATE,
  PLANNER_LIMITS,
  WEEKLY_AI_VERSION,
  type TaskStatus,
  type WeeklyReview,
} from "../planner-contract.ts";
import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import { TIME } from "../../src/shared/time-constants.ts";
import { ApiError } from "../http.ts";

const CONSENT_VERSION = WEEKLY_AI_VERSION;
type Activity = WeeklyReview["activity"];
type Task = Activity["tasks"][number];
type Stop = Activity["stops"][number];
export type ReviewInput = {
  consentVersion: typeof CONSENT_VERSION;
  weekStart: string;
  weekEnd: string;
  activity: Activity;
};
export type Analysis = WeeklyReview["analysis"];

/** Bounds on what a review may contain and what the model may answer. */
const REVIEW_LIMITS = {
  tasks: 256,
  stops: 200,
  idLength: 100,
  /** A century of recorded focus. */
  actualSeconds: 315_576_000,
  stopCount: 1_000_000,
  textCharacters: 16_000,
  reasons: 6,
  evidencePerReason: 30,
  improvements: { min: 1, max: 3 },
  summaryLength: 3000,
  reasonLength: 1500,
  improvementLength: 1000,
} as const;

const STATUSES: readonly unknown[] = [
  "planned",
  "active",
  "completed",
] satisfies TaskStatus[];
const DATE = /^20\d{2}-\d{2}-\d{2}$/;
const DIGITS = 16;
const HEX = 2;

/** Strict JSON field readers; any mismatch throws the reader's error. */
class StrictFields {
  private readonly invalid: () => never;

  constructor(invalid: () => never) {
    this.invalid = invalid;
  }

  fail(): never {
    return this.invalid();
  }

  /** An object with exactly these keys. */
  record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      this.invalid();
    const result = value as Record<string, unknown>;
    if (
      Object.keys(result).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(result, key))
    )
      this.invalid();
    return result;
  }

  text(value: unknown, max: number): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      [...value].length > max ||
      value.includes("\0")
    )
      this.invalid();
    return value;
  }

  integer(value: unknown, min: number, max: number): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      this.invalid();
    return value;
  }

  date(value: unknown): string {
    if (typeof value !== "string" || !DATE.test(value)) this.invalid();
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      this.invalid();
    return value;
  }

  list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) this.invalid();
    return value;
  }
}

const inputFields = new StrictFields(() => {
  throw new ApiError(
    HTTP_STATUS.badRequest,
    "invalid_request",
    "The weekly activity is invalid or exceeds the review limits.",
  );
});

const within = (day: string | null, start: string, end: string) =>
  day !== null && day >= start && day <= end;

/** What a weekly review may be asked about, and what its answer must look like. */
export class ReviewValidator {
  /** Strict allowlist: resource paths/URLs, model choices and prompts are never accepted. */
  static input(value: unknown, now: Date): ReviewInput {
    const fields = inputFields;
    const input = fields.record(value, [
      "consentVersion",
      "weekStart",
      "weekEnd",
      "activity",
    ]);
    if (input.consentVersion !== CONSENT_VERSION)
      throw new ApiError(
        HTTP_STATUS.badRequest,
        "consent_required",
        "Enable weekly AI using the current privacy notice before requesting a review.",
      );
    const weekStart = fields.date(input.weekStart);
    const weekEnd = fields.date(input.weekEnd);
    // The service-only SQL loader picks the week; it can't end in the future.
    const latest = new Date(now.getTime() + TIME.dayMs)
      .toISOString()
      .slice(0, 10);
    if (weekStart > weekEnd || weekEnd > latest) fields.fail();
    const activity = fields.record(input.activity, [
      "tasks",
      "stops",
      "totalStops",
      "omittedStops",
    ]);
    const tasks: Task[] = fields
      .list(activity.tasks, REVIEW_LIMITS.tasks)
      .map((value) => ReviewValidator.task(value));
    const stops = fields.list(activity.stops, REVIEW_LIMITS.stops);
    const taskIds = new Set(tasks.map(({ id }) => id));
    if (taskIds.size !== tasks.length) fields.fail();
    const checkedStops: Stop[] = stops.map((value) => {
      const stop = fields.record(value, [
        "id",
        "taskId",
        "reason",
        "stoppedOn",
      ]);
      const taskId = fields.text(stop.taskId, REVIEW_LIMITS.idLength);
      const stoppedOn = fields.date(stop.stoppedOn);
      if (!taskIds.has(taskId) || !within(stoppedOn, weekStart, weekEnd))
        fields.fail();
      return {
        id: fields.integer(stop.id, 1, Number.MAX_SAFE_INTEGER),
        taskId,
        reason: fields.text(stop.reason, PLANNER_LIMITS.stopReasonLength),
        stoppedOn,
      };
    });
    if (new Set(checkedStops.map(({ id }) => id)).size !== checkedStops.length)
      fields.fail();
    const totalStops = fields.integer(
      activity.totalStops,
      0,
      REVIEW_LIMITS.stopCount,
    );
    const omittedStops = fields.integer(
      activity.omittedStops,
      0,
      REVIEW_LIMITS.stopCount,
    );
    if (
      totalStops !== checkedStops.length + omittedStops ||
      (!tasks.length && !checkedStops.length)
    )
      fields.fail();
    // Older tasks are allowed only as context for a stop or completion in this week.
    const stoppedTaskIds = new Set(checkedStops.map(({ taskId }) => taskId));
    if (
      tasks.some(
        (task) =>
          !within(task.plannedFor, weekStart, weekEnd) &&
          !within(task.completedOn, weekStart, weekEnd) &&
          !stoppedTaskIds.has(task.id),
      )
    )
      fields.fail();
    const textLength =
      tasks.reduce((sum, task) => sum + [...task.outcome].length, 0) +
      checkedStops.reduce((sum, stop) => sum + [...stop.reason].length, 0);
    if (textLength > REVIEW_LIMITS.textCharacters) fields.fail();
    return {
      consentVersion: CONSENT_VERSION,
      weekStart,
      weekEnd,
      activity: { tasks, stops: checkedStops, totalStops, omittedStops },
    };
  }

  /** Reconstructs fields rather than trusting structured output or provider-supplied evidence. */
  static analysis(value: unknown, activity: Activity): Analysis {
    try {
      return ReviewValidator.readAnalysis(value, activity);
    } catch {
      throw new ApiError(
        HTTP_STATUS.badGateway,
        "invalid_review",
        "The AI returned an incomplete or unsupported review. Please retry later.",
      );
    }
  }

  private static readAnalysis(value: unknown, activity: Activity): Analysis {
    const fields = inputFields;
    const analysis = fields.record(value, [
      "summary",
      "mainReasons",
      "improvements",
    ]);
    const reasons = fields.list(analysis.mainReasons, REVIEW_LIMITS.reasons);
    const improvements = fields.list(
      analysis.improvements,
      REVIEW_LIMITS.improvements.max,
    );
    if (
      (activity.stops.length > 0 && reasons.length === 0) ||
      improvements.length < REVIEW_LIMITS.improvements.min
    )
      fields.fail();
    const ids = new Set(activity.stops.map(({ id }) => id));
    const mainReasons = reasons.map((value) => {
      const pattern = fields.record(value, ["reason", "evidenceStopIds"]);
      const evidenceStopIds = fields
        .list(pattern.evidenceStopIds, REVIEW_LIMITS.evidencePerReason)
        .map((id) => fields.integer(id, 1, Number.MAX_SAFE_INTEGER));
      if (
        !evidenceStopIds.length ||
        new Set(evidenceStopIds).size !== evidenceStopIds.length ||
        evidenceStopIds.some((id) => !ids.has(id))
      )
        fields.fail();
      return {
        reason: fields.text(pattern.reason, REVIEW_LIMITS.reasonLength),
        evidenceStopIds,
      };
    });
    return {
      summary: fields.text(analysis.summary, REVIEW_LIMITS.summaryLength),
      mainReasons,
      improvements: improvements.map((step) =>
        fields.text(step, REVIEW_LIMITS.improvementLength),
      ),
    };
  }

  /** A stable hash of the input, so harmless order changes don't invalidate retry caching. */
  static async fingerprint(input: ReviewInput): Promise<string> {
    const canonical = {
      ...input,
      activity: {
        ...input.activity,
        tasks: [...input.activity.tasks].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
        stops: [...input.activity.stops].sort((a, b) => a.id - b.id),
      },
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonical)),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(DIGITS).padStart(HEX, "0"),
    ).join("");
  }

  private static task(value: unknown): Task {
    const fields = inputFields;
    const task = fields.record(value, [
      "id",
      "outcome",
      "plannedFor",
      "completedOn",
      "status",
      "estimatedMinutes",
      "actualSeconds",
    ]);
    if (!STATUSES.includes(task.status)) fields.fail();
    const completedOn =
      task.completedOn === null ? null : fields.date(task.completedOn);
    if ((task.status === "completed") !== (completedOn !== null)) fields.fail();
    return {
      id: fields.text(task.id, REVIEW_LIMITS.idLength),
      outcome: fields.text(task.outcome, PLANNER_LIMITS.outcomeLength),
      plannedFor: fields.date(task.plannedFor),
      completedOn,
      status: task.status as TaskStatus,
      estimatedMinutes: fields.integer(task.estimatedMinutes, 1, ESTIMATE.max),
      actualSeconds: fields.integer(
        task.actualSeconds,
        0,
        REVIEW_LIMITS.actualSeconds,
      ),
    };
  }
}
