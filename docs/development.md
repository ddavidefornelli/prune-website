# prune web app: development and operations

The easiest to-do list: one list, nothing else, and nothing to sign up for. `/` opens straight onto the list. Type a task and press Enter; tick it off; tap its words to change them or delete it. Done tasks fold under **Done**. The list lives in the browser first and opens at once, with or without a network. After the first task, the browser gets a **guest id** (a Supabase anonymous user) and the list is copied to Supabase under it, quietly: a missing or unreachable backend never shows an error.

Until 22 November 2026 prune was a day planner (five tasks a day, a focus timer, AI check-ins, streaks, reminders at a focus time, an onboarding tour). The website no longer contains any of it; its backend is still deployed and is described under [Retired with the day planner](#retired-with-the-day-planner).

**Launch status:** see [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md) for the security review and the remaining hosted launch gates. Passing local tests is not production approval.

An idiomatic **SolidJS + TypeScript** application with one render root, signals and lifecycle-managed effects. It talks to the shared Supabase backend (whose base schema lives in `../pro`) through two RPCs, `planner_call` for the account and `planner_list` for the list. How the code is organised is described in [the code structure notes](refactoring.md).

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
```

These are public browser settings, embedded **at build time**. A modern `sb_publishable_…` key or legacy anon key is accepted. Never use a service-role key, `sb_secret_…` key or other privileged credential. Partial/unsafe configuration fails Vite startup/build; production builds also fail when configuration is entirely missing. An unconfigured development checkout displays a setup error and cannot falsely report successful signup. Do not put real keys into tests.

There is no landing or sign-in page. A first visit shows the list with one muted line under the field: "By adding a task you agree to the Terms and Privacy Policy." (both links open `PRIVACY.md`). Adding a task records that acceptance; nothing is sent anywhere before it. The page has no images, artwork or webfont. The favicon and touch icon are still the plum mark (`scripts/brand/prune-mark.svg`, rendered by `node scripts/render-icons.mjs`).

## Features

- **Add:** the field at the top; Enter adds the task on top of the list and keeps the cursor there. On a laptop the page opens ready to type; on a phone it waits for a tap so the keyboard does not cover the list.
- **Tick:** the circle. A ticked task stays in place for a moment (`LIST_TIMING.settleMs`), then moves under **Done**, which is folded away; open it to untick tasks or **Clear** them all.
- **Edit and delete:** tap a task's words to edit them (Enter saves, Escape cancels, emptying them deletes). × deletes; it shows on hover, on focus and while editing. Every delete and Clear offers **Undo** for a few seconds.
- **Menu:** the ••• button opens a sheet with Terms & Privacy, Cookie settings and **Delete everything** (and, for an account from before guests, its email).
- **Sync:** every change is saved on the device at once and sent to `planner_list` shortly after (a burst goes out together), when the page is shown or back online, and every 30 seconds while visible. Failures retry with growing pauses and are never shown: the device's copy is the one that counts. Each task carries the time of its last edit and the newest edit wins, so retries are harmless. Tabs share one copy in localStorage (`prune:list:v1`, which also records the account it last synced with) and see each other's edits.
- **Guest ids:** `BrowserCloud.identity` uses the saved session (checked with Auth) or, when there is none and the list has something to keep, `signInAnonymously()`. A guest the server no longer knows, or a saved session that disagrees with its own token, is replaced by a new guest, and the whole list is uploaded to it (`TaskList.adopt`), so nothing is lost. Accounts from before guests (Google or an emailed code) keep syncing in browsers where they are signed in; there is no new sign-in.
- **Phone-first and accessible:** 44px targets, light and dark themes from the system, reduced motion respected, every control named for screen readers.

### Browser limitations

- **Browser sessions are not Keychain sessions.** The Supabase browser client keeps access/refresh tokens in its own localStorage entry. They never enter the saved list. This is JavaScript-accessible storage, not HttpOnly cookies; use a trusted device/browser profile.
- A guest's list belongs to its browser: there is no way to open it on another device, and clearing site data loses it (and the guest id with it).
- Delete everything erases the list in the cloud and here, forgets the guest id and reloads; the next task starts a new guest.

## Connect the existing backend

Identity is Supabase Auth: anonymous users (guests), plus the Google and emailed-code accounts made before guests. Do **not** reset the database or create a parallel account store. The web transport calls:

```text
/auth/v1/signup                a new guest (anonymous sign-in)
/auth/v1/user, /token, /logout checking, refreshing and forgetting the session
/rest/v1/rpc/planner_list      the list: 'sync', and 'erase' for Delete everything
/rest/v1/rpc/planner_call      'delete_account', for accounts from before guests
/functions/v1/email-unsubscribe
```

Backend source, RLS and the day planner's migrations remain in `../pro/supabase`; this repository adds website migrations. This website does not apply migrations or make administrative changes automatically.

### Deploy the task list

1. In the Supabase dashboard, **Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins**, and keep **Allow new users to sign up** on (a guest is a sign-up). Supabase limits anonymous sign-ins per IP address (30 an hour by default); CAPTCHA is not implemented in this client, so do not require one.
2. In the SQL editor (or `supabase db push` from the linked project), apply `supabase/migrations/20261124000100_task_list.sql`, then `20261124000200_comeback_reminders_only.sql`. Both need the earlier website migrations, including `20261121000100_focus_time.sql`. Keep them in the shared backend's deployment history too.
3. Deploy this website. Until steps 1 and 2 are done, the list still works in each browser; it just doesn't reach the cloud, and nothing says so.

`20261124000100_task_list.sql` adds `planner_list_tasks` (RLS on, no browser grants: only the `planner_list` security-definer function reaches it) and `planner_accounts.list_started_at`. `planner_list` accepts guests (`is_anonymous`) and records nothing about them for reminders; `planner_list('erase')` deletes the caller's whole list. `planner_list('sync', {save, remove})` applies removals, then saves where the newest `updatedAt` wins (client clocks are capped at the server's plus a minute), keeps at most 1,000 tasks (the oldest done task makes room; a full list of open tasks refuses new ones and reports them in `rejected`), and returns the whole list. Like `planner_call`, it records the visit and time zone for reminder emails at most once an hour. The first sync of an account copies its unfinished `planner_tasks` for that day and later into the list, once; a failure there is logged and retried, never blocking the list. `20261124000200_comeback_reminders_only.sql` redefines `planner_claim_reminders` to claim only come-back emails (see below).

### Retired with the day planner

The website no longer calls `planner_schedule`, `planner_track`, the `weekly-review` or `task-suggestions` Edge Functions, or the task actions of `planner_call`; the CSP no longer allows them. They stay deployed until they are retired on purpose, together with their source here (`server/weekly-review`, `server/task-suggestions`, `server/planner-contract.ts`) and their tests. The old tables keep their data until each account is deleted; `PRIVACY.md` says so. Retiring them means: undeploying those functions, dropping their AI secrets, and a reviewed migration for the tables, after checking that nothing else reads them (see [the database review](database-review.md)). `public/sw.js` stays so browsers that turned notifications on keep showing the come-back reminder.

### Reminder emails

Since `20261124000200_comeback_reminders_only.sql` only one email is sent:

- **Come-back** — at most once a week after 7 days without a signed-in request (a list sync counts), in the owner's morning window (three hours from 09:00, or from the focus time chosen in the day planner); stops after four in a row and resets when the owner returns. No task content.

The daily focus-time reminder (today's planned tasks, or "what's the one thing?") is no longer claimed: the list has no days. Preferences and focus times are kept. The account sheet's **Reminder emails** switch sets both `daily` and `comeback`; the link in each email still turns that email off without signing in.

`pg_cron` calls the `daily-reminders` Edge Function at minute 5 of every hour. `planner_claim_reminders` picks accounts where it is 09:00–11:59 in the last timezone a client reported (so a missed run is caught up the next hour) and marks them as sent in the same statement, so overlapping or retried runs cannot email anyone twice. A claim is released for retry only when Brevo may accept it later (network error, 429, 5xx). If Brevo refuses the account itself (401, 402 or 403: a wrong key, an IP blocked by Brevo's **Authorised IPs** setting, or no credits), the run stops, releases every unsent claim and answers 502, so a misconfiguration never uses up a reminder. Supabase functions have no fixed outbound IP, so leave Authorised IPs off for this key.

Setup, once:

1. Apply `supabase/migrations/20261112000200_email_reminders.sql`, then `20261112000300_email_reminders_cron.sql`. Keep the first in the shared backend's deployment history: it redefines `planner_call`.
2. In Brevo, create an **API key** (SMTP & API → API Keys; this is not the SMTP key Supabase uses for its own emails) and switch off open/click tracking for transactional email.
3. Set the function secrets (never commit them):
   `npx supabase secrets set BREVO_API_KEY=… REMINDER_FROM_EMAIL=… REMINDER_CRON_SECRET=…`
   `REMINDER_FROM_EMAIL` must be a sender verified in Brevo; `REMINDER_CRON_SECRET` is any long random string. Optional: `SITE_URL`, `REMINDER_BATCH_LIMIT` (emails per hourly run, default 100 — Brevo's free plan allows 300 a day).
4. `npx supabase functions deploy daily-reminders email-unsubscribe` (`supabase/config.toml` turns JWT verification off for both; each checks its own secret or token).
5. Create two Vault secrets so the cron job can call the function: `reminders_function_url` = `https://<project-ref>.supabase.co/functions/v1/daily-reminders` and `reminders_cron_secret` = the same value as `REMINDER_CRON_SECRET`.
6. Rebuild this client so the CSP `connect-src` includes `/functions/v1/email-unsubscribe`.

Until steps 3 and 5 are done the job runs but claims and sends nothing. To test by hand: `curl -X POST -H "Authorization: Bearer $REMINDER_CRON_SECRET" https://<project-ref>.supabase.co/functions/v1/daily-reminders` returns `{"sent":…,"retry":…,"rejected":…,"released":…}`.

### Removed guest and survey backend

`supabase/migrations/20261105000300_drop_guest_and_survey.sql` drops `guest_record_usage` and `guest_usage_daily` (anonymous totals and the survey funnel), `planner_import_guest` and `planner_guest_imports` (guest import receipts; imported tasks stay in the planner tables), and `planner_week_goal` and `planner_onboarding` (survey answers). It permanently deletes that data, so export anything you want first. Apply it after this client is live, since older open tabs may still call those endpoints until they reload. A hosted `weekly-review` function that still passes `loadWeekGoal` keeps working: the failed lookup reviews the week without a goal. Remove that wiring from `../pro` when convenient. Delete the `VITE_SURVEY_FLOW` variable from Vercel; nothing reads it.

### Delete everything and account deletion

**Delete everything** (in the menu) erases the list with `planner_list('erase')`, forgets the session and the device's copy, and reloads; nothing new is created until the next task. A browser that never synced just clears its copy. For an account from before guests it also calls `planner_call('delete_account')`, which marks `planner_accounts."isDeleted"` and `deleted_at`; other browsers signed in to that account get `PT403` on their next sync and clear their copy, quietly. Since `20261124000100_task_list.sql`, a session that signed in after a deletion would restore the account (`amr` timestamps, else `iat`), though the website no longer offers a sign-in.

After at least 30 days, list accounts ready for manual removal in the Supabase SQL editor:

```sql
select user_id, deleted_at
from public.planner_accounts
where "isDeleted" and deleted_at <= now() - interval '30 days'
order by deleted_at;
```

Review this list and permanently delete the corresponding **Auth users** via Supabase's administrative tools; deleting only `planner_accounts` does not remove all user data and may allow reprovisioning. Every list row goes with the Auth user (`on delete cascade`). No purge scheduler or automatic hard deletion is installed.

Guests: `PRIVACY.md` says unused guest ids may be removed after 12 months. Before public release, schedule that clean-up, for example (review it first; it deletes Auth users and, by cascade, their lists):

```sql
delete from auth.users
where is_anonymous and coalesce(last_sign_in_at, created_at) < now() - interval '12 months';
```

The Google and emailed-code sign-in providers can stay enabled for the accounts made before guests (their sessions still refresh), but nothing on the website starts a new sign-in.

### Weekly AI CORS (retired functions)

The Edge Functions' `ALLOWED_ORIGINS` must include the exact website origin; without it they allow only `https://www.prune.win`. Do not assume a custom domain or preview origin is also allowed. Setting this secret **replaces** the default, so list every origin you need (`EXTRA_ALLOWED_ORIGINS` adds to it instead):

```sh
# Run from the linked backend project in ../pro, replacing YOUR_DOMAIN.
npx supabase secrets set ALLOWED_ORIGINS='http://127.0.0.1:5173,https://YOUR_DOMAIN'
```

Use explicit production/preview origins rather than `*`. CORS is not an authentication or abuse defense; existing Auth, consent, RLS and server quotas still apply. AI failure does not block planner/timer operations.

## Build and deploy

```sh
npm run build
npm run preview
```

On Vercel, add the two `VITE_SUPABASE_*` variables to the relevant deployment environments. `vercel.json` selects the **Other** framework and `npm run build:vercel`, which builds `dist/` and packages the exact files and generated HTTP headers into `.vercel/output/` using the [Build Output API](https://vercel.com/docs/build-output-api). Clear any old dashboard Build Command/Output Directory overrides; do **not** publish only `dist/` on Vercel and discard the generated routing/header configuration. `/login` and `/login/` are rewritten to the app. Rebuild/redeploy after changing backend configuration; custom HTTPS Supabase domains work without a wildcard or a manual CSP edit.

On another static host, publish `dist/`, install the headers from `dist/security-headers.json` as real HTTP response headers, disable HTML caching (`Cache-Control: no-store`), and configure the `/login` fallback. The JSON file is deployment metadata, not something the browser applies automatically. Deploy HTML, assets and headers atomically; never let a CDN rewrite JavaScript/CSS after integrity hashes are generated. Built artifacts require an HTTPS backend (use `npm run dev` for an HTTP local Supabase instance).

### Publish and verify the security fix on Vercel

**Local changes do not fix the live domain until they are deployed.** A website check that still detects Google Ads/GoatCounter and missing HTTP headers is seeing the old marketing deployment, not this hardened app. Do not weaken CSP to accommodate that old page or unreviewed host-injected scripts.

`npm run build:vercel` now removes stale `.vercel/output/` **before** compiling, packages the exact HTML/assets/HTTP policy, and runs the website security assertions against the generated routes and final JavaScript **and CSS** bytes. It also scans copied public text assets for known tracker integrations. Compilation, integrity, policy or verification failure removes the deployable output, so a later `--prebuilt` command cannot accidentally publish an older artifact. CI runs this with fixture-only public configuration; **never deploy CI's fixture build or `.playwright-dist/`**.

To inspect an existing local package without deploying:

```sh
npm run build:vercel
npm run check:deployment
```

The artifact check supports only the route vocabulary generated by our packager and rejects unknown routing. It is **not** a Vercel/CDN emulator or a live HTTP test. Dashboard overrides, host injection, domain aliases and TLS must still be verified after deployment.

For the actual production release, first set the two production public Supabase variables in Vercel, clear stale Build Command/Output Directory overrides, enable Web Analytics in the Vercel project (leave Speed Insights disabled), and confirm the project/domain belong to this app. Deploy the current changes through the configured production Git branch, or use an authenticated Vercel CLI session:

```sh
# Select the existing project, not a new/empty one. Requires operator access.
# Use PRODUCTION variables, not fixture values; stop at any failed step.
npx vercel link &&
  npx vercel pull --yes --environment=production &&
  npx vercel build --prod &&
  npm run check:deployment &&
  npx vercel deploy --prebuilt --prod &&
  npm run check:production -- --url https://www.prune.win --website-only
```

Confirm the domain points at this new deployment. The last command must pass on `/`, `/login`, `/login/` and `/index.html`. Do not publish `dist/` alone or manually copy a CSP hash from a different build. Then run the full release checks and complete the manual backend/privacy gates in [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md).

### Content Security Policy (CSP)

CSP is a browser-enforced allowlist, delivered in the `Content-Security-Policy` response header. If an injection bug inserts an unauthorized script, event handler, resource or connection, the browser blocks it. This matters particularly here because browser session tokens are accessible to JavaScript. CSP is defense in depth—not a replacement for safe text rendering, dependency hygiene, authentication or server-side authorization.

Our production policy is **hash-locked and generated from the final build**:

- Denies resources by default (`default-src 'none'`). Application JavaScript is authorized by SHA-384 hashes of the emitted bytes, with matching Subresource Integrity (`integrity`) on every entry script. The only managed-script exception is `/_vercel/insights/script.js` on `https://www.prune.win` and `https://prune.win`; this script is trusted without SRI and can change independently of the build. There is no broad `'self'` fallback or `strict-dynamic` delegation. A newly injected same-origin script is blocked too. Modified script bytes fail integrity verification.
- Adds stylesheet integrity checks. Stylesheets and images stay same-origin; inline styles/style attributes, data images, fonts, manifests, media, plugins, frames and workers are denied. Property-level CSSOM updates (the task editor grows with its text this way) still work.
- Blocks inline scripts, event handlers, `eval()`/string compilation, base-URL overrides and embedding this website in another site's frame. **All native form submissions are denied**, including same-origin ones: app forms use prevented submit events and the authenticated API transport.
- Allows connections only to the exact configured backend's four used Auth endpoints (anonymous sign-up, user, token, logout), the `planner_call` and `planner_list` RPCs and the `email-unsubscribe` Edge Function. Also allows Vercel Web Analytics connections under `/_vercel/insights/` on the two production origins. No broad same-origin fetch allowance, Supabase wildcard, Storage, arbitrary RPCs/Functions or Realtime. CSP path restrictions are not an authorization boundary (redirects can relax CSP path matching); the API transport also rejects redirects, and backend Auth/RLS remain mandatory.
- Upgrades insecure requests in deployed HTTPS responses. Adjacent headers enforce MIME checks, referrer suppression, framing denial, opener/resource isolation and disabled DNS prefetch. HTML is served `no-store` to avoid stale document/hash-policy combinations.

The Vite plugin in `scripts/csp-plugin.ts` hashes the finished bundle, adds integrity attributes and a restrictive meta fallback, and emits `security-headers.json`. `scripts/build-vercel.ts` revalidates the complete HTML and script/stylesheet bytes before packaging those exact headers with the static files, so the real HTTP policy—not just a meta tag—pins scripts and API endpoints. Meta cannot enforce `frame-ancestors`; do not omit the HTTP headers. Builds fail on inline executable content, ambiguous asset attributes, missing assets, known marketing integrations or module/code-splitting dependencies rather than silently weakening the allowlist. The source, build and hosted scans share `scripts/tracking-policy.ts`; this recognized-tracker denylist is not an exhaustive network audit. Introducing dynamic imports requires a deliberate integrity/CSP design review.

`npm run preview` reads the **built artifact's headers**, not newly changed environment values. On HTTP loopback only, it omits `upgrade-insecure-requests` so WebKit does not upgrade local assets to a nonexistent TLS listener; deployed HTTPS headers retain it. `npm run dev` deliberately does not enforce CSP because Vite HMR requires injected styles and a WebSocket. Browser DevTools shows CSP violations; adding an integration requires policy review, not adding `*`, `unsafe-inline` or `unsafe-eval`.

After deployment, run `npm run check:production` with the matching public configuration. It verifies the generated hosted policy semantically (directive/source ordering and whitespace do not matter), meta/header agreement and actual deployed JavaScript/CSS integrity on `/`, `/login`, `/login/` and `/index.html`. No reporting collector is configured, so CSP violation data is not sent to a third party.

**Limits:** hash-approved JavaScript (including dependencies) can still read browser tokens and use permitted API endpoints. A compromised build/hosting account can replace both code and its policy; CSP is not protection against that. Trusted Types enforcement is not enabled: Solid's template runtime uses HTML sinks and needs a separately reviewed compatible integration, not a permissive default policy. HSTS subdomain/preload opt-in is also deliberately not assumed without auditing all subdomains. This is a hardened static-client policy, not a claim that the whole service is invulnerable.

### Privacy before public release

`PRIVACY.md` combines plain-language terms for the free service with the privacy notice and browser storage details. Adding a task, next to "By adding a task you agree to the Terms and Privacy Policy.", records terms acceptance and privacy acknowledgement on that browser before anything is sent (`privacy-web-v24` describes the list: no sign-up, guest ids, no AI, Delete everything, come-back emails only for accounts from before guests, and their earlier planner data kept until deletion; `privacy-web-v23` asked for browser notifications when onboarding finished; `privacy-web-v21` added a per-account history of task changes; `privacy-web-v20` added the daily focus time, browser notifications and calendar entries; `privacy-web-v19` introduced the weekly check-in; `privacy-web-v15` added reminder emails through Brevo; `privacy-web-v13` added emailed-code sign-in; v12 removed the guest planner; v10 added Google sign-in). When the version changes, the line shows again and the list stays local until the next task. This is not an account-wide legal acceptance register. **It remains Draft and requires operator/legal review before public release**, including hosting/log retention, processor arrangements and the guest clean-up.

The day planner's AI and review migrations (`20261024000100` to `20261119000100`) stay in the history for the shared backend; the website no longer depends on them.

## Tests

```sh
npx playwright install chromium webkit
npm test
# Or:
npm run test:unit
npm run test:e2e
```

Unit tests cover `TaskList` (ordering, change times, batches, merging the cloud's answer, Undo, adopting a new owner), `TaskStorage` (tabs, full or blocked storage, retired keys), public-key validation, privacy records and HTTP error classification; SQL tests run the migrations in PGlite (`tests/task-list-sql.test.mjs`: newest edit wins, isolation, guests, erase, the one-time copy, the 1,000-task limit, clock caps, deletion and restore; `tests/comeback-reminders.test.mjs`). `test:reactivity` runs real Solid reactivity under Node's `browser` export condition with mock timers: debounced syncs, offline back-off, refused batches, edits made while a sync is out, guests made only when needed, a new owner, other tabs, settling, Undo, Delete everything, disposal. Playwright runs Chromium and WebKit, including real touch/mobile contexts: the first visit (no requests before the first task, the acceptance line, a quietly made guest id, guests switched off, outdated acceptance), returning guests and accounts from before guests, adding, ticking, editing, deleting and clearing, offline and other-device edits, two tabs, a full list, safe rendering, Delete everything and phone layouts.

Browser tests build production output into ignored `.playwright-dist/` (never overwriting production `dist/`) and exercise the real Supabase SDK, browser storage and HTTP transport against **intercepted Auth/RPC fixtures** (`tests/helpers/browser.ts` applies list syncs the way `planner_list` does). They include stored-HTML injection, a saved session that disagrees with its token, Back after Delete everything and token separation. Security regressions cover GET/HEAD headers on document aliases and query strings, actual same-origin frame rejection and modified stylesheet SRI, plus unit tests of the packaged deployment's headers/routes, public-file tracker scan and stale-output cleanup. Vite preview installs the production security headers, and explicit CSP/SRI probes verify blocked inline code/styles, same-origin/third-party script injection, modified bundles, frames, workers, native form submissions, base overrides and connections outside the exact API endpoint allowlist. They do not connect to a hosted database. Before release, verify a real anonymous sign-in, a first task reaching the hosted list, and Delete everything against the actual hosted project.

### Hosted release checks (non-destructive)

```sh
# Uses .env/.env.local public Supabase configuration. No admin credentials.
npm run check:production
# Explicit target (PRUNE_SITE_URL still works); safe HTTPS redirects are followed:
npm run check:production -- --url https://www.prune.win
# Inspect just the website, or explicitly exclude optional AI checks:
npm run check:production -- --website-only
npm run check:production -- --skip-ai
# JSON without npm's banner, useful for saving a machine-readable report:
npm run --silent check:production -- --json > production-report.json
npm run check:production -- --help
# Repeat browser stability checks with ten parallel local browser workers:
npm run test:e2e -- --repeat-each=3 --workers=10
```

`check:production` checks the **live deployment**, not your local source: editing/building the app does not change its result until that build is deployed. It checks headers using the actual HTML GET response (not potentially different HEAD responses), known tracker integrations in HTML and fetched assets, actual script/stylesheet integrity, anonymous SQL denial, Auth public settings, and AI authentication/CORS. It creates no accounts, sends no email, requests zero table rows and makes no paid AI calls. Guests need sign-ups and anonymous sign-ins enabled: the check fails if either is off, and verifies that `planner_call` and `planner_list` refuse requests without a user.

Results distinguish **PASS**, **WARN** (review required), **FAIL** (confirmed mismatch), **ERROR** (unverified due to configuration/network/response problems), and **SKIP** (dependent or explicitly excluded checks). Exit **0** means no failures/errors in the selected scope, **1** means confirmed failures, and **2** means the run is incomplete. Warnings/skips never mean full production approval. Missing CSP produces one CSP failure per page rather than cascading meta-comparison failures. Request deadlines include streamed bodies; script assets are size-bounded and downloaded once, and API credentials are never forwarded to website redirects/assets. Fix suggestions are grouped at the end. `--timeout-ms 30000` adjusts per-request deadlines. Run `node --experimental-strip-types --test tests/production-check.test.mjs` for the checker's credential-free regression tests.

The checker does not prove authenticated account isolation or backend deployment parity, and recognized-tracker scans are not exhaustive browser-network audits. Use the read-only `supabase/security-audit.sql` in the hosted SQL Editor and complete the manual gates in `PRODUCTION_READINESS.md`. Do not reset or seed the shared production database.

## Architecture and maintenance

```text
src/
  App.tsx                       Error boundary; the unsubscribe page or the session
  index.tsx                     The single Solid render root and private analytics URLs
  analytics.ts                  Analytics: optional PostHog, started only after consent
  cloud/
    account.ts                  AccountClient: the guest id or saved account, terms acceptance, list calls, Delete everything
    browser.ts                  BrowserCloud: the session or a new guest (anonymous sign-in), RPC requests
    api-fetch.ts                BoundedFetch: deadlines, cancellation and response limits
    cloud-error.ts              CloudError: failure codes the list's sync relies on
    privacy-state.ts            PrivacyNotice: the versioned terms/privacy acknowledgement
    constants.ts / messages.ts  Account bounds, media queries, OAuth parameters; shared copy
  tasks/
    TaskApp.tsx                 The app: the list, the acceptance line and the menu
    components/                 Add field, task row, Done, Undo bar and the menu sheet
    task-list.ts                TaskList: the list and its unsaved changes, immutable
    task-storage.ts             TaskStorage: one account's list in localStorage, shared by tabs
    list-sync.ts                ListSync: when and how changes go to planner_list
    list-state.ts               ListState: the reactive list, its actions, acceptance and Delete everything
    constants.ts / types.ts     Limits and timings; the plain records
  components/                   Native dialog, privacy policy, cookie banner, unsubscribe page
  shared/                       Storage keys, routes, site and time constants
  styles/                       base.css (tokens, light and dark) and app.css (the screens)
server/
  http.ts                       Shared bounded reads and explicitly safe API errors
  reminders/                    Reminder emails and push: HTML, Brevo request, cron and unsubscribe
  weekly-review/, task-suggestions/, planner-contract.ts
                                The retired day planner's AI functions, still deployed
```

See [refactoring notes](refactoring.md) for the cleanup boundaries and compatibility guarantees.

### Code quality

```sh
npm run check          # Strict typecheck (including server), ESLint + Solid rules, formatting
npm run format         # Format maintained frontend and server source
npm run test:unit      # Domain/queue/security tests and Solid lifecycle tests
npm run test:e2e       # Production-artifact Chromium + WebKit workflows
```

CI runs the same quality gates before testing and packaging. Supabase CLI, PGlite, formatting, linting and server-build tools are development dependencies. `package.json` overrides `minimatch` to `^11.0.1` (advisory GHSA-g3hv-75wg-m249) because eslint and typescript-eslint still declare `^10`; remove the override once they accept 11.

### Component and data boundaries

- Render with JSX and `Show`/`For`/`Switch`; use effects only for external effects, subscriptions and measurements. No manual `replaceChildren` rendering, nested render roots, unsafe HTML sinks or global DOM-based state synchronization.
- `ListState` owns the signed-in screen's state. Rows are keyed by task id and `TaskList.reuse` keeps unchanged task objects across syncs, so an edit in progress survives a sync. `TaskStorage` reads the stored copy before every change, so tabs never overwrite each other.
- `ListSync` runs one sync at a time; a refused batch (`PT400`) is dropped with its reason instead of retried forever; network and server failures keep the changes and back off.
- Session disposal stops the sync, its timers and listeners; late responses cannot update a disposed screen.
- Backend/schema cleanup must consider **all** clients. See [the database review](database-review.md).

Database deployment still requires the shared backend checkout; website deployment does not.
