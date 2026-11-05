# prune web app: development and operations

A mobile-first daily planner and focus timer, with immediate guest access at `/` and optional account sign-in from **Overview → Sign in**. Behind `VITE_SURVEY_FLOW`, first-time visitors can instead get a short [onboarding survey](#onboarding-survey) that ends in a focus plan and **Continue with Google**. `/download` starts the Mac download.

**Launch status:** see [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md) for the security review, test results and remaining hosted launch gates. Passing local tests is not production approval.

An idiomatic **SolidJS + TypeScript** application using reactive components, signals/stores and lifecycle-managed effects. The planner's timing/statistics rules and durable local outbox share the sibling Mac application's protocol in `../pro`. This is a browser client for the **same Supabase backend**, not a local demo or a new database. There is one Solid render root; screens do not manually build or replace DOM subtrees. No Tauri runtime or sibling checkout is required to build this website.

## Configure and run

Requires Node.js 22.12+.

```sh
npm ci
cp .env.example .env.local
# Fill in the two public values from the SAME Supabase project used by the Mac app.
npm run dev
```

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
```

These are public browser settings, embedded **at build time**. A modern `sb_publishable_…` key or legacy anon key is accepted. Never use a service-role key, `sb_secret_…` key, OpenAI key or other privileged credential. Partial/unsafe configuration fails Vite startup/build; production builds also fail when configuration is entirely missing. An unconfigured development checkout displays a setup error and cannot falsely report successful signup. Do not put real keys into tests.

Visitors can plan immediately without an account. Guest tasks and stop reasons are saved only in this browser under `prune:guest:v1`; clearing site data loses them. Guest mode does not send planner data to Supabase or OpenAI. Choose **Overview → Sign in** to accept the notice and sign in using an emailed one-time code. Guest tasks transfer to the verified account before the account planner opens. A returning verified session is restored only after this browser has acknowledged the current privacy notice.

Before deploying, apply `supabase/migrations/20261028000100_guest_import.sql` after the previous migrations. Guest import is an authenticated, atomic RPC with a durable import receipt: a failed/ambiguous response retains the guest journal, and retries use the same import identity and payload. Imports do not overwrite existing account tasks. If a planning day has no free slots or the account already has an active task, the import fails without partial writes; the guest copy remains on this device. Once transfer starts, guest edits are frozen and the transfer is bound to that account until completion.

Configure the Supabase email templates to display `{{ .Token }}` for code entry. `/?oauth=google` callbacks complete Google sign-ins started from the survey's Save screen; existing `/?oauth=email` callbacks remain supported for already-issued links. A missing backend import migration must be fixed before guest transfer can complete.

## Features

- Today and Tomorrow: up to three equal tasks per day with editable titles and estimates; start any task in any order. No main-task designation, crowns, or completion animation. Tomorrow is available immediately. Desktop resource metadata is preserved, but the current web UI does not display or edit resources.
- Focus: one active task, timestamp-based timer, pause/resume, written stop reasons, completion, and an in-memory-only notes scratchpad. Pause before switching views, just like the Mac app.
- Overview: completion calendar, automatic scheduled weekly AI reviews and saved report history. Manual current-week previews remain Mac-only.
- Profile: all-time/recent stats, streaks, AI preferences, sign-out and confirmed account deletion (soft-delete flag, followed by manual removal after 30 days).
- Durable local snapshot/outbox: optimistic local saves, ordered automatic retries, idempotent requests, cross-device conflict handling and multi-tab coordination with Web Locks. A failed local save is not reported as success. Only definitively rejected changes can be discarded.
- Phone-first layouts: touch-sized controls, 16px form inputs, stacked focus screen, bounded dialogs, safe-area padding, and natural vertical scrolling when the viewport or software keyboard is short.

### Browser differences and limitations

- **Resources remain Mac-only in the current UI.** The desktop syncs labels, URLs and absolute paths, not file contents. Existing resource metadata is still in task API responses and the browser cache, but the website does not render resource controls or open arbitrary Mac paths. This implementation does not introduce uploads.
- **Browser sessions are not Keychain sessions.** The Supabase browser client persists access/refresh tokens in a separate localStorage entry, handles token refresh, and coordinates auth across tabs. Tokens never enter the planner snapshot/outbox. This is JavaScript-accessible storage, not HttpOnly cookies; use a trusted device/browser profile. A server-mediated cookie session would be a separate architecture change.
- Sign-out is local to this browser session, not global across the Mac app. It clears browser credentials, signs out other web tabs, and retains that account's pending planner changes. Remote token revocation is best-effort when offline; already-issued access tokens can remain valid until expiry.
- Sign-in/session verification requires Auth connectivity on startup. After Auth verifies the immutable identity, a planner-only network outage can restore that account's existing cache; unauthorized responses and confirmed deletion never unlock it. Cached planner actions then work through connection losses. This also means a device disconnected from planner services cannot learn about a remote deletion until it reconnects. The cache is not a full account-history archive. Clearing site data can permanently lose unsynced work.
- The timer uses timestamps, not interval counts, so background throttling/reload does not reset elapsed focus time. Review scheduling catches up on focus/visibility/next launch; no browser task runs after all tabs are closed.
- HTTPS and a current browser with Web Locks support are required (localhost is allowed for development). Unencrypted site storage is shared by tabs on this origin but isolated by Supabase project and immutable user ID.

## Connect the existing backend

Apply `supabase/migrations/20261025000100_equal_tasks.sql` after the previous shared and website migrations before deploying this client. It removes the server's most-important-task-first restriction while preserving ownership, today's-task validation, the single-active-task rule, and queue safeguards. This affects all clients on the shared backend. Legacy priority fields/actions remain compatible with existing Mac clients and saved outbox commands; the web UI no longer uses them.

Do **not** reset the Mac app's database or create a parallel account store. Point both clients at the same project. The web transport calls the existing endpoints:

```text
/auth/v1/otp, /verify, /user, /token, /logout, /settings
/rest/v1/rpc/planner_call
/rest/v1/rpc/guest_record_usage
/functions/v1/weekly-review
/functions/v1/task-suggestions
```

Backend source, RLS, transactional planner rules, idempotent receipts, AI quotas and migrations remain in `../pro/supabase`. Apply any outstanding migrations there, including the local-queue protocol and `20261019000100_tomorrow_available.sql`. This website does not apply migrations or make administrative changes automatically. Provider secrets remain in the Edge Function, never in this repo's frontend configuration.

### Suggestions from the previous day

When Today or Tomorrow has open slots, signed-in users see up to three proposals derived from the **previous day's** tasks (Today from yesterday, Tomorrow from today): unfinished tasks carry over with their remaining estimate, and completed tasks may suggest a clearly implied next step. The `task-suggestions` Edge Function loads both days' tasks server-side (the browser sends only its timezone and `target: "today" | "tomorrow"`) and asks OpenAI (`gpt-4.1-mini`, `store: false`) for structured suggestions, which are clamped and deduplicated before returning. It respects the account's AI preference (`ai_enabled`) and deletion flag, never calls OpenAI when the previous day was empty or the target day is full, and is capped at five attempts per account per target day. Tomorrow's proposals are re-requested when today's tasks change. Guests never call it. To deploy:

1. Apply `supabase/migrations/20261030000100_task_suggestions.sql` (usage counter + server-only `planner_reserve_suggestion`).
2. `npx supabase functions deploy task-suggestions` with secrets `OPENAI_API_KEY` and `ALLOWED_ORIGINS` (same values as `weekly-review`). It imports shared code from `server/` and `src/planner/`.
3. Rebuild this client so the CSP `connect-src` includes the new function path.

If the function is missing or fails, the plan simply shows no suggestions.

### Guest usage totals

Signed-out use of the planner adds to anonymous daily totals in `public.guest_usage_daily`: `new_guests`, `active_guests` and `returning_guests` (devices, counted once per local day from the guest journal itself, with no extra identifier), `tasks_created`, `tasks_started`, `tasks_completed` and `focus_minutes` (recorded time of completed tasks). Rows hold only a UTC day, a metric and a total; no task text or identifiers are sent. Only production origins report, and a failed report never affects planning. The public key can call the function, so totals are indicative rather than tamper-proof.

1. Apply `supabase/migrations/20261031000100_guest_usage.sql` (table + the anon-callable `guest_record_usage`).
2. Rebuild this client so the CSP `connect-src` includes the new RPC path.

Read them in the SQL Editor:

```sql
select day,
  sum(total) filter (where metric = 'new_guests') as new_guests,
  sum(total) filter (where metric = 'active_guests') as active_guests,
  sum(total) filter (where metric = 'returning_guests') as returning_guests,
  sum(total) filter (where metric = 'tasks_created') as tasks_created,
  sum(total) filter (where metric = 'tasks_completed') as tasks_completed,
  sum(total) filter (where metric = 'focus_minutes') as focus_minutes
from public.guest_usage_daily group by day order by day desc;
```

### Onboarding survey

`VITE_SURVEY_FLOW` is read **at build time** (set it in Vercel's environment and redeploy):

| Value | Behaviour |
| --- | --- |
| `off` (default, also when unset or unknown) | Today's behaviour: everyone opens the guest planner. Nothing new is rendered, stored or counted. |
| `on` | First-time visitors see the survey. |
| `split` | Each browser is assigned 50/50 to `survey` or `control` once, and keeps that assignment. |

Only fresh browsers start the survey: no guest journal (`prune:guest:v1`) and no notice acceptance of any version. A started survey resumes where it was left, including after a reload or a cancelled Google round trip; skipped or finished surveys never return. Every question has Back, step progress and **Skip, just let me plan**. The flow: intro (the sign-in hero), first name, goal, role, focus window, focus length, the three-task rule, derailer, deep-work target, an optional week outcome, a "Building your plan…" checklist whose lines come from `buildPlan`, the plan, and **Save your plan** (Continue with Google, the unchecked notice checkbox, Use email instead, Not now).

`startersFor(answers)` (`src/planner/starters.ts`) picks the three first-run tasks from goal, role, focus length and derailer, and returns today's three starters when nothing was answered. The answered focus length also sets the default estimate for new tasks, capped at 60 minutes. A kept plan is added to Today by the next planner to open, as a guest (**Not now**) or in the account after sign-in, only into free slots and skipping titles already planned.

**Storage and privacy.** Answers live only in `prune:survey:v1` (with the variant and the funnel events already counted) until sign-in; nothing is sent before then. The first name never leaves the browser. After sign-in, the other answers and a current-week outcome travel inside the existing `planner_import_guest` payload as an optional `survey` object: frozen with the import identity when guest tasks transfer, or sent alone, best-effort, when there are none (a failure never blocks the account planner and retries at the next startup).

1. Apply `supabase/migrations/20261102000100_onboarding_survey.sql` after the previous migrations, **before turning the flag on**. It adds the service-role-only `planner_onboarding` table, re-creates `planner_import_guest` with strict validation of the optional `survey` object (answers alone leave the planner revision untouched), adds the server-only `planner_week_goal(user, week_start)`, and lets `guest_record_usage` count the funnel metrics. Then apply `20261105000100_survey_step_funnel.sql`, which allows the per-question `reached_*` totals; deploy it before a client that sends them, or those events are refused and, already marked as counted, never resent from that browser.
2. Weekly reviews receive the outcome through the handler's optional `loadWeekGoal` dependency, which `server/planner-runtime.ts` wires to `planner_week_goal`. The hosted `weekly-review` Edge Function lives in `../pro`; pass the same `loadWeekGoal: (userId, weekStart) => rpc("planner_week_goal", { p_user_id: userId, p_week_start: weekStart })` there and redeploy it. Until then, reviews run exactly as before, without the goal.
3. Enable Google sign-in (below), then rebuild with the flag.

**Google sign-in.** In the Supabase dashboard, enable **Authentication → Providers → Google** with a Google Cloud OAuth client whose authorized redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`. Add every served origin's callback, e.g. `https://www.prune.win/?oauth=google`, to **Authentication → URL Configuration → Redirect URLs**. The button first reads the public `/auth/v1/settings`; if Google is disabled it shows "Google sign-in isn't available right now. Use email instead." rather than sending visitors to a Supabase error page.

**Funnel.** Each event counts once per browser and variant in `guest_usage_daily`, with no answers: `funnel_control_shown`, `funnel_control_signed_up`, and `funnel_survey_` + `shown`, `started`, `finished`, `plan_shown`, `google_clicked`, `signed_up`, `skipped`, and `reached_` + each question screen after the first (`goal`, `role`, `window`, `length`, `fact`, `derailer`, `target`, `outcome`; *started* stands for the name screen), so the totals show which screen people leave on. *Shown* is a fresh browser's first eligible visit (the shared denominator); *signed up* is a completed interactive sign-in (email code or Google, new or existing account) from a browser already counted as shown.

```sql
select day, metric, total from public.guest_usage_daily
where metric like 'funnel\_%' order by day desc, metric;
```

### Account deletion

Apply `supabase/migrations/20261024000200_soft_delete_accounts.sql` after the shared backend migrations and this repo's automatic-weekly-reviews migration **before deploying this client**. It adds `planner_accounts."isDeleted"` (default `false`) and `deleted_at`. Deletion is authenticated, immediate, idempotent and never queued offline. It disables weekly AI and blocks planner RPCs/direct planner-data reads across web and Mac clients. Auth identity and cloud data remain until manual removal; signing in again does not reactivate the account. Other devices may retain offline caches.

After at least 30 days, list accounts ready for manual removal in the Supabase SQL editor:

```sql
select user_id, deleted_at
from public.planner_accounts
where "isDeleted" and deleted_at <= now() - interval '30 days'
order by deleted_at;
```

Review this list and permanently delete the corresponding **Auth users** via Supabase's administrative tools; deleting only `planner_accounts` does not remove all user data and may allow reprovisioning. No purge scheduler or automatic hard deletion is installed. Keep this migration in the shared backend's deployment history too so subsequent Mac/backend deployments preserve the guard.

### Email-code authentication

Enable Supabase email Auth and configure SMTP for production delivery. Email templates (including Magic Link and Confirm Signup) must display `{{ .Token }}` so users can enter the code on the website, rather than follow a magic link. Keep this aligned with the Mac app’s existing email-code configuration. Auth rate limits, code expiry and email delivery still need hosted smoke tests; do not enable a mandatory CAPTCHA until a matching client flow is added.

### Authentication callbacks

The Overview sign-in screen uses email codes only. With the survey flag on, its Save screen starts Google sign-in (`sign_in_with_google`, PKCE, `redirectTo` `<origin>/?oauth=google`). The Supabase transport completes `/?oauth=google` and already-issued `/?oauth=email` callbacks, removes callback parameters from the URL, and verifies identity before opening an account cache. Keep the redirect URLs configured. The unfinished Clerk transport is not selected by the current app.

### Weekly AI CORS

The existing Edge Function's `ALLOWED_ORIGINS` must include the exact website origin. The currently reviewed backend source and hosted preflight allow `https://www.prune.win`; do not assume a custom domain or preview origin is also allowed. Setting this secret **replaces** the defaults, so retain the Mac and required development origins:

```sh
# Run from the linked backend project in ../pro, replacing YOUR_DOMAIN.
npx supabase secrets set ALLOWED_ORIGINS='tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420,http://127.0.0.1:5173,https://YOUR_DOMAIN'
```

Use explicit production/preview origins rather than `*`. CORS is not an authentication or abuse defense; existing Auth, consent, RLS and server quotas still apply. AI failure does not block planner/timer operations.

## Build and deploy

```sh
npm run build
npm run preview
```

On Vercel, add the two `VITE_SUPABASE_*` variables to the relevant deployment environments. `vercel.json` selects the **Other** framework and `npm run build:vercel`, which builds `dist/` and packages the exact files and generated HTTP headers into `.vercel/output/` using the [Build Output API](https://vercel.com/docs/build-output-api). Clear any old dashboard Build Command/Output Directory overrides; do **not** publish only `dist/` on Vercel and discard the generated routing/header configuration. `/download` and `/download/` are explicitly preserved. Rebuild/redeploy after changing backend configuration; custom HTTPS Supabase domains work without a wildcard or a manual CSP edit.

On another static host, publish `dist/`, install the headers from `dist/security-headers.json` as real HTTP response headers, disable HTML caching (`Cache-Control: no-store`), and configure the download-route fallback. The JSON file is deployment metadata, not something the browser applies automatically. Deploy HTML, assets and headers atomically; never let a CDN rewrite JavaScript/CSS after integrity hashes are generated. Built artifacts require an HTTPS backend (use `npm run dev` for an HTTP local Supabase instance).

The Mac installer remains `public/prune.dmg`; replace it when shipping a newer installer. The header downloads it directly so installing does not navigate away from an active planner.

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

Confirm the domain points at this new deployment. The last command must pass on `/`, `/download`, `/download/` and `/index.html`. Do not publish `dist/` alone or manually copy a CSP hash from a different build. Then run the full release checks (including `--require-invite-only` for the closed beta) and complete the manual backend/privacy gates in [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md).

### Content Security Policy (CSP)

CSP is a browser-enforced allowlist, delivered in the `Content-Security-Policy` response header. If an injection bug inserts an unauthorized script, event handler, resource or connection, the browser blocks it. This matters particularly here because browser session tokens are accessible to JavaScript. CSP is defense in depth—not a replacement for safe text rendering, dependency hygiene, authentication or server-side authorization.

Our production policy is **hash-locked and generated from the final build**:

- Denies resources by default (`default-src 'none'`). Application JavaScript is authorized by SHA-384 hashes of the emitted bytes, with matching Subresource Integrity (`integrity`) on every entry script. The only managed-script exception is `/_vercel/insights/script.js` on `https://www.prune.win` and `https://prune.win`; this script is trusted without SRI and can change independently of the build. There is no broad `'self'` fallback or `strict-dynamic` delegation. A newly injected same-origin script is blocked too. Modified script bytes fail integrity verification.
- Adds stylesheet integrity checks. Stylesheets and images stay same-origin; inline styles/style attributes, data images, fonts, manifests, media, plugins, frames and workers are denied. Existing property-level CSSOM updates for the calendar, progress bars and animations still work.
- Blocks inline scripts, event handlers, `eval()`/string compilation, base-URL overrides and embedding this website in another site's frame. **All native form submissions are denied**, including same-origin ones: app forms use prevented submit events and the authenticated API transport.
- Allows connections only to the exact configured backend's six used Auth endpoints (including the public `/auth/v1/settings` read before Google sign-in), `planner_call` RPC and `weekly-review` Edge Function. Also allows Vercel Web Analytics connections under `/_vercel/insights/` on the two production origins. No broad same-origin fetch allowance, Supabase wildcard, Storage, arbitrary RPCs/Functions or Realtime. CSP path restrictions are not an authorization boundary (redirects can relax CSP path matching); the API transport also rejects redirects, and backend Auth/RLS remain mandatory.
- Upgrades insecure requests in deployed HTTPS responses. Adjacent headers enforce MIME checks, referrer suppression, framing denial, opener/resource isolation and disabled DNS prefetch. HTML is served `no-store` to avoid stale document/hash-policy combinations.

The Vite plugin in `scripts/csp-plugin.ts` hashes the finished bundle, adds integrity attributes and a restrictive meta fallback, and emits `security-headers.json`. `scripts/build-vercel.ts` revalidates the complete HTML and script/stylesheet bytes before packaging those exact headers with the static files, so the real HTTP policy—not just a meta tag—pins scripts and API endpoints. Meta cannot enforce `frame-ancestors`; do not omit the HTTP headers. Builds fail on inline executable content, ambiguous asset attributes, missing assets, known marketing integrations or module/code-splitting dependencies rather than silently weakening the allowlist. The source, build and hosted scans share `scripts/tracking-policy.ts`; this recognized-tracker denylist is not an exhaustive network audit. Introducing dynamic imports requires a deliberate integrity/CSP design review.

`npm run preview` reads the **built artifact's headers**, not newly changed environment values. On HTTP loopback only, it omits `upgrade-insecure-requests` so WebKit does not upgrade local assets to a nonexistent TLS listener; deployed HTTPS headers retain it. `npm run dev` deliberately does not enforce CSP because Vite HMR requires injected styles and a WebSocket. Browser DevTools shows CSP violations; adding an integration requires policy review, not adding `*`, `unsafe-inline` or `unsafe-eval`.

After deployment, run `npm run check:production` with the matching public configuration. It verifies the generated hosted policy semantically (directive/source ordering and whitespace do not matter), meta/header agreement and actual deployed JavaScript/CSS integrity on `/`, `/download`, `/download/` and `/index.html`. No reporting collector is configured, so CSP violation data is not sent to a third party.

**Limits:** hash-approved JavaScript (including dependencies) can still read browser tokens and use permitted API endpoints. A compromised build/hosting account can replace both code and its policy; CSP is not protection against that. Trusted Types enforcement is not enabled: Solid's template runtime uses HTML sinks and needs a separately reviewed compatible integration, not a permissive default policy. HSTS subdomain/preload opt-in is also deliberately not assumed without auditing all subdomains. This is a hardened static-client policy, not a claim that the whole service is invulnerable.

### Privacy before public release

`PRIVACY.md` combines plain-language terms for the free service with the privacy notice, browser storage details and automatic weekly AI disclosures. One unchecked sign-in checkbox (on the email form, or on the survey's Save screen before Google) records terms acceptance and privacy acknowledgement (`privacy-web-v11`; v10 added the survey, its funnel totals and Google sign-in, v11 the per-question funnel totals) on this browser profile; the same version is not requested again unless site storage is cleared or another browser is used. This is not an account-wide legal acceptance register. **It remains Draft and requires operator/legal review before public release**, including the legitimate-interest assessment for default-on AI, hosting/log retention and processor arrangements. Notice acknowledgement is not AI consent.

Apply `supabase/migrations/20261024000100_automatic_weekly_reviews.sql` after the shared backend migrations before deploying this client. It enables reviews for newly provisioned planner accounts and preserves all existing account preferences (including disabled reviews). It affects all clients using this shared backend. Legacy backend `consent_*` fields remain protocol compatibility gates, not evidence of affirmative consent. Do not automatically enable existing disabled accounts from the browser. Users can turn reviews off or back on in Profile.

Vercel Web Analytics is enabled for production builds on `www.prune.win` and `prune.win` using `@vercel/analytics`; enable Web Analytics in the Vercel project and redeploy. Local development, preview deployments on other hosts and local tests do not send analytics. Page-view URLs have query strings and fragments stripped (including authentication parameters); no custom planner/task events are sent. Google Ads, GoatCounter and Speed Insights remain disabled. CSP preserves application integrity pinning with the narrow managed analytics exception described above. Account export remains a manual support request. Profile → Delete account marks the shared account as deleted and disables planner access and weekly AI; permanent removal is an operator task after 30 days, not an automatic job.

## Tests

```sh
npx playwright install chromium webkit
npm test
# Or:
npm run test:unit
npm run test:e2e
```

Unit tests cover the durable queue, retry identities, ambiguous failures, storage failures, account isolation, timer projection, public-key validation, privacy records, HTTP error classification, profile statistics, onboarding and review timing. `test:reactivity` additionally runs real Solid browser reactivity under Node's `browser` export condition to check keyed reconciliation, memory-only notes, preference races, late responses and lifecycle cleanup. The active UI never renders Mac resource URLs; browser security tests verify that metadata stays inert. Playwright runs Chromium and WebKit, including real touch/mobile contexts, email-code sign-in/invalid codes, refresh/restoration, task/focus workflows, previews, conflicts, multi-tab sign-out and phone/landscape layouts.

Browser tests build production output into ignored `.playwright-dist/` with the survey flag off (never overwriting production `dist/`), and a second build into `.playwright-dist-survey/` with it on for `tests/survey.spec.ts`, and exercise the real Supabase SDK, browser storage/Web Locks and HTTP transport against **intercepted Auth/RPC/AI fixtures**. They include stored-HTML injection, tampered/rejected session identities, browser-back after sign-out and scratchpad/token separation. Security regressions cover GET/HEAD headers on document aliases and query strings, actual same-origin frame rejection and modified stylesheet SRI, plus unit tests of the packaged deployment's headers/routes, public-file tracker scan and stale-output cleanup. Vite preview installs the production security headers, and explicit CSP/SRI probes verify blocked inline code/styles, same-origin/third-party script injection, modified bundles, frames, workers, native form submissions, base overrides and connections outside the exact API endpoint allowlist. The safe-rendering tests also assert that no injected HTML nodes exist, so CSP cannot conceal an unsafe-rendering regression. They do not send real email, connect to a hosted database, call paid AI, or prove concurrent hosted database behavior. Test-only public configuration is set by `playwright.config.ts`, never production code. Mobile screenshots are written to the ignored `test-results/` directory. Before release, verify real email delivery and code verification, Mac↔web sync, timer conflicts, real review generation and sign-out against the actual hosted project.

### Hosted release checks (non-destructive)

```sh
# Uses .env/.env.local public Supabase configuration. No admin credentials.
npm run check:production
# Explicit target (PRUNE_SITE_URL still works); safe HTTPS redirects are followed:
npm run check:production -- --url https://www.prune.win
# Enforce the closed-beta signup policy:
npm run check:production -- --require-invite-only
# Inspect just the website, or explicitly exclude optional AI checks:
npm run check:production -- --website-only
npm run check:production -- --skip-ai
# JSON without npm's banner, useful for saving a machine-readable report:
npm run --silent check:production -- --json > production-report.json
npm run check:production -- --help
# Repeat browser stability checks with ten parallel local browser workers:
npm run test:e2e -- --repeat-each=3 --workers=10
```

`check:production` checks the **live deployment**, not your local source: editing/building the app does not change its result until that build is deployed. It checks headers using the actual HTML GET response (not potentially different HEAD responses), known tracker integrations in HTML and fetched assets, actual script/stylesheet integrity, anonymous SQL denial, Auth public settings, and AI authentication/CORS. It creates no accounts, sends no email, requests zero table rows and makes no paid AI calls. Public signup is a **WARN** by default because it is a product/abuse-control decision; use **`--require-invite-only` for the 5–10-person closed-beta release gate**.

Results distinguish **PASS**, **WARN** (review required), **FAIL** (confirmed mismatch), **ERROR** (unverified due to configuration/network/response problems), and **SKIP** (dependent or explicitly excluded checks). Exit **0** means no failures/errors in the selected scope, **1** means confirmed failures, and **2** means the run is incomplete. Warnings/skips never mean full production approval. Missing CSP produces one CSP failure per page rather than cascading meta-comparison failures. Request deadlines include streamed bodies; script assets are size-bounded and downloaded once, and API credentials are never forwarded to website redirects/assets. Fix suggestions are grouped at the end. `--timeout-ms 30000` adjusts per-request deadlines. Run `node --experimental-strip-types --test tests/production-check.test.mjs` for the checker's credential-free regression tests.

The checker does not prove authenticated account isolation or backend deployment parity, and recognized-tracker scans are not exhaustive browser-network audits. Use the read-only `supabase/security-audit.sql` in the hosted SQL Editor and complete the manual gates in `PRODUCTION_READINESS.md`. Do not reset or seed the shared production database.

## Architecture and maintenance

```text
src/
  App.tsx                       Error boundary and download/session route selection
  index.tsx                     The single Solid render root and private analytics URLs
  auth/                         Session phases, guest transfer and email-code sign-in UI
  survey/                       Onboarding survey: answers, state model, flag/variant, plan and screens
  components/                   Native dialog, privacy policy, download page and canvas
  planner/
    Planner.tsx                 Feature composition and navigation/onboarding state
    create-planner.ts           Reactive dashboard, mutations, clock and lifecycle
    components/                 Plans, task editor, estimate dial, focus, calendar and tour
    api.ts                      Planner client: typed queries, mutations and account access
    commands.ts                 Typed RPC results, task arguments and saved command format
    browser.ts                  Supabase authentication and authenticated requests
    api-fetch.ts                Bounded HTTP requests, cancellation and response limits
    account-queue.ts            Browser locks, sync listeners and protocol negotiation
    local-queue.ts              Versioned snapshots, atomic storage and ordered retries
    task-projection.ts          Pure task mutation replay, including legacy saved commands
    dashboard.ts                Shared task selection and timezone-aware day alignment
    types.ts                    Shared API/domain contracts; no UI dependencies
    constants.ts                UI bounds, estimate ranges, views and polling intervals
    task-model.ts               Pure task-completion and tracked-time rules
    onboarding.ts               Pure, account-scoped eligibility/storage key rules
    starters.ts                 startersFor(answers): first-run tasks from survey answers
    config.ts                   Public-only backend configuration validation
    privacy-state.ts            Versioned, device-local legal acknowledgement
  profile/                      Profile components and pure calendar-based statistics
  reviews/                      Independent AI state, preferences, reports and countdown
  shared/                       Cross-runtime rules, API paths and browser lifecycle hooks
  styles/                       Base component styles and mobile-first web layout
server/
  http.ts                       Shared bounded reads and explicitly safe API errors
  planner-handler.ts            Validated, account-scoped gateway dispatch
  weekly-review/                Review validation, provider requests and quota orchestration
  task-suggestions/             Previous-day task proposals: handler, OpenAI request, output validation
```

See [refactoring notes](refactoring.md) for the cleanup boundaries and compatibility guarantees.

### Code quality

```sh
npm run check          # Strict typecheck (including server/API), ESLint + Solid rules, formatting
npm run format         # Format maintained frontend, server and API source
npm run test:unit      # Domain/queue/security tests and Solid lifecycle tests
npm run test:e2e       # Production-artifact Chromium + WebKit workflows
```

CI runs the same quality gates before testing and packaging. Supabase CLI, PGlite, formatting, linting and server-build tools are development dependencies. Dependencies referenced by the existing in-progress Clerk frontend/backend code are explicitly declared, so a clean `npm ci` does not rely on extraneous local packages. `package.json` overrides `minimatch` to `^11.0.1` (advisory GHSA-g3hv-75wg-m249) because eslint and typescript-eslint still declare `^10`; remove the override once they accept 11. **This refactor does not switch the active Supabase transport to Clerk or deploy its bridge migration.** Existing Clerk/backend source is preserved; its frontend files are excluded from bulk formatting.

### Component and data boundaries

- Render with JSX and `Show`/`For`/`Switch`; use effects only for external effects, subscriptions and measurements. No manual `replaceChildren` rendering, nested render roots, unsafe HTML sinks or global DOM-based state synchronization.
- `createPlanner` owns one session's reactive UI state. Store reconciliation preserves task identities, drafts and focused controls during background refresh. Components own local form drafts; focus notes remain memory-only and reset when the active task changes.
- Controllers, dialogs, the canvas and navigation/tour measurements register cleanup with their Solid owner. Session disposal also stops the outbox, auth refresh and browser subscriptions; late startup/read responses cannot initialize a disposed client.
- `PlanningClient` coordinates account access, typed queries and task mutations; `GuestStore`, `LocalQueue` and the transport own their respective storage/network details. Persisted snapshot versions, storage keys, idempotency identities and the shared RPC contract are deliberately unchanged. Legacy queue projection branches must remain while saved commands or supported Mac clients can use them.
- Weekly AI state is independent of task mutation state. Preference writes invalidate older reads, and pending-review polling stops when its screen is hidden or its owner is disposed.
- Backend/schema cleanup must consider **all** clients. See [the database review](database-review.md): no table or column was safe to drop, and no hosted schema or user data was changed.

When the desktop changes, deliberately review its timing, queue and RPC contract changes while preserving browser auth, file restrictions, mobile behavior and multi-tab handling. There is no automatic cross-repository source sync. Database deployment still requires the shared backend checkout; website deployment does not.
