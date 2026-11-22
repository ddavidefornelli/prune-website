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
  /** OpenRouter: a US host, with routing that keeps requests off DeepSeek's own API (China). */
  defaultUrl: "https://openrouter.ai/api/v1/chat/completions",
  defaultModel: "deepseek/deepseek-v4.1-flash",
  /**
   * OpenRouter provider routing, sent with every request when the URL is
   * OpenRouter's: never the model makers' own services in China, and only
   * providers that do not keep prompts for training.
   */
  openRouterProvider: {
    ignore: ["deepseek", "moonshotai"],
    data_collection: "deny",
  },
  classifyTokens: 2000,
  choicesTokens: 2000,
  answerTokens: 8000,
  quickTimeoutMs: 30_000,
  answerTimeoutMs: 120_000,
  /** A run still "working" after this long has died with its worker. */
  staleMs: 10 * 60 * 1000,
  maxBodyBytes: 32 * 1024,
} as const;
