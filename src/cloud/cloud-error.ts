import { HTTP_STATUS } from "../shared/api-routes.ts";
import { MESSAGES } from "./messages.ts";

/** PostgREST codes raised by the backend's SQL functions. */
const SQL_CODES = {
  unauthorized: "PT401",
  deleted: "PT403",
  rejected: ["PT400", "PT404", "PT409"],
} as const;

/** A rejection message longer than this is not authored copy. */
const MAX_REJECTION_LENGTH = 300;

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null ? (value as JsonObject) : {};

/**
 * A failure with a machine-readable code. The list's sync depends on the code
 * to tell a definite rejection ("validation") from an ambiguous failure it may
 * retry ("network", "server").
 */
export class CloudError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudError";
    this.code = code;
  }

  /** The code of any error-like value: SDK errors, adapters or saved state. */
  static codeOf(error: unknown): string {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  }

  /** Classifies a failed HTTP response from Supabase. */
  static fromResponse(status: number, value: unknown): CloudError {
    const body = asObject(value);
    if (
      status === HTTP_STATUS.unauthorized ||
      body.code === SQL_CODES.unauthorized
    )
      return new CloudError("unauthorized", MESSAGES.sessionExpired);
    if (body.code === SQL_CODES.deleted)
      return new CloudError("account_deleted", MESSAGES.accountDeleted);
    if (status === HTTP_STATUS.tooManyRequests)
      return new CloudError("rate_limited", MESSAGES.rateLimited);
    if (
      (SQL_CODES.rejected as readonly unknown[]).includes(body.code) &&
      typeof body.message === "string" &&
      body.message.length < MAX_REJECTION_LENGTH
    )
      return new CloudError("validation", body.message);
    return new CloudError("server", MESSAGES.serverFailed);
  }
}
