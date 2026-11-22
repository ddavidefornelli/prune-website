# Code structure

## Principles

- **Records stay plain, behaviour lives in classes.** Tasks and the saved list (`src/tasks/types.ts`) and the account records (`src/cloud/types.ts`) are JSON exchanged with the server, saved in browser storage and held in Solid signals. Each kind of record has a class that reads or changes it: `TaskList` (the list and its unsaved changes, immutable), `TaskStorage` (one account's list in localStorage), `PrivacyNotice`.
- **Services and reactive state are classes.** `AccountClient`, `BrowserCloud`, `BoundedFetch`, `ListSync`, `Analytics`, `ErrorReporter`. `ListState` holds Solid signals: create them inside a Solid owner (a component), and their timers and listeners end with it. Their accessors are fields, so they can be passed around unbound; their actions are methods.
- **Components stay functions.** Solid has no class components; they render and collect input and call the classes above.
- **No hardcoded values.** Limits, timings, storage keys, routes and HTTP statuses live in constants:
  - `src/shared/time-constants.ts`, `src/shared/storage-keys.ts` (every browser storage key; persisted names, so never renamed), `src/shared/api-routes.ts` (backend paths, HTTP limits and statuses), `src/shared/site.ts`.
  - `src/cloud/constants.ts` (media queries), `src/cloud/messages.ts` (error and status copy shared by the transport, sign-in and the list), `src/tasks/constants.ts` (list limits mirroring `planner_list`, sync and timing).
  - `server/constants.ts` (request limits, CORS, OpenAI, Brevo, Web Push and reminder settings); `server/planner-contract.ts` (the retired day planner's types and bounds, for its still-deployed functions).
  - Copy written once inside a component stays in the JSX: it is content, not configuration.
- **Code Node runs directly must stay erasable.** The unit tests and scripts run TypeScript through Node's type stripping, so `tsconfig.json` sets `erasableSyntaxOnly`: no constructor parameter properties, enums or namespaces.

## Responsibilities

- **`App.tsx`** selects the unsubscribe page or the list (`TaskApp`), under an error boundary. There is no session screen: the list opens at once from the device.
- **`AccountClient`** knows whether this browser accepted the terms, finds or makes its account (the saved session, or a new guest only when there is something to sync), carries list syncs, and runs Delete everything.
- **`BrowserCloud` / `BoundedFetch`** separate Supabase authentication from bounded HTTP I/O. `CloudError` classifies failures; the list's sync depends on its codes to tell a definite rejection from a retryable failure.
- **`TaskList`** applies every change with a later time than the one before, batches unsaved changes, merges the cloud's answer without losing changes made meanwhile, and `adopt`s a new owner by marking every task to upload. **`TaskStorage`** keeps it in localStorage for all tabs. **`ListSync`** finds the owner, decides when to sync and how to back off, and never surfaces a failure. **`ListState`** ties them to the screen.
- **Server:** `JsonEndpoint` is the shared base of the browser-facing functions (CORS, POST only, bearer session, bounded JSON body, safe errors). `ReminderJob`, `UnsubscribeEndpoint`, `ReminderMessages`, `BrevoMailer`, `WebPushSender` and `ErrorLogRelay` cover reminders and the error relay. `WeeklyReviewEndpoint`, `TaskSuggestionEndpoint` and `OpenAiChat` serve the retired day planner and are no longer called by the website.

## Removed

- **The day planner (2026-11-22).** prune became one list. Gone from the website: Today/Tomorrow and the five-task day, estimates and the estimate dial, the focus timer, stop reasons and focus sounds, Overview with the activity calendar and month stats, the weekly AI check-in and task suggestions, streaks and the streak party, insight drops, hints and keyboard-shortcut sheet, the onboarding tour, the first-task and focus-time questions, calendar entries, browser notifications, Profile and its statistics, the product preview, the plum logo component, the durable outbox (`LocalQueue`, `AccountQueue`, `PlannerSnapshot`) and its Web Locks requirement. Their tests went with them. The old browser keys are removed on the next visit (`RETIRED_STORAGE_PREFIXES`). The backend pieces they used stay deployed; see "Retired with the day planner" in the development notes.
- **Sign-up and sign-in (2026-11-22, the same day).** The landing and sign-in pages, Google and emailed-code sign-in, `SessionState`, the account sheet (email settings, Sign out, Delete account) and the sync status line. Everyone starts as a guest; Delete everything replaced the account actions. The `--require-invite-only` production check went too: guests are public sign-ups.

- The Mac app's leftovers: the `/download` page and route (and its rewrite, cache rule and hosted checks), the bundled `public/prune.dmg`, task resources, task priority, `canPlanTomorrow`, the Mac's manual review previews, and its `tauri://` CORS origins.
- The Clerk bridge test. Its two migrations stay, as applied database history.
- An unread "pause" hint, a duplicated streak/best-run/week calculation (three copies), four separate duration formatters, two copies of the CORS/auth/JSON request handling and of the OpenAI call, and duplicated weekday names, error messages and allowed-origin parsing.
- Earlier: guest mode, the onboarding survey, email-code sign-in on the website (since restored), retired CSS and assets.

## Intentionally retained

- All storage keys still in use (`prune:auth:…`, `prune:privacy:acknowledgement`, `prune:cookies:v1`); the list's key is new (`prune:tasks:v1:<account>`).
- All database migrations and their tables, including the day planner's: nothing in the database was dropped. Account deletion keeps its 30-day retention, now with sign-in restoring the account. See [the database review](database-review.md).
- The "session" and "daily" unsubscribe kinds, for links in emails already sent.

## Checks

`npm run check` type-checks (including tests, scripts and server), lints `src` and `server` and checks their formatting. Unit tests cover the list classes, transport contracts, SQL migrations and server handlers; Solid lifecycle tests cover the reactive state classes; Playwright exercises the production artifact against local intercepted fixtures, not hosted accounts or paid services.
