# Production readiness

Last reviewed: **22 November 2026**, for the list (no sign-up, guest ids). The original review of the day planner (24 October 2026) and its follow-ups are in this file's git history.

## Decision

**Not approved for public launch yet.** The gates below need the hosted project and the operator. No code review, dependency scan or test suite can guarantee that information cannot be stolen; this is not a penetration test, compliance certification or load test.

## What prune is now

One plain list. Every browser starts as a guest: after its first task (which records acceptance of the terms on that browser), Supabase's anonymous sign-in gives it a guest id and the list syncs under it. The list lives on the device first, so backend failures are never shown. Accounts from before guests keep working where they are signed in. Nothing is sent to OpenAI or any AI provider.

Backend surface reachable from a browser: Auth (anonymous sign-up, session check, refresh, sign-out), `planner_list` (security definer, `authenticated` only, guests included; no direct grants on `planner_list_tasks`), `planner_call` (`delete_account` only, not guests), the `email-unsubscribe` function (token only), the `task-helper` function (the caller's own token; a guest's three answers, then 30 answers and 300 calls a day per account, counted by `planner_helper_claim`), emailed-code and Google sign-in, and `/api/error-log` (three short names). Abuse control is Supabase's per-IP limit on anonymous sign-ins (30 an hour by default) and the 1,000-task limit per list; there is no CAPTCHA.

## Local results (22 November 2026)

| Check | Result |
| --- | --- |
| `npm run check` | Typecheck, ESLint + Solid rules and formatting pass. |
| `npm run test:unit` | Unit, SQL (every migration applied in PGlite, including the day planner's retirement) and reactivity tests pass. |
| `npm run test:e2e` | Chromium and WebKit, phones included, against intercepted Auth/RPC fixtures, pass. |
| `npm run build:vercel` | Packaging and its website security assertions pass. |

These are local results only: no hosted probe, deployment or database change was made.

## Before inviting people

1. **Deploy in order.** Turn on anonymous sign-ins (keep sign-ups on); apply `20261124000100_task_list.sql` and `20261124000200_comeback_reminders_only.sql`; deploy the website and the `daily-reminders` function; a day later, back up and apply `20261125000100_retire_day_planner.sql`, then undeploy `weekly-review` and `task-suggestions` and delete their secrets. Details: [docs/development.md](docs/development.md#retire-the-day-planner).
2. **Verify the hosted project, not the source.** Run `supabase/security-audit.sql` in the hosted SQL editor and review every result; run `npm run check:production` against `https://www.prune.win` and fix every FAIL and ERROR. Do not reset or seed the production database.
3. **Smoke-test the real thing** in two separate browser profiles: a first task creates a guest and reaches the hosted list; the two lists stay apart (also by direct REST requests with each token); an edit made offline arrives when back online; a reload after an hour (token refresh) keeps the same guest; Delete everything erases the list and the next task starts a new guest. Record results without tokens.
4. **Finish the privacy work.** `PRIVACY.md` is a **Draft**: publish a contact channel, review the lawful bases (including whether come-back emails need prior consent), confirm Supabase, Vercel, Brevo and PostHog terms, regions and retention, check that PostHog recordings mask task text, and schedule the clean-up of guest ids unused for 12 months that it promises.
5. **Operations.** Backups and a tested restore; MFA and least privilege on Supabase, Vercel, GitHub, Brevo and PostHog; secret rotation; an incident contact path. Deploy only through `npm run build:vercel` / `vercel build`, never `dist/` alone.

## Trade-offs that remain

- **Browser tokens are JavaScript-readable localStorage**, not HttpOnly cookies. CSP and text-only rendering reduce XSS risk but do not remove it; a malicious extension, compromised dependency or device could read the session and the list.
- **The device copy is unencrypted.** Anyone with access to the browser profile can read the list. Delete everything clears it; signing out alone does not exist any more.
- **Not end-to-end encrypted.** Supabase and authorised administrators can read cloud lists.
- **A guest's list belongs to its browser.** Clearing site data loses it, with the guest id; there is no recovery or second device.
- **Open sign-ups.** Anyone can create guests up to Supabase's per-IP limit; quotas are not a complete bot or DoS defence.
