/** The canonical public address; links in emails and calendar entries use it. */
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
