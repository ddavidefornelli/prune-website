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
