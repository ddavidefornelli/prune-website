/**
 * Every browser storage key the app reads or writes. These are persisted
 * names: changing one silently forgets what visitors already saved, so a new
 * format gets a new version number instead.
 */
export const STORAGE_KEYS = {
  privacyAcknowledgement: "prune:privacy:acknowledgement",
  cookieChoice: "prune:cookies:v1",
  /** Supabase's saved session (a guest's or an account's) for one project. */
  auth: (projectUrl: string) => `prune:auth:${projectUrl}`,
  /** This browser's list, the changes not yet in the cloud, and whose it is. */
  list: "prune:list:v1",
} as const;

/**
 * What earlier versions kept in the browser: the day planner's snapshot and
 * outbox, tour, hints, visits, insights, suggestions and focus sound volume,
 * and the per-account lists of the first list build. Nothing reads them, so
 * they are removed on the next visit.
 */
export const RETIRED_STORAGE_PREFIXES = [
  "pro:planner:",
  "prune:tasks:",
  "prune:onboarding:",
  "prune:tour:",
  "prune:hint:",
  "prune:visits:",
  "prune:insights:",
  "prune:suggestions:",
  "prune:focus-sound-volume:",
] as const;

/** Window events the app dispatches to itself. */
export const APP_EVENTS = {
  openPrivacyPreferences: "prune:preferences:open",
} as const;

/** The value stored to remember that a one-time step is done. */
export const DONE_FLAG = "done";
