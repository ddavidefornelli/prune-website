import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import { OPENAI, REQUEST_LIMITS } from "../constants.ts";
import { ApiError, JsonEndpoint } from "../http.ts";
import { ReviewValidator, type Analysis, type ReviewInput } from "./domain.ts";

export type Reservation =
  | { outcome: "reserved"; id: string; leaseToken: string }
  | {
      outcome: "cached";
      analysis: Analysis;
      model: string;
      generatedAt: string;
    }
  | {
      outcome:
        | "disabled"
        | "invalid"
        | "running"
        | "rate_limited"
        | "weekly_limit"
        | "global_limit"
        | "conflict"
        | "expired";
    };

type Refused = Exclude<Reservation, { outcome: "reserved" | "cached" }>;

export interface ReviewDependencies {
  authenticate: (token: string) => Promise<string>;
  loadInput: (userId: string, timezone: string) => Promise<unknown>;
  reserve: (
    userId: string,
    input: ReviewInput,
    hash: string,
  ) => Promise<Reservation>;
  generate: (input: ReviewInput, userId: string) => Promise<Analysis>;
  finish: (id: string, token: string, analysis: Analysis) => Promise<boolean>;
  fail: (id: string, token: string) => Promise<void>;
  now: () => Date;
  allowedOrigins: Set<string>;
}

const RESERVATION_ERRORS: Record<
  Refused["outcome"],
  readonly [status: number, message: string]
> = {
  disabled: [HTTP_STATUS.unavailable, "Weekly AI is temporarily disabled."],
  invalid: [
    HTTP_STATUS.badRequest,
    "The requested review week or consent version is invalid.",
  ],
  running: [
    HTTP_STATUS.conflict,
    "This review is already being generated. Please check again shortly.",
  ],
  rate_limited: [
    HTTP_STATUS.tooManyRequests,
    "The review retry allowance has been reached. Please try later.",
  ],
  weekly_limit: [
    HTTP_STATUS.tooManyRequests,
    "Your free weekly review allowance has been used.",
  ],
  global_limit: [
    HTTP_STATUS.unavailable,
    "The free AI allowance has been reached. Your planner is unaffected.",
  ],
  conflict: [
    HTTP_STATUS.conflict,
    "A review already exists for these tasks with different activity. It cannot be regenerated.",
  ],
  expired: [
    HTTP_STATUS.gone,
    "The retry cache has expired. Saved account reviews are unaffected.",
  ],
};

const FIELDS: readonly string[] = ["timezone"];

/**
 * The weekly check-in. The database decides which tasks a review covers and
 * enforces one paid call per check-in; a reservation that fails is released.
 */
export class WeeklyReviewEndpoint extends JsonEndpoint<{ timezone: string }> {
  private readonly deps: ReviewDependencies;

  constructor(deps: ReviewDependencies) {
    super(deps.allowedOrigins, REQUEST_LIMITS.reviewBytes, {
      method: "Use POST to request a review.",
      invalidRequest:
        "Send your device timezone. Review activity is loaded from your account.",
      unavailable:
        "Weekly AI is temporarily unavailable. Your planner is unaffected.",
    });
    this.deps = deps;
  }

  protected authenticate(token: string): Promise<string> {
    return this.deps.authenticate(token);
  }

  protected beforeRead(request: Request): void {
    this.checkDeclaredLength(
      request,
      "The weekly activity exceeds the review size limit.",
    );
  }

  protected parse(value: Record<string, unknown>): { timezone: string } | null {
    const timezone = JsonEndpoint.timezone(value);
    if (!timezone || Object.keys(value).some((key) => !FIELDS.includes(key)))
      return null;
    return { timezone };
  }

  protected async run(
    userId: string,
    { timezone }: { timezone: string },
  ): Promise<unknown> {
    const source = await this.deps.loadInput(userId, timezone);
    if (WeeklyReviewEndpoint.isDisabled(source))
      throw new ApiError(
        HTTP_STATUS.forbidden,
        "consent_required",
        "Enable weekly AI in your account before requesting a review.",
      );
    if (WeeklyReviewEndpoint.isEmpty(source)) return { noData: true };
    const input = ReviewValidator.input(source, this.deps.now());
    const claim = await this.deps.reserve(
      userId,
      input,
      await ReviewValidator.fingerprint(input),
    );
    if (claim.outcome === "cached")
      return {
        analysis: ReviewValidator.analysis(claim.analysis, input.activity),
        model: claim.model,
        generatedAt: claim.generatedAt,
        cached: true,
      };
    if (claim.outcome !== "reserved") {
      const [status, message] = RESERVATION_ERRORS[claim.outcome];
      throw new ApiError(status, claim.outcome, message);
    }
    let analysis: Analysis;
    try {
      analysis = ReviewValidator.analysis(
        await this.deps.generate(input, userId),
        input.activity,
      );
      if (!(await this.deps.finish(claim.id, claim.leaseToken, analysis)))
        throw new ApiError(
          HTTP_STATUS.unavailable,
          "save_failed",
          "The review could not be saved. Please retry later.",
        );
    } catch (error) {
      // The lease expires on its own; keep the attempt charged.
      await this.deps.fail(claim.id, claim.leaseToken).catch(() => {});
      throw error;
    }
    return {
      analysis,
      model: OPENAI.model,
      generatedAt: this.deps.now().toISOString(),
      cached: false,
    };
  }

  private static isDisabled(source: unknown): boolean {
    return !!source && typeof source === "object" && "disabled" in source;
  }

  private static isEmpty(source: unknown): boolean {
    if (!source || typeof source !== "object" || !("activity" in source))
      return false;
    const activity = source.activity as {
      tasks?: unknown[];
      stops?: unknown[];
    };
    return activity.tasks?.length === 0 && activity.stops?.length === 0;
  }
}
