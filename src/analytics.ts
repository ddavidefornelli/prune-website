/**
 * Optional product analytics, session replay and heatmaps (PostHog, EU cloud).
 * Nothing here runs until the visitor selects "Accept optional" in the cookie
 * banner: before that, `capture` is a no-op and no PostHog request is made.
 *
 * Replays mask every input and text node, query strings and fragments are
 * stripped from URLs, and custom events are planner journey codes only (short
 * codes, never typed text).
 */
import posthog, { type CaptureResult } from "posthog-js";

export type EventProperties = Record<string, string | number | boolean>;

const SERVICE_NAME = "prune-web";
const URL_PROPERTY = /url|referrer|href/i;
const ABSOLUTE_URL = /^https?:\/\//;
const ENV_NAMES = {
  key: "VITE_POSTHOG_KEY",
  host: "VITE_POSTHOG_HOST",
} as const;

const missingConfiguration = (name: string) =>
  `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`;

export class Analytics {
  private started = false;
  private identity: { distinctId: string; email: string | null } | null = null;

  /** Drops ?query and #fragment, which may carry deep-link or sign-in data. */
  private static stripUrl(value: unknown): unknown {
    if (typeof value !== "string" || !ABSOLUTE_URL.test(value)) return value;
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  }

  private static scrub(properties: Record<string, unknown> | undefined): void {
    if (!properties) return;
    for (const key of Object.keys(properties))
      if (URL_PROPERTY.test(key))
        properties[key] = Analytics.stripUrl(properties[key]);
  }

  private static beforeSend(event: CaptureResult | null): CaptureResult | null {
    if (!event) return event;
    Analytics.scrub(event.properties);
    Analytics.scrub(event.$set);
    Analytics.scrub(event.$set_once);
    return event;
  }

  /** Starts PostHog once after the visitor accepts optional analytics. */
  start(): boolean {
    if (this.started) return true;
    const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
    const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
    if (!key || !host) {
      if (import.meta.env.DEV)
        throw new Error(
          missingConfiguration(!key ? ENV_NAMES.key : ENV_NAMES.host),
        );
      return false;
    }
    this.started = true;
    posthog.init(key, {
      api_host: host,
      person_profiles: "always",
      capture_pageview: "history_change",
      capture_pageleave: true,
      enable_heatmaps: true,
      capture_exceptions: {
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
        capture_console_errors: false,
      },
      save_referrer: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      logs: { serviceName: SERVICE_NAME, environment: import.meta.env.MODE },
      session_recording: {
        // Replays show layout and movement only: no planner text, account
        // details or anything typed.
        maskAllInputs: true,
        maskTextSelector: "*",
      },
      before_send: Analytics.beforeSend,
    });
    if (this.identity)
      posthog.identify(this.identity.distinctId, {
        ...(this.identity.email ? { email: this.identity.email } : {}),
      });
    posthog.logger.info("optional analytics started", {
      event: "optional_analytics_started",
      analytics_consent: "accepted",
    });
    return true;
  }

  /** Identifies the authenticated account once, including after a restored session. */
  /** `email` is null for a guest. */
  identify(distinctId: string, email: string | null): void {
    if (this.identity?.distinctId === distinctId) return;
    if (this.started && this.identity) posthog.reset();
    this.identity = { distinctId, email };
    if (!this.started) return;
    posthog.identify(distinctId, email ? { email } : {});
    posthog.logger.info("authenticated analytics identity attached", {
      event: "analytics_identity_attached",
    });
  }

  /** Clears the authenticated identity after a successful logout or account deletion. */
  forgetAccount(): void {
    this.identity = null;
    if (this.started) posthog.reset();
  }

  /** Stops future collection in this tab and forgets the anonymous id. */
  stop(): void {
    this.identity = null;
    if (!this.started) return;
    posthog.opt_out_capturing();
    posthog.reset();
  }

  /** Sends a structured PostHog log, only when the visitor has accepted analytics. */
  logError(message: string, attributes: EventProperties): void {
    if (this.started) posthog.logger.error(message, attributes);
  }

  /** Records a product event, only when the visitor has accepted analytics. */
  capture(event: string, properties: EventProperties = {}): void {
    if (this.started) posthog.capture(event, properties);
  }
}

/** One per page: consent and identity are page-wide. */
export const analytics = new Analytics();
