/**
 * Error and status copy shared by the transport, the outbox and the planner.
 * Several layers can raise the same failure, so they share one wording.
 */
export const MESSAGES = {
  generic: "Something went wrong. Please try again.",
  sessionExpired: "Your session has expired. Please sign in again.",
  accountChanged: "The account changed. Reload before accessing planner data.",
  accountChangedAtStartup:
    "The account changed during startup. Please sign in again.",
  accountChangedAtSignOut:
    "The account changed while signing out. Reload before continuing.",
  accountDeleted:
    "This account has been marked for deletion and can no longer be used.",
  deletionUnconfirmed: "Account deletion was not confirmed. Please try again.",
  clientClosed: "The planner client is closed.",
  signInFirst: "Sign in and load your planner before making changes.",
  privacyRequired: "Accept the Terms & Privacy before continuing.",
  privacyNotSaved:
    "Could not save your terms acceptance. Allow browser storage and try again. No sign-in request was sent.",
  restoreFailed:
    "Could not restore your session. Sign in again when you are online. Your pending planner changes remain on this device.",
  noAccountReturned: "Sign-in did not return an account. Please try again.",
  emailAccountRequired: "Sign in with an email account to use prune.",

  // Sign-in
  signInUnreachable:
    "Couldn't reach sign-in. If you use an ad blocker, VPN, or a work or school network, try turning it off or switching networks, then try again.",
  signInRateLimited:
    "Too many sign-in attempts. Wait at least a minute before trying again.",
  signInUnavailable:
    "Sign-in services are temporarily unavailable. Please try later or contact support.",
  signInFailed:
    "Sign-in could not be completed. Check your email and code, or request a new code and try again.",
  signInIncomplete: "The sign-in response was incomplete. Please try again.",
  signInCancelled:
    "Sign-in was cancelled or could not be completed. Please try again.",
  signInOtherBrowser:
    "Sign-in could not be completed. Try again in the same browser where you started sign-in.",
  googleUnavailable:
    "Google sign-in isn't available right now. Please try again later.",
  googleNotStarted:
    "Google sign-in could not be started. Try again or use email instead.",
  signOutStorage: "Could not clear your browser session. Please try again.",

  // Planner requests
  unreachable:
    "Could not reach Supabase. Your pending changes remain on this device and will retry.",
  incompleteResponse:
    "The server returned an incomplete response. Your pending changes remain on this device.",
  serverFailed:
    "Supabase could not complete the request. Your pending changes remain on this device and will retry.",
  rateLimited: "Too many requests. Please try again later.",
  responseTooLarge: "The server response is too large. Please contact support.",
  unsupportedCommand: "Unsupported browser command.",

  // Weekly AI
  reviewRateLimited:
    "The review retry allowance has been reached. Please try later.",
  reviewWeeklyLimit: "Your free weekly review allowance has been used.",
  reviewRunning:
    "A review is already being generated. Please check again shortly.",
  reviewGlobalLimit:
    "The free AI allowance has been reached. Your planner is unaffected.",
  reviewOriginNotAllowed:
    "Weekly AI is not enabled for this website yet. The operator needs to add this domain to the function's ALLOWED_ORIGINS.",
  reviewUnavailable:
    "Weekly AI is unavailable or its allowance has been reached. Your planner and saved reviews are unaffected.",
  reviewLoadFailed:
    "Could not load your weekly review. Tasks and timers still work normally.",
  aiSettingsNotSaved: "Could not save AI settings. Please try again.",
  checkInPlanNotSaved: "Could not save your plan. Please try again.",

  // Outbox
  syncFailed: "Could not sync. Your changes remain on this device.",
  queueUnreadable:
    "The local queue cannot be read. Do not clear app data; recover your pending changes first.",
  queueClosed: "The local queue is closed.",
  queueBlocked: "Resolve the sync conflict before making more changes.",
  queueNeedsSnapshot:
    "Connect once to load your planner before saving local changes.",
  queueChanged: "Local queue changed during sync.",
  queueDiscardRefused:
    "Only rejected changes can be discarded. Retry syncing first.",
  incompleteAcknowledgement:
    "The server returned an incomplete acknowledgement. Your changes remain on this device; retry syncing.",
  taskUnavailable:
    "This task is not available in the local planner. Sync before changing it.",
  unsupportedProtocol:
    "The server does not support this queue version. Apply Supabase migration 20261017000300_local_queue.sql. Your changes remain on this device; no queued writes were sent.",
  webLocksRequired:
    "Safe local saving requires HTTPS and a browser with Web Locks support. Update your browser before using prune.",
  allSynced: "All changes synced",
  syncStopped: (reason: string) =>
    `Sync stopped: ${reason} Pending changes are kept on this device.`,
  waitingToSync: (error: string, count: number) =>
    `${error} ${count} change(s) waiting to sync.`,
  syncing: (count: number) =>
    `${count} change(s) saved on this device · syncing…`,

  // Account actions
  confirmDelete:
    "Delete your account? You will lose access immediately. Your account and data will be marked for deletion and kept for 30 days before manual removal. Unsynced changes will not be uploaded. This cannot be undone in the app.",
  confirmSignOutPending:
    "Some changes have not synced. They will stay on this device for this account, but will not sync while signed out. Sign out anyway?",
  confirmDiscard:
    "Discard ALL pending changes on this device, including changes depending on the rejected action? Synced changes will be kept.",

  // Configuration
  configMissing:
    "Web signup is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild.",
  configBadUrl: "VITE_SUPABASE_URL must be your HTTPS Supabase project URL.",
  configUrlShape:
    "Use the HTTPS Supabase project URL without a path, query or credentials.",
  configSecretKey:
    "Use a Supabase publishable or anon key, never a service-role or secret key.",
} as const;
