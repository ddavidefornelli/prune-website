/** Exact backend paths shared by the transport and generated CSP allowlist. */
export const SUPABASE_ROUTES = {
  sendCode: "/auth/v1/otp",
  verifyCode: "/auth/v1/verify",
  user: "/auth/v1/user",
  token: "/auth/v1/token",
  signOut: "/auth/v1/logout",
  authSettings: "/auth/v1/settings",
  planner: "/rest/v1/rpc/planner_call",
  weeklyReview: "/functions/v1/weekly-review",
  taskSuggestions: "/functions/v1/task-suggestions",
  emailUnsubscribe: "/functions/v1/email-unsubscribe",
} as const;

/** Same-domain relay for client error reports (see server/error-log.ts). */
export const ERROR_LOG_PATH = "/api/error-log";

export const HTTP_LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  requestMs: 20_000,
  reviewMs: 110_000,
  signOutMs: 5000,
} as const;
