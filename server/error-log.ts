import { HTTP_STATUS } from "../src/shared/api-routes.ts";
import { PRODUCTION_ORIGINS } from "../src/shared/site.ts";
import { ERROR_LOG } from "./constants.ts";

export interface ErrorLogConfig {
  url: string;
  publicKey: string;
  origins?: readonly string[];
  fetcher?: typeof fetch;
}

/** The anon-only RPC that stores a report. */
const LOG_RPC = "/rest/v1/rpc/log_client_error";
const NAME = /^[a-z_]{1,32}$/;
const COUNTRY = /^[A-Z]{2}$/;
const PUBLISHABLE_KEY_PREFIX = "sb_publishable_";
const COUNTRY_HEADER = "x-vercel-ip-country";
/** Most specific first: Edge and Opera also say "Chrome". */
const BROWSERS: readonly [family: string, pattern: RegExp][] = [
  ["edge", /Edg(?:A|iOS)?\//],
  ["opera", /OPR\/|Opera/],
  ["samsung", /SamsungBrowser\//],
  ["firefox", /Firefox\/|FxiOS\//],
  ["chrome", /Chrome\/|CriOS\//],
  ["safari", /Safari\//],
];
const MOBILE = /Mobi|Android|iPhone|iPad/;

const empty = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Same-domain relay for client error reports. Runs on the website's host so it
 * still works when a visitor's network blocks Supabase. Adds country (from the
 * host's geo header) and browser family, then forwards to an anon-only RPC.
 */
export class ErrorLogRelay {
  private readonly config: ErrorLogConfig;

  constructor(config: ErrorLogConfig) {
    this.config = config;
  }

  /** Coarse browser family only; the raw user agent is never stored or forwarded. */
  static browserFamily(userAgent: string): string {
    return (
      BROWSERS.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "other"
    );
  }

  static deviceType(userAgent: string): string {
    return MOBILE.test(userAgent) ? "mobile" : "desktop";
  }

  readonly handle = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return empty(HTTP_STATUS.methodNotAllowed);
    const origins = this.config.origins ?? PRODUCTION_ORIGINS;
    if (!origins.includes(request.headers.get("Origin") ?? ""))
      return empty(HTTP_STATUS.forbidden);
    let body: { event?: unknown; context?: unknown; detail?: unknown };
    try {
      const text = await request.text();
      if (text.length > ERROR_LOG.maxBodyBytes)
        return empty(HTTP_STATUS.payloadTooLarge);
      body = JSON.parse(text);
    } catch {
      return empty(HTTP_STATUS.badRequest);
    }
    const { event, context, detail } = body ?? {};
    if (
      ![event, context, detail].every(
        (value) => typeof value === "string" && NAME.test(value),
      )
    )
      return empty(HTTP_STATUS.badRequest);
    const country = request.headers.get(COUNTRY_HEADER) ?? "";
    const userAgent = request.headers.get("User-Agent") ?? "";
    try {
      const response = await (this.config.fetcher ?? fetch)(
        `${this.config.url}${LOG_RPC}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            p_event: event,
            p_context: context,
            p_detail: detail,
            p_country: COUNTRY.test(country) ? country : "",
            p_browser: ErrorLogRelay.browserFamily(userAgent),
            p_device: ErrorLogRelay.deviceType(userAgent),
          }),
          signal: AbortSignal.timeout(ERROR_LOG.forwardTimeoutMs),
        },
      );
      return empty(
        response.ok
          ? HTTP_STATUS.noContent
          : response.status === HTTP_STATUS.badRequest
            ? HTTP_STATUS.badRequest
            : HTTP_STATUS.badGateway,
      );
    } catch {
      return empty(HTTP_STATUS.badGateway);
    }
  };

  /** Legacy anon keys are JWTs; publishable keys go in the apikey header only. */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: this.config.publicKey,
    };
    if (!this.config.publicKey.startsWith(PUBLISHABLE_KEY_PREFIX))
      headers.Authorization = `Bearer ${this.config.publicKey}`;
    return headers;
  }
}
