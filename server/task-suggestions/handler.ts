import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import type { SuggestionTarget } from "../planner-contract.ts";
import { REQUEST_LIMITS } from "../constants.ts";
import { ApiError, JsonEndpoint } from "../http.ts";
import {
  SuggestionPlan,
  type Suggestion,
  type SuggestionInput,
} from "./provider.ts";

export interface SuggestionDependencies {
  authenticate: (token: string) => Promise<string>;
  /** `disabled` when the account turned AI off or is marked for deletion. */
  loadInput: (
    userId: string,
    timezone: string,
    target: SuggestionTarget,
  ) => Promise<SuggestionInput | { disabled: true }>;
  /** Charges one attempt against the account's daily allowance. */
  reserve: (userId: string, day: string) => Promise<boolean>;
  generate: (input: SuggestionInput, userId: string) => Promise<Suggestion[]>;
  allowedOrigins: Set<string>;
}

interface SuggestionRequest {
  timezone: string;
  target: SuggestionTarget;
}

const FIELDS: readonly string[] = ["timezone", "target"];
const TARGETS: readonly unknown[] = ["today", "tomorrow"];

/**
 * Proposes a day's tasks from the previous day's plan. Planner data is loaded
 * server-side, never trusted from the caller.
 */
export class TaskSuggestionEndpoint extends JsonEndpoint<SuggestionRequest> {
  private readonly deps: SuggestionDependencies;

  constructor(deps: SuggestionDependencies) {
    super(deps.allowedOrigins, REQUEST_LIMITS.suggestionBytes, {
      method: "Use POST.",
      invalidRequest: "Send your device timezone and an optional target day.",
      unavailable:
        "Suggestions are temporarily unavailable. Your planner is unaffected.",
    });
    this.deps = deps;
  }

  protected authenticate(token: string): Promise<string> {
    return this.deps.authenticate(token);
  }

  protected parse(value: Record<string, unknown>): SuggestionRequest | null {
    const timezone = JsonEndpoint.timezone(value);
    if (
      !timezone ||
      Object.keys(value).some((key) => !FIELDS.includes(key)) ||
      ("target" in value && !TARGETS.includes(value.target))
    )
      return null;
    return {
      timezone,
      target: value.target === "tomorrow" ? "tomorrow" : "today",
    };
  }

  protected async run(
    userId: string,
    { timezone, target }: SuggestionRequest,
  ): Promise<unknown> {
    const input = await this.deps.loadInput(userId, timezone, target);
    if ("disabled" in input)
      throw new ApiError(
        HTTP_STATUS.forbidden,
        "consent_required",
        "AI features are turned off for this account.",
      );
    // Nothing to derive from, or nothing left to fill: never call the provider.
    if (!input.sourceTasks.length || !new SuggestionPlan(input).openSlots)
      return { day: input.day, suggestions: [] };
    if (!(await this.deps.reserve(userId, input.day)))
      throw new ApiError(
        HTTP_STATUS.tooManyRequests,
        "rate_limited",
        "This day's suggestion allowance has been used.",
      );
    return {
      day: input.day,
      suggestions: await this.deps.generate(input, userId),
    };
  }
}
