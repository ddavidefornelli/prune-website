/** Every group space's list starts with this (see STORAGE_KEYS.spaceList). */
export const SPACE_LIST_PREFIX = "prune:space:v1:";

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
  /** This browser's Personal list, the changes not yet in the cloud, and whose it is. */
  list: "prune:list:v1",
  /** A group space's list, in the same shape as the Personal one. */
  spaceList: (spaceId: string) => `${SPACE_LIST_PREFIX}${spaceId}`,
  /** The spaces this account is in, and which one is open. */
  spaces: "prune:spaces:v1",
  /** Which tasks the helper can do, and its answers, for this browser's account. */
  helper: "prune:helper:v1",
  /** A shared list's link token, waiting to be joined (sessionStorage). */
  shareJoin: "prune:share:join",
  /** The Share sheet, to open again after signing in (sessionStorage). */
  shareResume: "prune:share:resume",
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
