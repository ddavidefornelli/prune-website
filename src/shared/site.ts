/** The canonical public address; links in emails use it. */
export const SITE = {
  name: "prune",
  domain: "prune.win",
  origin: "https://www.prune.win",
  url: "https://www.prune.win/",
} as const;

/** Shared with deployment policy generation to keep the production allowlist exact. */
export const PRODUCTION_ORIGINS: readonly string[] = [
  SITE.origin,
  `https://${SITE.domain}`,
];

/**
 * PostHog's EU cloud, for optional analytics after consent. The API host takes
 * events; the assets host serves the library, its remote config and the
 * lazily loaded recorder. The CSP allows exactly these two origins.
 */
export const POSTHOG = {
  apiHost: "https://eu.i.posthog.com",
  assetsHost: "https://eu-assets.i.posthog.com",
  /** PostHog's browser library, loaded only once the visitor accepts. */
  library: "https://eu-assets.i.posthog.com/static/array.js",
} as const;
