import { SITE } from "../src/shared/site.ts";

/** Browser access to the unsubscribe function. CORS is not authentication. */
export const CORS = {
  methods: "POST, OPTIONS",
  /** The origin when ALLOWED_ORIGINS is not set. */
  defaultOrigin: SITE.origin,
} as const;

export const REMINDERS = {
  /** Emails sent at once by one run. */
  concurrency: 4,
  /** Emails per run when REMINDER_BATCH_LIMIT is unset (Brevo's free plan allows 300 a day). */
  defaultBatch: 100,
  maxBatch: 1000,
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

/** The same-domain error relay (see error-log.ts). */
export const ERROR_LOG = {
  /** A report is three short names; anything bigger is not one. */
  maxBodyBytes: 512,
  forwardTimeoutMs: 5000,
} as const;

/** The task helper (see helper/). Limits the browser also knows are in src/shared/helper-contract.ts. */
export const HELPER = {
  model: "claude-opus-5-5",
  /** For the answer; sorting tasks and writing questions run at low effort. */
  effort: "medium",
  /** Refusals are retried on another model inside the same call. */
  fallbackBeta: "server-side-fallback-2026-07-01",
  classifyTokens: 4000,
  choicesTokens: 4000,
  answerTokens: 32_000,
  /** Web searches in one answer. */
  maxSearches: 5,
  /** Times a paused answer (long web search) is picked up again. */
  maxContinuations: 4,
  maxSources: 8,
  /** A run still "working" after this long has died with its worker. */
  staleMs: 10 * 60 * 1000,
  maxBodyBytes: 32 * 1024,
} as const;
