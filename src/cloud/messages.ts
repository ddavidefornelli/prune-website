/**
 * Copy shared by the transport and the list. Most of it is never shown: the
 * list on the device is the one that counts, and a sync that fails is retried
 * quietly. Only answers to something the person did (Delete everything, a full
 * list) reach the screen.
 */
export const MESSAGES = {
  generic: "Something went wrong. Please try again.",
  sessionExpired: "This browser's session has ended.",
  accountChanged: "This browser now uses another account.",
  accountDeleted: "This account was deleted.",
  deletionUnconfirmed: "Deleting was not confirmed. Please try again.",
  clientClosed: "The account client is closed.",
  privacyRequired: "Accept the Terms & Privacy before continuing.",
  privacyNotSaved:
    "Could not save your terms acceptance. Allow browser storage and try again.",
  guestUnavailable: "A guest id could not be created right now.",
  signOutStorage: "Could not clear this browser's session.",

  // Requests
  unreachable: "Could not reach prune.",
  incompleteResponse: "The server returned an incomplete response.",
  serverFailed: "prune could not save right now.",
  rateLimited: "Too many requests. Please try again later.",
  responseTooLarge: "The server response is too large.",
  unsupportedCommand: "Unsupported browser command.",

  // The list
  listFull: "Your list is full. Delete some tasks to add more.",
  confirmErase:
    "Delete everything? All your tasks are erased, on this device and in the cloud. This can't be undone.",
  eraseFailed:
    "Couldn't delete right now. Check your connection and try again.",

  // Configuration
  configMissing:
    "prune is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild.",
  configBadUrl: "VITE_SUPABASE_URL must be your HTTPS Supabase project URL.",
  configUrlShape:
    "Use the HTTPS Supabase project URL without a path, query or credentials.",
  configSecretKey:
    "Use a Supabase publishable or anon key, never a service-role or secret key.",
} as const;
