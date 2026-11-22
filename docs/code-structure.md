# Code structure

## Principles

- **Records stay plain, behaviour lives in classes.** Tasks and the saved list (`src/tasks/types.ts`) and the account records (`src/cloud/types.ts`) are JSON exchanged with the server, saved in browser storage and held in Solid signals. Each kind of record has a class that reads or changes it: `TaskList` (the list and its unsaved changes, immutable), `TaskStorage` (the list in localStorage), `PrivacyNotice`, `SupabaseAuth` (the session).
- **Services and reactive state are classes.** `AccountClient`, `BrowserCloud`, `SupabaseAuth`, `BoundedFetch`, `ListSync`, `Analytics`, `ErrorReporter`. `ListState` holds Solid signals: create it inside a Solid owner (a component), and its timers and listeners end with it. Accessors are fields, so they can be passed around unbound; actions are methods.
- **Components stay functions.** Solid has no class components; they render, collect input and call the classes above.
- **No hardcoded values.** Limits, timings, storage keys, routes and HTTP statuses live in constants: `src/shared/` (`time-constants.ts`, `storage-keys.ts` — persisted names, never renamed — `api-routes.ts`, `site.ts`), `src/cloud/messages.ts`, `src/tasks/constants.ts` (mirrors `planner_list`'s limits), `server/constants.ts`. Copy written once inside a component stays in the JSX.
- **Small and fast.** No runtime dependency beyond Solid and Vercel Analytics (`@anthropic-ai/sdk` is a dev dependency, for the Edge Function's types); Auth is plain HTTP; PostHog loads from its CDN only after consent. One self-contained entry script.
- **Code Node runs directly stays erasable.** Tests and scripts run TypeScript through Node's type stripping, so `tsconfig.json` sets `erasableSyntaxOnly`: no constructor parameter properties, enums or namespaces.

## Layout

```text
src/
  index.tsx                 The single render root; Vercel page views without query strings
  App.tsx                   Error boundary; the unsubscribe page or the list
  analytics.ts              Analytics: PostHog, loaded and started only after consent
  cloud/
    auth.ts                 SupabaseAuth: the saved session, refresh, check, new guest, sign-out
    browser.ts              BrowserCloud: whose list this is, RPC calls, other tabs' sign-ins
    account.ts              AccountClient: terms acceptance, the account, list syncs, Delete everything
    api-fetch.ts            BoundedFetch: deadlines, cancellation, response size, no redirects
    cloud-error.ts          CloudError: the failure codes the sync relies on
    config.ts               PublicConfig: the public Supabase URL and key, validated
    error-log.ts            ErrorReporter: connection failures to /api/error-log
    privacy-state.ts        PrivacyNotice: the versioned terms acknowledgement
    messages.ts, types.ts
  tasks/
    TaskApp.tsx             The screen: header, list, Done, Undo, menu
    components/             Add field, task row, Done, Undo bar, menu sheet, helper sheet and answer text
    task-list.ts            TaskList
    task-storage.ts         TaskStorage, and the browser's localStorage
    list-sync.ts            ListSync: when and how changes go to planner_list
    list-state.ts           ListState: the reactive list and its actions
    helper-state.ts         HelperState: "Do it for me", its answers and signing in
    constants.ts, types.ts
  components/               Native dialog, privacy policy, cookie banner, unsubscribe page
  shared/                   Storage keys, routes, site and time constants, the helper contract
  styles/                   base.css (tokens, light and dark), app.css, preferences.css
server/                     Code the Edge Functions and the error relay run (Deno and Vercel Edge)
  reminders/                Come-back email, Brevo, Web Push, the reminder job and unsubscribe
  helper/                   "Do it for me": HelperEndpoint (the task-helper function) and HelperModel (Claude)
  error-log.ts, error-log-entry.ts, constants.ts
supabase/                   Migrations, Edge Function entries, config, read-only security audit
scripts/                    Build, CSP, Vercel packaging, hosted checks, icons, test email
tests/                      Unit, SQL (PGlite), reactivity and Playwright suites
```

## Responsibilities

- **`App.tsx`** picks the unsubscribe page or the list (`TaskApp`), under an error boundary. There is no session screen: the list opens at once from the device.
- **`AccountClient`** knows whether this browser accepted the terms, finds or makes its account (only when there is something to sync), carries list syncs and runs Delete everything. **`BrowserCloud`** turns that into Auth and RPC requests and reloads the page when another tab signs in as someone else. **`SupabaseAuth`** keeps the session in the shape supabase-js saved it, refreshes it under a cross-tab lock, and ends it only when the server refuses it.
- **`TaskList`** applies every change with a later time than the one before, batches unsaved changes, merges the cloud's answer without losing changes made meanwhile, and `adopt`s a new owner by marking every task to upload. **`TaskStorage`** keeps it in localStorage for all tabs. **`ListSync`** finds the owner, decides when to sync and how to back off, and never surfaces a failure. **`ListState`** ties them to the screen.
- **`HelperState`** sorts open tasks in quiet batches, runs the questions, starts answers and checks on them, and signs a guest in (emailed code or Google) when its free answers are used, carrying the waiting task across the reload. **`HelperEndpoint`** checks every request and the caller's token, counts limits, and writes answers after the response with **`HelperModel`**.
- **Server:** `HelperEndpoint`, `HelperModel`, `ReminderJob`, `UnsubscribeEndpoint`, `ReminderMessages`, `BrevoMailer`, `WebPushSender` and `ErrorLogRelay`.

## Removed

- **The day planner (22 November 2026).** Today/Tomorrow and the five-task day, estimates, the focus timer and its sounds, stop reasons, Overview and month stats, the weekly AI check-in and task suggestions, streaks and the party, hints, the onboarding tour, focus time, notifications, Profile, the outbox; then its AI Edge Functions and server code (`weekly-review`, `task-suggestions`, OpenAI, posthog-node), its dashboard and reminder scripts, its tests and screenshots, and finally its tables and functions (see [the database](database.md)). Old browser keys are removed on the next visit (`RETIRED_STORAGE_PREFIXES`).
- **Sign-up and sign-in (the same day).** The landing and sign-in pages, the account sheet. Everyone starts as a guest; Delete everything replaced the account actions. Google and emailed-code sign-in came back the same day, only inside "Do it for me", once a guest's free answers are used.
- **The Supabase SDK and the bundled PostHog SDK**, replaced by `SupabaseAuth` and a consent-time loader: the script went from 702 KB to 87 KB.
- Earlier: the Mac app and its leftovers, the Clerk bridge, guest mode and the onboarding survey.

## Kept on purpose

- Storage keys in use (`prune:auth:<project url>`, `prune:privacy:acknowledgement`, `prune:cookies:v1`, `prune:list:v1`).
- Every applied migration, as history.
- The "daily" and "session" unsubscribe kinds and `public/sw.js`, for emails and notification permissions from the day planner.
