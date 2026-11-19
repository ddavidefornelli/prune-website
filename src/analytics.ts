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

let started = false;
let identity: { distinctId: string; email: string } | null = null;

/** Drops ?query and #fragment, which may carry deep-link or sign-in data. */
function stripUrl(value: unknown): unknown {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function scrubbed(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const key of Object.keys(properties)) {
    if (/url|referrer|href/i.test(key))
      properties[key] = stripUrl(properties[key]);
  }
}

function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  scrubbed(event.properties);
  scrubbed(event.$set);
  scrubbed(event.$set_once);
  return event;
}

/** Starts PostHog once after the visitor accepts optional analytics. */
export function startAnalytics(): boolean {
  if (started) return true;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
  if (!key || !host) {
    const name = !key ? "VITE_POSTHOG_KEY" : "VITE_POSTHOG_HOST";
    if (import.meta.env.DEV) {
      throw new Error(
        `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`,
      );
    }
    return false;
  }
  started = true;
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
    logs: {
      serviceName: "prune-web",
      environment: import.meta.env.MODE,
    },
    session_recording: {
      // Replays show layout and movement only: no planner text, account
      // details or anything typed.
      maskAllInputs: true,
      maskTextSelector: "*",
    },
    before_send: beforeSend,
  });
  if (identity)
    posthog.identify(identity.distinctId, { email: identity.email });
  posthog.logger.info("optional analytics started", {
    event: "optional_analytics_started",
    analytics_consent: "accepted",
  });
  return true;
}

/** Identifies the authenticated account once, including after a restored session. */
export function identifyAccount(distinctId: string, email: string): void {
  if (identity?.distinctId === distinctId) return;
  if (started && identity) posthog.reset();
  identity = { distinctId, email };
  if (started) {
    posthog.identify(distinctId, { email });
    posthog.logger.info("authenticated analytics identity attached", {
      event: "analytics_identity_attached",
    });
  }
}

/** Clears the authenticated identity after a successful logout or account deletion. */
export function resetAccount(): void {
  identity = null;
  if (started) posthog.reset();
}

/** Stops future collection in this tab and forgets the anonymous id. */
export function stopAnalytics(): void {
  identity = null;
  if (!started) return;
  posthog.opt_out_capturing();
  posthog.reset();
}

/** Sends a structured PostHog log, only when the visitor has accepted analytics. */
export function logPostHogError(
  message: string,
  attributes: Record<string, string | number | boolean>,
): void {
  if (started) posthog.logger.error(message, attributes);
}

/** Records a product event, only when the visitor has accepted analytics. */
export function capture(
  event: string,
  properties: Record<string, string | number | boolean> = {},
): void {
  if (started) posthog.capture(event, properties);
}
