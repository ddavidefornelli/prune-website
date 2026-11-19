# Code structure

## Principles

- **Records stay plain, behaviour lives in classes.** Tasks, dashboards, reviews and the rest of `src/planner/types.ts` are JSON exchanged with the server, saved in browser storage and held in Solid stores, which only track plain objects. Each kind of record has a class that reads or changes it: `PlannerSnapshot` (a dashboard), `DayPlan` and `TaskTimer` (a day's tasks and one task's timer), `CompletionHistory` (finished-task counts), `Streak`, `CalendarMonth`, `CheckInSummary`, `ProfileStats`, `TaskTimingReport`.
- **Values with rules are value objects.** `CalendarDay` (date keys and their arithmetic), `Duration` (every way a span of time is written), `FocusTime` (a time of day, its calendar entries), `Estimate` (the dial's steps and range), `QuickEntry` (a typed title and estimate).
- **Services and reactive state are classes.** `PlanningClient`, `BrowserCloud`, `BoundedFetch`, `AccountQueue`, `LocalQueue`, `PushNotifications`, `AmbientSoundPlayer`, `Analytics`, `ErrorReporter`, `PrivacyNotice`, `FirstRun`, `HintBook`, `SuggestionCache`. `PlannerState`, `SessionState` and `WeeklyReviewState` hold Solid signals: create them inside a Solid owner (a component), and their timers and listeners end with it. Their accessors are fields, so they can be passed around unbound; their actions are methods.
- **Components stay functions.** Solid has no class components; they render and collect input and call the classes above.
- **No hardcoded values.** Limits, timings, thresholds, storage keys, routes, HTTP statuses and repeated copy live in constants:
  - `src/shared/time-constants.ts` (`TIME`, `CALENDAR`), `src/shared/storage-keys.ts` (every browser storage key; persisted names, so never renamed), `src/shared/api-routes.ts` (backend paths, HTTP limits and statuses), `src/shared/site.ts` (the public site).
  - `src/planner/constants.ts` (planner bounds, polling, media queries, queue protocol, hint and insight rules), `src/planner/messages.ts` (error and status copy shared by the transport, outbox and planner), `src/reviews/constants.ts` (check-in maths).
  - `server/constants.ts` (request limits, CORS, OpenAI, Brevo, Web Push and reminder settings).
  - Feature-local tables that only one class uses (confetti ranges, the tour's choreography, the email palette) are named constants at the top of that module.
  - Copy written once inside a component stays in the JSX: it is content, not configuration.
- **Code Node runs directly must stay erasable.** The unit tests and scripts run TypeScript through Node's type stripping, so `tsconfig.json` sets `erasableSyntaxOnly`: no constructor parameter properties, enums or namespaces.

## Responsibilities

- **`SessionState`** restores a saved session or completes a Google redirect once at startup, and ignores late responses after disposal. `Session.tsx` renders loading, sign-in or the planner; `App.tsx` only selects the unsubscribe page or the session, under an error boundary.
- **`PlanningClient`** coordinates authenticated access, typed RPC queries and task mutations. Queries are never mistaken for outbox writes.
- **`BrowserCloud` / `BoundedFetch`** separate Supabase authentication from bounded HTTP I/O. `CloudError` classifies failures; the outbox depends on its codes to tell a definite rejection from a retryable failure.
- **`AccountQueue`** supplies browser locks, account-scoped storage, online/storage listeners and queue-protocol negotiation. **`LocalQueue`** owns atomic snapshot/outbox persistence, serialized sends, acknowledgement validation, conflicts and retry backoff. **`PlannerSnapshot`** replays commands and moves the two-day window across midnight.
- **`CompletionHistory`** parses the completion history once; the streak card, insights and profile statistics all read it instead of each recomputing streaks and weekly totals.
- **Server:** `JsonEndpoint` is the shared base of the browser-facing functions (CORS, POST only, bearer session, bounded JSON body, safe errors); `WeeklyReviewEndpoint` and `TaskSuggestionEndpoint` extend it. `OpenAiChat` makes one structured completion and reports metadata-only observability for both AI features. `ReminderJob`, `UnsubscribeEndpoint`, `ReminderMessages`, `BrevoMailer`, `WebPushSender` and `ErrorLogRelay` cover reminders and the error relay. The Supabase function entry points only wire environment values and database calls into these classes.

## Removed

- The Mac app's leftovers: the `/download` page and route (and its rewrite, cache rule and hosted checks), the bundled `public/prune.dmg`, task resources, task priority, `canPlanTomorrow`, the Mac's manual review previews, and its `tauri://` CORS origins. Server responses may still carry `isPriority` and `resources: []`; the browser ignores them. Old saved outboxes can still hold a retired command (`prioritize_task`, `pause_task`, `add_task_link`, `remove_task_resource`): it replays without changing the local plan, and the server's acknowledgement settles it.
- The Clerk bridge test. Its two migrations stay, as applied database history.
- An unread "pause" hint, a duplicated streak/best-run/week calculation (three copies), four separate duration formatters, two copies of the CORS/auth/JSON request handling and of the OpenAI call, and duplicated weekday names, error messages and allowed-origin parsing.
- Earlier: guest mode, the onboarding survey, email-code sign-in on the website (since restored), retired CSS and assets.

## Intentionally retained

- All storage keys, storage versions, request identities, account isolation and atomic persistence rules. There is no storage reset or data migration.
- The dashboard's time-independent signature guard. Benchmarking showed that unconditionally reconciling unchanged history is slower.
- All database migrations and account deletion/retention semantics. See [the database review](database-review.md).
- The "session" unsubscribe kind, for links in start-time emails sent before focus times.

## Checks

`npm run check` type-checks (including tests, scripts and server), lints `src` and `server` and checks their formatting. Unit tests cover the domain classes, queue, transport contracts and server handlers; Solid lifecycle tests cover the reactive state classes; Playwright exercises the production artifact against local intercepted fixtures, not hosted accounts or paid services.
