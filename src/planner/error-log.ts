import { analytics } from "../analytics.ts";
import { ERROR_LOG_PATH } from "../shared/api-routes.ts";
import { PRODUCTION_ORIGINS } from "../shared/site.ts";

/** Add a name here (and to the error_log table check) to log a new kind of error. */
export type ErrorLogEvent = "signin_network";

export type NetworkFailure = "offline" | "timeout" | "failed";

const TIMEOUT_TEXT = /abort|timeout|timed out/i;

/**
 * Fire-and-forget reports to the same-domain relay. Sends only short names,
 * no user data; the relay adds country and browser family. At most once per
 * event/context per page load, and only on the production site.
 */
export class ErrorReporter {
  private readonly sent = new Set<string>();

  report(event: ErrorLogEvent, context: string, detail: string): void {
    if (!PRODUCTION_ORIGINS.includes(window.location.origin)) return;
    const key = `${event}:${context}:${detail}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    analytics.logError("sign-in network request failed", {
      event,
      context,
      detail,
    });
    try {
      void fetch(ERROR_LOG_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, context, detail }),
        keepalive: true,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }).catch(() => {});
    } catch {
      /* Reporting must never affect the app. */
    }
  }

  /** Why a request never got a response: offline, timed out, or blocked/failed. */
  static networkFailure(error: unknown): NetworkFailure {
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      return "offline";
    const text =
      error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return TIMEOUT_TEXT.test(text) ? "timeout" : "failed";
  }
}

export const errorReporter = new ErrorReporter();
