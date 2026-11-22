/**
 * Optional product analytics, session replay and heatmaps (PostHog, EU cloud).
 * Nothing here runs until the visitor selects "Accept optional" in the cookie
 * banner: only then is PostHog's library loaded, from PostHog's own CDN, so a
 * visitor who never accepts never downloads it and no PostHog request is made.
 *
 * Replays mask every input and text node, query strings and fragments are
 * stripped from URLs, and custom events are short codes, never typed text.
 */
import { POSTHOG } from "./shared/site.ts";

export type EventProperties = Record<string, string | number | boolean>;

interface CapturedEvent {
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

/** The part of PostHog's browser API the app uses. */
interface PostHog {
  init(key: string, config: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  reset(): void;
  opt_out_capturing(): void;
  capture(event: string, properties?: EventProperties): void;
  logger?: {
    info(message: string, attributes?: EventProperties): void;
    error(message: string, attributes?: EventProperties): void;
  };
}

const SERVICE_NAME = "prune-web";
const URL_PROPERTY = /url|referrer|href/i;
const ABSOLUTE_URL = /^https?:\/\//;
const KEY_NAME = "VITE_POSTHOG_KEY";

export class Analytics {
  private started = false;
  private stopped = false;
  private posthog: PostHog | null = null;
  /** Calls made while the library loads, replayed once it is ready. */
  private readonly waiting: ((posthog: PostHog) => void)[] = [];
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

  private static beforeSend(event: CapturedEvent | null): CapturedEvent | null {
    if (!event) return event;
    Analytics.scrub(event.properties);
    Analytics.scrub(event.$set);
    Analytics.scrub(event.$set_once);
    return event;
  }

  /** Loads and starts PostHog once, after the visitor accepts optional analytics. */
  start(): boolean {
    if (this.started) return true;
    const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
    if (!key) {
      if (import.meta.env.DEV)
        throw new Error(
          `${KEY_NAME} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${KEY_NAME} is configured`,
        );
      return false;
    }
    this.started = true;
    const script = document.createElement("script");
    script.src = POSTHOG.library;
    script.async = true;
    script.addEventListener("load", () => this.ready(key), { once: true });
    // Blocked or offline: nothing will send, so stop holding calls for it.
    script.addEventListener("error", () => this.stop(), { once: true });
    document.head.append(script);
    return true;
  }

  /** Identifies the account once, including after a restored session. `email` is null for a guest. */
  identify(distinctId: string, email: string | null): void {
    if (this.identity?.distinctId === distinctId) return;
    const previous = this.identity;
    this.identity = { distinctId, email };
    // Until the library is ready, `ready` identifies whoever is current then.
    if (!this.posthog) return;
    if (previous) this.posthog.reset();
    this.posthog.identify(distinctId, email ? { email } : {});
  }

  /** Clears the identity after the account is erased. */
  forgetAccount(): void {
    this.identity = null;
    this.posthog?.reset();
  }

  /** Stops future collection in this tab and forgets the anonymous id. */
  stop(): void {
    this.identity = null;
    this.stopped = true;
    this.waiting.length = 0;
    if (!this.posthog) return;
    this.posthog.opt_out_capturing();
    this.posthog.reset();
  }

  /** Sends a structured PostHog log, only when the visitor has accepted analytics. */
  logError(message: string, attributes: EventProperties): void {
    this.use((posthog) => posthog.logger?.error(message, attributes));
  }

  /** Records a product event, only when the visitor has accepted analytics. */
  capture(event: string, properties: EventProperties = {}): void {
    this.use((posthog) => posthog.capture(event, properties));
  }

  private use(call: (posthog: PostHog) => void): void {
    if (!this.started || this.stopped) return;
    if (this.posthog) call(this.posthog);
    else this.waiting.push(call);
  }

  private ready(key: string): void {
    const posthog = (window as { posthog?: PostHog }).posthog;
    if (this.stopped || !posthog?.init) return;
    posthog.init(key, {
      api_host: POSTHOG.apiHost,
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
        // Replays show layout and movement only: no task text, account
        // details or anything typed.
        maskAllInputs: true,
        maskTextSelector: "*",
      },
      before_send: Analytics.beforeSend,
    });
    if (this.identity)
      posthog.identify(
        this.identity.distinctId,
        this.identity.email ? { email: this.identity.email } : {},
      );
    this.posthog = posthog;
    // Events and logs from while the library loaded, in order.
    this.waiting.splice(0).forEach((call) => call(posthog));
    posthog.logger?.info("optional analytics started", {
      event: "optional_analytics_started",
      analytics_consent: "accepted",
    });
  }
}

/** One per page: consent and identity are page-wide. */
export const analytics = new Analytics();
