/**
 * Exact backend paths the browser calls. The generated CSP allows exactly
 * these, so a path added here becomes reachable from the page.
 */
export const SUPABASE_ROUTES = {
  sendCode: "/auth/v1/otp",
  verifyCode: "/auth/v1/verify",
  user: "/auth/v1/user",
  token: "/auth/v1/token",
  signOut: "/auth/v1/logout",
  authSettings: "/auth/v1/settings",
  planner: "/rest/v1/rpc/planner_call",
  schedule: "/rest/v1/rpc/planner_schedule",
  track: "/rest/v1/rpc/planner_track",
  weeklyReview: "/functions/v1/weekly-review",
  taskSuggestions: "/functions/v1/task-suggestions",
  emailUnsubscribe: "/functions/v1/email-unsubscribe",
} as const;

/** Every Edge Function path starts with this. */
export const FUNCTIONS_PREFIX = "/functions/";

/** Same-domain relay for client error reports (see server/error-log.ts). */
export const ERROR_LOG_PATH = "/api/error-log";

export const HTTP_LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  requestMs: 20_000,
  reviewMs: 110_000,
  signOutMs: 5000,
} as const;

/** The HTTP statuses the app reacts to by number. */
export const HTTP_STATUS = {
  ok: 200,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  requestTimeout: 408,
  conflict: 409,
  gone: 410,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  tooManyRequests: 429,
  serverError: 500,
  badGateway: 502,
  unavailable: 503,
} as const;
