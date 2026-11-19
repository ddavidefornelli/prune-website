/**
 * Every browser storage key the app reads or writes. These are persisted
 * names: changing one silently forgets what visitors already saved, so a new
 * format gets a new version number instead.
 */
export const STORAGE_KEYS = {
  privacyAcknowledgement: "prune:privacy:acknowledgement",
  cookieChoice: "prune:cookies:v1",
  focusSoundVolume: "prune:focus-sound-volume:v1",
  /** Supabase's saved session for one project. */
  auth: (projectUrl: string) => `prune:auth:${projectUrl}`,
  /** The acknowledged snapshot and its outbox (the prefix predates "prune"). */
  plannerQueue: (version: number, accountKey: string) =>
    `pro:planner:v${version}:${accountKey}`,
  onboarding: (accountKey: string) => `prune:onboarding:v1:${accountKey}`,
  tour: (accountKey: string) => `prune:tour:v1:${accountKey}`,
  hint: (accountKey: string, hint: string) =>
    `prune:hint:v1:${accountKey}:${hint}`,
  visits: (accountKey: string) => `prune:visits:v1:${accountKey}`,
  insights: (accountKey: string) => `prune:insights:v1:${accountKey}`,
  suggestions: (accountKey: string, target: string) =>
    `prune:suggestions:v1:${accountKey}:${target}`,
} as const;

/** Window events the app dispatches to itself. */
export const APP_EVENTS = {
  openPrivacyPreferences: "prune:preferences:open",
} as const;

/** The value stored to remember that a one-time step is done. */
export const DONE_FLAG = "done";
