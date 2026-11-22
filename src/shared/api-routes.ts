/**
 * Exact backend paths the browser calls. The generated CSP allows exactly
 * these, so a path added here becomes reachable from the page.
 */
export const SUPABASE_ROUTES = {
  /** Creates a guest: Supabase's anonymous sign-in. */
  signUp: "/auth/v1/signup",
  user: "/auth/v1/user",
  token: "/auth/v1/token",
  signOut: "/auth/v1/logout",
  /** Emails a six-digit sign-in code. */
  otp: "/auth/v1/otp",
  verify: "/auth/v1/verify",
  /** Google sign-in starts here (a page load, not a fetch). */
  authorize: "/auth/v1/authorize",
  planner: "/rest/v1/rpc/planner_call",
  list: "/rest/v1/rpc/planner_list",
  emailUnsubscribe: "/functions/v1/email-unsubscribe",
  /** "Do it for me" (see server/helper/endpoint.ts). */
  helper: "/functions/v1/task-helper",
} as const;

/** Supabase Realtime: one WebSocket that says when a shared list changed. */
export const REALTIME = {
  socketPath: "/realtime/v1/websocket",
  protocolVersion: "1.0.0",
  /** Phoenix closes a socket that is silent for 60 s. */
  heartbeatMs: 25_000,
  /** How often the channel checks for a refreshed access token. */
  tokenCheckMs: 5 * 60_000,
  initialRetryMs: 2000,
  maxRetryMs: 60_000,
} as const;

/** Same-domain relay for client error reports (see server/error-log.ts). */
export const ERROR_LOG_PATH = "/api/error-log";

export const HTTP_LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  requestMs: 20_000,
  signOutMs: 5000,
} as const;

/** The HTTP statuses the app reacts to by number. */
export const HTTP_STATUS = {
  ok: 200,
  noContent: 204,
  resetContent: 205,
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  gone: 410,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  serverError: 500,
  badGateway: 502,
} as const;
