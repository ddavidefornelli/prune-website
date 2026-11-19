import { ApiError, readLimited } from "../http.ts";
import {
  openSlots,
  type Suggestion,
  type SuggestionInput,
} from "./provider.ts";

const MAX_BODY_BYTES = 1024;

/** Which local day to plan; it is always derived from the day before. */
export type SuggestionTarget = "today" | "tomorrow";

export type Dependencies = {
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
};

/** Proposes a day's tasks from the previous day's plan. Planner data is loaded server-side, never trusted from the caller. */
export function createHandler(
  deps: Dependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (origin && deps.allowedOrigins.has(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && !deps.allowedOrigins.has(origin))
        throw new ApiError(
          403,
          "origin_not_allowed",
          "This origin is not allowed.",
        );
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        headers.set(
          "Access-Control-Allow-Headers",
          "authorization, apikey, content-type, x-client-info",
        );
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        headers.set("Allow", "POST, OPTIONS");
        throw new ApiError(405, "method_not_allowed", "Use POST.");
      }
      const bearer = /^Bearer ([^\s]+)$/i.exec(
        request.headers.get("Authorization") ?? "",
      );
      if (!bearer || bearer[1].length > 8192)
        throw new ApiError(
          401,
          "unauthorized",
          "A signed-in user session is required.",
        );
      const userId = await deps.authenticate(bearer[1]);
      if (
        request.headers
          .get("Content-Type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new ApiError(
          415,
          "invalid_content_type",
          "Use application/json.",
        );
      let value: unknown;
      try {
        value = JSON.parse(await readLimited(request.body, MAX_BODY_BYTES));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          400,
          "invalid_json",
          "A valid JSON body is required.",
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => key !== "timezone" && key !== "target",
        ) ||
        ("target" in value &&
          value.target !== "today" &&
          value.target !== "tomorrow") ||
        !("timezone" in value) ||
        typeof value.timezone !== "string" ||
        !value.timezone ||
        value.timezone.length > 100
      )
        throw new ApiError(
          400,
          "invalid_request",
          "Send your device timezone and an optional target day.",
        );
      const target: SuggestionTarget =
        "target" in value && value.target === "tomorrow" ? "tomorrow" : "today";
      const input = await deps.loadInput(userId, value.timezone, target);
      if ("disabled" in input)
        throw new ApiError(
          403,
          "consent_required",
          "AI features are turned off for this account.",
        );
      // Nothing to derive from, or nothing left to fill: never call the provider.
      if (!input.sourceTasks.length || !openSlots(input))
        return respond(200, { day: input.day, suggestions: [] });
      if (!(await deps.reserve(userId, input.day)))
        throw new ApiError(
          429,
          "rate_limited",
          "This day's suggestion allowance has been used.",
        );
      return respond(200, {
        day: input.day,
        suggestions: await deps.generate(input, userId),
      });
    } catch (error) {
      const safe =
        error instanceof ApiError
          ? error
          : new ApiError(
              503,
              "unavailable",
              "Suggestions are temporarily unavailable. Your planner is unaffected.",
            );
      if (safe.status === 429) headers.set("Retry-After", "3600");
      return respond(safe.status, {
        error: { code: safe.code, message: safe.message },
      });
    }
  };
}
