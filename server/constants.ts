import { SITE } from "../src/shared/site.ts";

/** Request bounds for the JSON Edge Functions. */
export const REQUEST_LIMITS = {
  /** The weekly review's request; its activity is loaded server-side. */
  reviewBytes: 65_536,
  suggestionBytes: 1024,
  errorReportBytes: 512,
  /** A body or provider response that streams slower than this is dropped. */
  readTimeoutMs: 10_000,
  bearerLength: 8192,
  timezoneLength: 100,
} as const;

/** Browser access to the JSON functions. CORS is not authentication. */
export const CORS = {
  methods: "POST, OPTIONS",
  headers: "authorization, apikey, content-type, x-client-info",
  /** The origin when ALLOWED_ORIGINS is not set. */
  defaultOrigin: SITE.origin,
} as const;

export const RETRY_AFTER_SECONDS = {
  /** A spent allowance: try again in an hour. */
  limited: 3600,
  /** A review being written right now. */
  running: 15,
} as const;

export const OPENAI = {
  chatUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  provider: "openai",
} as const;

export const WEEKLY_REVIEW_AI = {
  maxOutputTokens: 6000,
  maxResponseBytes: 131_072,
  timeoutMs: 90_000,
} as const;

export const SUGGESTION_AI = {
  maxOutputTokens: 800,
  maxResponseBytes: 32_768,
  timeoutMs: 30_000,
  maxOutcomeLength: 120,
} as const;

export const REMINDERS = {
  /** Emails sent at once by one run. */
  concurrency: 4,
  /** Emails per run when REMINDER_BATCH_LIMIT is unset (Brevo's free plan allows 300 a day). */
  defaultBatch: 100,
  maxBatch: 1000,
  maxTaskChars: 200,
  sender: SITE.name,
} as const;

export const BREVO = {
  sendUrl: "https://api.brevo.com/v3/smtp/email",
  timeoutMs: 15_000,
} as const;

export const WEB_PUSH = {
  timeoutMs: 10_000,
  /** A reminder is useless hours later. */
  ttlSeconds: 3600,
  recordSize: 4096,
  /** VAPID tokens expire after this many seconds. */
  vapidLifetimeSeconds: 12 * 3600,
  topicLength: 32,
} as const;

export const ERROR_LOG = {
  forwardTimeoutMs: 5000,
} as const;
