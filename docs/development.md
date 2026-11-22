# prune web app: development and operations

The easiest to-do list: one list, nothing else, and nothing to sign up for. `/` opens straight onto the list. Type a task and press Enter; tick it off; tap its words to change them or delete it. Done tasks fold under **Done**. The list lives in the browser first and opens at once, with or without a network. After the first task, the browser gets a **guest id** (a Supabase anonymous user) and the list is copied to Supabase under it, quietly: a missing or unreachable backend never shows an error.

Until 22 November 2026 prune was a day planner (five tasks a day, a focus timer, AI check-ins, streaks, reminders at a focus time, an onboarding tour). None of it is left in the website; `supabase/migrations/20261125000100_retire_day_planner.sql` removes it from the database (see [Retire the day planner](#retire-the-day-planner)).

**Launch status:** see [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md). Passing local tests is not production approval.

**SolidJS + TypeScript**, one render root, no UI libraries. The browser talks to Supabase over plain HTTP: Auth for the guest id, and two RPCs, `planner_list` for the list and `planner_call` for deleting an account from before guests. See [the code structure](code-structure.md) and [the database](database.md).

## Configure and run

Requires Node.js 22.12+.

```sh
npm ci
cp .env.example .env.local
# Fill in the two public values from the prune Supabase project.
npm run dev
```

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
VITE_POSTHOG_KEY=phc_…   # optional
```

These are public browser settings, embedded **at build time**. A `sb_publishable_…` key or a legacy anon key is accepted; a service-role or `sb_secret_…` key is refused. Partial or unsafe configuration fails Vite startup and build, and production builds fail when it is missing. An unconfigured development checkout shows a setup error. Do not put real keys into tests.

## How it works

- **Add:** the field at the top; Enter adds the task on top of the list and keeps the cursor there. On a laptop the page opens ready to type; on a phone it waits for a tap so the keyboard does not cover the list.
- **Tick:** the circle. A ticked task stays in place for a moment (`LIST_TIMING.settleMs`), then moves under **Done**, which is folded away; open it to untick tasks or **Clear** them all.
- **Edit and delete:** tap a task's words to edit them (Enter saves, Escape cancels, emptying them deletes). × deletes; it shows on hover, on focus and while editing. Every delete and Clear offers **Undo** for a few seconds.
- **Menu:** ••• opens Terms & Privacy, Cookie settings and **Delete everything** (and, for an account from before guests, its email).
- **Sync:** every change is saved on the device at once and sent to `planner_list` shortly after (a burst goes out together), when the page is shown or back online, and every 30 seconds while visible. Failures retry with growing pauses and are never shown: the device's copy is the one that counts. Each task carries the time of its last edit and the newest edit wins, so retries are harmless. Tabs share one copy in localStorage (`prune:list:v1`, which also records the account it last synced with) and see each other's edits.
- **Terms:** adding a task records acceptance of the terms and privacy notice on that browser (`PrivacyNotice`); nothing is sent anywhere before it. When `PRIVACY_POLICY_VERSION` changes, the list stays local until the next task.
- **Guest ids:** `BrowserCloud.identity` uses the saved session (checked with Auth, refreshed when about to expire) or, when there is none and the list has something to keep, an anonymous sign-up. A guest the server no longer knows, a session the server ended, or a saved session that disagrees with its own token is replaced by a new guest, and the whole list is uploaded to it (`TaskList.adopt`), so nothing is lost. Accounts from before guests (Google or an emailed code) keep syncing in browsers where they are signed in; there is no new sign-in.
- **Phone-first and accessible:** 44px targets, light and dark themes from the system, reduced motion respected, every control named for screen readers.

Limits: the session's tokens are in JavaScript-readable localStorage (`prune:auth:<project url>`, the same entry supabase-js used), never inside the saved list. A guest's list belongs to its browser: clearing site data loses it, and with it the guest id. Delete everything erases the list in the cloud and here, forgets the guest id and reloads; the next task starts a new guest.

## Speed

A visit downloads one script (87 KB, 31 KB gzipped: Solid, the app and the bundled privacy notice) and one stylesheet (12 KB), then renders the list from localStorage before any network request. Scripts and styles are named by their content hash and cached for a year (`IMMUTABLE_ASSETS`); only the 3 KB HTML is fetched again. Nothing else loads until the visitor accepts optional cookies: PostHog's library then comes from PostHog's own CDN.

Keep it that way: Auth is a small HTTP client (`src/cloud/auth.ts`), not the Supabase SDK; PostHog is never bundled; there is one self-contained entry script (the CSP requires it). Measure the bundle (`npx vite build`) before adding a dependency.

## Backend

The browser calls exactly these paths (`SUPABASE_ROUTES`; the CSP allows nothing else):

```text
/auth/v1/signup                a new guest (anonymous sign-up)
/auth/v1/user, /token, /logout checking, refreshing and forgetting the session
/auth/v1/otp, /verify          signing in with an emailed six-digit code
/auth/v1/authorize             Google sign-in (a page load; /token?grant_type=pkce finishes it)
/rest/v1/rpc/planner_list      the list: 'sync', and 'erase' for Delete everything
/rest/v1/rpc/planner_call      'delete_account', for accounts from before guests
/functions/v1/email-unsubscribe
/functions/v1/task-helper      "Do it for me"
```

The shared backend's base schema came from `../pro/supabase`; this repository's migrations are applied on top of it, in order. Nothing here applies migrations or changes the hosted project by itself.

### Deploy the list

1. In the Supabase dashboard, **Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins**, and keep **Allow new users to sign up** on (a guest is a sign-up). Supabase limits anonymous sign-ins per IP address (30 an hour by default); CAPTCHA is not implemented, so do not require one.
2. Apply `20261124000100_task_list.sql`, then `20261124000200_comeback_reminders_only.sql` (SQL editor, or `supabase db push` from the linked project).
3. Deploy this website. Until steps 1 and 2 are done, the list still works in each browser; it just doesn't reach the cloud, and nothing says so.

### Deploy "Do it for me"

Open tasks are sorted quietly (`classify`) as they are added; a task that fits (something to write, a list, a plan, research) shows **Do it for me** while it is being edited. Tapping it asks up to three this-or-that questions (`choices`), then `start` saves a working run and returns at once while the model writes the answer in the background (`EdgeRuntime.waitUntil`); the browser checks back every 3 seconds (`get`). The answer shows under its task; its sheet offers changes (`refine`, five at most), Copy, Keep and Discard. A guest gets three answers, then signs in with Google or an emailed code; the page reloads as that account, the list is copied to it, and the waiting task starts. Code: `server/helper/` (endpoint and model calls), `src/tasks/helper-state.ts`, `src/tasks/components/HelperSheet.tsx`; limits in `src/shared/helper-contract.ts` and `planner_helper_claim`.

1. In the Supabase dashboard, **Authentication**:
   - **Sign In / Providers → Email**: on, with **Confirm email** on. In **Emails → Magic Link**, the template must show the code: `{{ .Token }}` (prune asks for the six digits, not a link).
   - **Sign In / Providers → Google**: on, with the Google Cloud OAuth client. Google's authorised redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`.
   - **URL Configuration → Redirect URLs**: add `https://www.prune.win/` (and any preview origin you test from). Google sign-in comes back to the site's root.
2. Apply `20261126000100_task_helper.sql`.
3. Create an OpenRouter API key (openrouter.ai → Keys) with a monthly credit limit, and in OpenRouter's privacy settings allow only providers that do not train on prompts. `npx supabase secrets set HELPER_API_KEY=…` (`ALLOWED_ORIGINS` is shared with the unsubscribe function), then `npx supabase functions deploy task-helper` (`supabase/config.toml` turns JWT verification off: it checks each caller's token itself, and CORS preflights carry none).
4. Deploy this website. Before step 3, tasks get no button (sorting fails quietly) and Delete everything fails, so deploy the function first.

The model is DeepSeek V4.1 Flash through OpenRouter (`HELPER.defaultModel` and `HELPER.defaultUrl` in `server/constants.ts`). Every request carries OpenRouter provider routing that skips DeepSeek's and Moonshot's own services (China) and providers that keep prompts for training (`HELPER.openRouterProvider`). Any host with OpenAI's chat completions format works: set `HELPER_API_URL` (the full `/chat/completions` URL) and `HELPER_MODEL`, and update the privacy notice's recipients. There is no web search: answers say what to check instead of inventing prices, hours or addresses, and tasks that need live information are not offered the button. A guest's three answers, the daily 30 answers and refines and the daily 300 sorting and question calls are counted by `planner_helper_claim`.

### Retire the day planner

`20261125000100_retire_day_planner.sql` deletes everything only the day planner used: ten tables (`planner_tasks`, `planner_stops`, `planner_reviews`, `planner_receipts`, `planner_review_tasks`, `planner_history`, `planner_suggestion_usage`, `ai_controls`, `ai_usage`, `ai_review_requests`), every function that read them, scheduling and history, and their columns in `planner_accounts` and `planner_email_reminders`. First it copies each account's unfinished planner tasks for today and later into its list, for accounts that have not opened the list yet. It slims `planner_call` to `delete_account`, drops `planner_list`'s one-time copy and `'status'`, unschedules any job that used the retired tables, and moves the reminder job back to hourly. It uses no `CASCADE`: anything it does not know still depending on a retired table makes it fail, changing nothing. See [the database](database.md).

1. Wait until the list website has been live for a day: an open day planner tab would only get errors.
2. Deploy the `daily-reminders` function from this commit: `npx supabase functions deploy daily-reminders email-unsubscribe`.
3. **Back up the database** (Dashboard → Database → Backups, or `pg_dump`). The migration cannot be undone.
4. Apply `20261125000100_retire_day_planner.sql`. Its notice lists the functions it dropped.
5. Undeploy the retired functions and delete the secrets only they used: `npx supabase functions delete weekly-review`, `npx supabase functions delete task-suggestions`, then `npx supabase secrets unset OPENAI_API_KEY VITE_POSTHOG_KEY VITE_POSTHOG_HOST`. Keep `ALLOWED_ORIGINS`: the unsubscribe function reads it.
6. Run `supabase/security-audit.sql` and `npm run check:production`.

### Come-back emails

Accounts from before guests that have been away 7 days get one email ("Your list is waiting"), at most once a week and four in a row, in their morning window (three hours from 09:00, or from the focus time chosen in the day planner). A visit resets the count. Browsers that turned notifications on in the day planner get the same nudge as a push notification (`public/sw.js` stays for them; the website no longer asks). Guests have no email and get nothing. Every email's link turns it off without signing in; links from the day planner's emails (`kind=daily`, `kind=session`) still answer.

`pg_cron` calls the `daily-reminders` Edge Function at minute 5 of every hour. `planner_claim_reminders` picks who is due and marks them in the same statement, so overlapping or retried runs never email anyone twice. A claim is released for retry only when Brevo may accept it later (network error, 429, 5xx). If Brevo refuses the account itself (401, 402, 403: a wrong key, an IP blocked by **Authorised IPs**, no credits), the run stops, releases every unsent claim and answers 502. Supabase functions have no fixed outbound IP, so leave Authorised IPs off for this key.

Setup, once (already done for production):

1. Apply `20261112000200_email_reminders.sql` and `20261112000300_email_reminders_cron.sql`.
2. In Brevo, create an **API key** (SMTP & API → API Keys) and switch off open/click tracking for transactional email.
3. `npx supabase secrets set BREVO_API_KEY=… REMINDER_FROM_EMAIL=… REMINDER_CRON_SECRET=…` (a verified sender; any long random secret). Optional: `SITE_URL`, `REMINDER_BATCH_LIMIT` (default 100; Brevo's free plan allows 300 a day). `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` keep push working: never replace the key pair, or every subscription stops.
4. `npx supabase functions deploy daily-reminders email-unsubscribe` (`supabase/config.toml` turns JWT verification off for both; each checks its own secret or token).
5. Create two Vault secrets for the cron job: `reminders_function_url` (`https://<project-ref>.supabase.co/functions/v1/daily-reminders`) and `reminders_cron_secret` (the same value as `REMINDER_CRON_SECRET`).

`npm run email:test` sends a sample through Brevo to `REMINDER_TO` (from `.env.reminders.local`). By hand: `curl -X POST -H "Authorization: Bearer $REMINDER_CRON_SECRET" https://<project-ref>.supabase.co/functions/v1/daily-reminders` returns `{"sent":…,"retry":…,"rejected":…,"released":…,"pushed":…}`.

### Delete everything and account deletion

**Delete everything** erases the list with `planner_list('erase')`, forgets the session and the device's copy, and reloads. A browser that never synced just clears its copy. For an account from before guests it also calls `planner_call('delete_account')`, which marks `planner_accounts."isDeleted"` and `deleted_at`; other browsers signed in to it get `PT403` on their next sync and clear their copy, quietly. A session that signed in after the deletion restores the account (`amr` timestamps, else `iat`).

After at least 30 days, list accounts ready for manual removal in the SQL editor, then delete those **Auth users** with Supabase's administrative tools (their rows go with them, `on delete cascade`):

```sql
select user_id, deleted_at
from public.planner_accounts
where "isDeleted" and deleted_at <= now() - interval '30 days'
order by deleted_at;
```

`PRIVACY.md` says unused guest ids may be removed after 12 months. Before public release, schedule that clean-up, for example (review it first; it deletes Auth users and, by cascade, their lists):

```sql
delete from auth.users
where is_anonymous and coalesce(last_sign_in_at, created_at) < now() - interval '12 months';
```

## Build and deploy

```sh
npm run build
npm run preview
```

On Vercel, set the two `VITE_SUPABASE_*` variables (and optionally `VITE_POSTHOG_KEY`) for the deployment environments. `vercel.json` selects the **Other** framework and `npm run build:vercel`, which removes stale `.vercel/output/`, builds `dist/`, and packages the exact files, generated HTTP headers and the `/api/error-log` Edge Function into `.vercel/output/` ([Build Output API](https://vercel.com/docs/build-output-api)). It then runs the website security assertions against the packaged routes and the final JavaScript and CSS bytes; any failure removes the deployable output. Clear old dashboard Build Command/Output Directory overrides; never publish `dist/` alone (it drops the HTTP security headers). `/login` and `/login/` are rewritten to the app. CI runs this with fixture configuration: **never deploy CI's fixture build or `.playwright-dist/`**.

On another static host, publish `dist/`, install the headers from `dist/security-headers.json` as real HTTP response headers, serve HTML with `Cache-Control: no-store` and `/assets/*` with `public, max-age=31536000, immutable`, and configure the `/login` fallback. Deploy HTML, assets and headers atomically; never let a CDN rewrite JavaScript or CSS after integrity hashes are generated.

A production release with the Vercel CLI (select the existing project; stop at any failed step):

```sh
npx vercel link &&
  npx vercel pull --yes --environment=production &&
  npx vercel build --prod &&
  npm run check:deployment &&
  npx vercel deploy --prebuilt --prod &&
  npm run check:production -- --url https://www.prune.win --website-only
```

Enable Web Analytics in the Vercel project (leave Speed Insights off). The last command must pass on `/`, `/login`, `/login/` and `/index.html`.

### Content Security Policy

The policy is delivered as an HTTP header, **hash-locked and generated from the final build** (`scripts/csp-plugin.ts`, `scripts/security-policy.ts`):

- `default-src 'none'`. Scripts are allowed by the SHA-384 hash of the emitted bytes, with matching Subresource Integrity on the entry script. The only other script sources are Vercel Web Analytics (`/_vercel/insights/script.js` on the two production origins) and PostHog's assets host, both trusted without SRI, the second only used after consent. There is no `'self'` or `strict-dynamic`; a newly injected same-origin script is blocked.
- Stylesheets are same-origin with integrity; inline styles and style attributes, data images, fonts, media, plugins, frames and workers are denied (the service worker's exact path excepted). Property-level CSSOM updates (the task editor grows with its text this way) still work.
- Inline scripts, event handlers, `eval()`, base-URL overrides, framing and **all native form submissions** are blocked; forms use prevented submit events.
- Connections go only to the exact Auth and RPC paths above on the configured backend, the error relay and Vercel Analytics on the production origins, and PostHog's two EU hosts. CSP paths are not an authorization boundary: the transport also rejects redirects, and Auth/RLS on the backend remain mandatory.
- Builds fail on inline executable content, ambiguous asset attributes, missing assets, known marketing trackers (`scripts/tracking-policy.ts`) or code splitting. Adding an integration needs a policy review, never `*`, `unsafe-inline` or `unsafe-eval`.

`npm run preview` serves the built artifact's headers (omitting `upgrade-insecure-requests` on HTTP loopback for WebKit). `npm run dev` does not enforce CSP: Vite's HMR needs injected styles and a WebSocket. Limits: hash-approved JavaScript, including dependencies, can still read browser tokens and use the permitted endpoints, and a compromised build or hosting account can replace code and policy together. Trusted Types are not enforced (Solid's templates use HTML sinks).

## Privacy

`PRIVACY.md` holds the terms and the privacy notice; the menu's Terms & Privacy renders it as text. Bump `PRIVACY_POLICY_VERSION` (`src/cloud/privacy-state.ts`) whenever the notice gains new processing; every browser then accepts it again with its next task. **It is still a Draft** and needs operator and legal review before public release.

## Tests

```sh
npx playwright install chromium webkit
npm test            # or: npm run test:unit, npm run test:e2e
```

- Unit (`tests/*.test.mjs`): `TaskList` and `TaskStorage`; the Auth client (refresh, ended sessions, headers, sessions saved by supabase-js); public-key validation, privacy records and error classification; reminder emails, Brevo, the reminder job, unsubscribe and Web Push; the error relay; the CSP, packaging and hosted checker.
- SQL, in PGlite: `tests/helpers/backend-db.mjs` stubs the shared base schema and applies **every** migration in order (all but the two pg_cron ones), so tests run against the schema production ends up with: the list (`task-list-sql`), come-back emails (`comeback-reminders`), the error log, and the retirement itself (`retire-day-planner`: what is copied, what is left, refusing on unknown dependents).
- Reactivity (`tests/reactivity`): real Solid under Node's `browser` condition with mock timers: debounced syncs, back-off, refused batches, edits during a sync, guests made only when needed, other tabs, settling, Undo, Delete everything, disposal.
- Browser (Playwright, Chromium and WebKit, including touch phones): the production build in ignored `.playwright-dist/`, against intercepted Auth/RPC fixtures (`tests/helpers/browser.ts` applies syncs the way `planner_list` does): first visits, returning guests, token refresh, ended sessions, accounts from before guests, every list action, offline and other-device edits, two tabs, the five-open-task limit, a full list, safe rendering, Delete everything, cookies and analytics consent, and CSP/SRI probes.

They never contact a hosted service. Before release, check a real anonymous sign-in, a first task reaching the hosted list, and Delete everything against the hosted project.

### Hosted release checks (non-destructive)

```sh
npm run check:production                                  # uses .env/.env.local public settings
npm run check:production -- --url https://www.prune.win
npm run check:production -- --website-only
npm run --silent check:production -- --json > production-report.json
```

It checks the **live deployment**: headers on the real HTML response, tracker integrations, script and stylesheet integrity, anonymous denial on every table and both RPCs, and the Auth settings guests need (sign-ups and anonymous sign-ins on). It creates no accounts, sends no email and requests zero rows. Results are PASS, WARN, FAIL, ERROR or SKIP; exit 0 means no failures or errors, 1 confirmed failures, 2 incomplete. It does not prove authenticated account isolation: run `supabase/security-audit.sql` in the hosted SQL editor and the manual gates in `PRODUCTION_READINESS.md`.

## Code quality

```sh
npm run check          # strict typecheck (src, server, scripts, tests), ESLint + Solid rules, formatting
npm run format         # format src and server
```

CI (`.github/workflows/ci.yml`) runs `npm audit`, the checks, every test and the Vercel packaging with fixture settings. `package.json` overrides `minimatch` to `^11.0.1` (advisory GHSA-g3hv-75wg-m249) until eslint and typescript-eslint accept 11.
