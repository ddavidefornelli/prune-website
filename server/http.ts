import { HTTP_STATUS } from "../src/shared/api-routes.ts";
import { CORS, REQUEST_LIMITS, RETRY_AFTER_SECONDS } from "./constants.ts";

/** Only explicitly authored API errors may be returned to a caller. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Reads a request or provider body under a size cap and a deadline. */
export class LimitedBody {
  /** Bounded streaming read, even if Content-Length is missing or dishonest. */
  static async read(
    stream: ReadableStream<Uint8Array> | null,
    max: number,
    timeoutMs: number = REQUEST_LIMITS.readTimeoutMs,
  ): Promise<string> {
    if (!stream)
      throw new ApiError(
        HTTP_STATUS.badRequest,
        "invalid_json",
        "A JSON body is required.",
      );
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ApiError(
            HTTP_STATUS.requestTimeout,
            "read_timeout",
            "The request or response timed out.",
          ),
        );
        void reader.cancel().catch(() => {});
      }, timeoutMs);
    });
    try {
      while (true) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          // An untrusted stream's cancel hook may hang or reject.
          void reader.cancel().catch(() => {});
          throw new ApiError(
            HTTP_STATUS.payloadTooLarge,
            "payload_too_large",
            "The request or response exceeds the review size limit.",
          );
        }
        chunks.push(value);
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

/** The website origins a function answers from a browser. */
export class AllowedOrigins {
  /**
   * `ALLOWED_ORIGINS` (or the production site when unset) plus
   * `EXTRA_ALLOWED_ORIGINS`, which adds to the shared list, never replacing it.
   */
  static fromEnvironment(
    allowed: string | undefined,
    extra: string | undefined,
  ): Set<string> {
    return new Set(
      [allowed || CORS.defaultOrigin, extra]
        .join(",")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
}

/** Messages that differ between JSON endpoints. */
export interface EndpointCopy {
  method: string;
  invalidRequest: string;
  unavailable: string;
}

const BEARER = /^Bearer ([^\s]+)$/i;
const JSON_TYPE = "application/json";

/**
 * A signed-in, browser-facing JSON endpoint: CORS for allowed origins, POST
 * only, a bearer session and a small JSON body. Subclasses validate the body
 * and do the work; anything they throw that is not an `ApiError` becomes a
 * generic "unavailable", so no internal detail ever reaches the caller.
 */
export abstract class JsonEndpoint<Body> {
  private readonly allowedOrigins: Set<string>;
  private readonly maxBodyBytes: number;
  private readonly copy: EndpointCopy;

  protected constructor(
    allowedOrigins: Set<string>,
    maxBodyBytes: number,
    copy: EndpointCopy,
  ) {
    this.allowedOrigins = allowedOrigins;
    this.maxBodyBytes = maxBodyBytes;
    this.copy = copy;
  }

  /** The verified user id behind a bearer token. */
  protected abstract authenticate(token: string): Promise<string>;

  /** Narrows the parsed JSON body, or returns null when it is not acceptable. */
  protected abstract parse(value: Record<string, unknown>): Body | null;

  /** Does the work and returns the JSON response body. */
  protected abstract run(userId: string, body: Body): Promise<unknown>;

  /** For `Deno.serve`, and safe to pass around. */
  readonly handle = async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Content-Type": JSON_TYPE,
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (origin && this.allowedOrigins.has(origin))
      headers.set("Access-Control-Allow-Origin", origin);
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers });
    try {
      // CORS is only a browser policy. Authentication and DB quotas protect native requests too.
      if (origin && !this.allowedOrigins.has(origin))
        throw new ApiError(
          HTTP_STATUS.forbidden,
          "origin_not_allowed",
          "This origin is not allowed.",
        );
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", CORS.methods);
        headers.set("Access-Control-Allow-Headers", CORS.headers);
        return new Response(null, { status: HTTP_STATUS.noContent, headers });
      }
      if (request.method !== "POST") {
        headers.set("Allow", CORS.methods);
        throw new ApiError(
          HTTP_STATUS.methodNotAllowed,
          "method_not_allowed",
          this.copy.method,
        );
      }
      const userId = await this.authenticate(JsonEndpoint.bearer(request));
      const body = this.parse(await this.readJson(request));
      if (!body)
        throw new ApiError(
          HTTP_STATUS.badRequest,
          "invalid_request",
          this.copy.invalidRequest,
        );
      return respond(HTTP_STATUS.ok, await this.run(userId, body));
    } catch (error) {
      const safe =
        error instanceof ApiError
          ? error
          : new ApiError(
              HTTP_STATUS.unavailable,
              "unavailable",
              this.copy.unavailable,
            );
      if (safe.status === HTTP_STATUS.tooManyRequests)
        headers.set("Retry-After", String(RETRY_AFTER_SECONDS.limited));
      if (safe.code === "running")
        headers.set("Retry-After", String(RETRY_AFTER_SECONDS.running));
      return respond(safe.status, {
        error: { code: safe.code, message: safe.message },
      });
    }
  };

  /** Rejects a declared length over the limit before reading anything. */
  protected checkDeclaredLength(request: Request, message: string): void {
    const declared = request.headers.get("Content-Length");
    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > this.maxBodyBytes)
    )
      throw new ApiError(
        HTTP_STATUS.payloadTooLarge,
        "payload_too_large",
        message,
      );
  }

  /** Reads a timezone field the way every endpoint accepts it. */
  protected static timezone(value: Record<string, unknown>): string | null {
    const timezone = value.timezone;
    return typeof timezone === "string" &&
      timezone &&
      timezone.length <= REQUEST_LIMITS.timezoneLength
      ? timezone
      : null;
  }

  private static bearer(request: Request): string {
    const bearer = BEARER.exec(request.headers.get("Authorization") ?? "");
    if (!bearer || bearer[1]!.length > REQUEST_LIMITS.bearerLength)
      throw new ApiError(
        HTTP_STATUS.unauthorized,
        "unauthorized",
        "A signed-in user session is required.",
      );
    return bearer[1]!;
  }

  private async readJson(request: Request): Promise<Record<string, unknown>> {
    const type = request.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== JSON_TYPE)
      throw new ApiError(
        HTTP_STATUS.unsupportedMediaType,
        "invalid_content_type",
        "Use application/json.",
      );
    this.beforeRead(request);
    let value: unknown;
    try {
      value = JSON.parse(
        await LimitedBody.read(request.body, this.maxBodyBytes),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HTTP_STATUS.badRequest,
        "invalid_json",
        "A valid JSON body is required.",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError(
        HTTP_STATUS.badRequest,
        "invalid_request",
        this.copy.invalidRequest,
      );
    return value as Record<string, unknown>;
  }

  /** A hook to reject a request from its headers before the body is read. */
  protected beforeRead(_request: Request): void {}
}
