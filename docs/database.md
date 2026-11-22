# Database

The hosted Supabase project, after `20261125000100_retire_day_planner.sql`. The base schema came from the shared backend (`../pro/supabase/migrations`); this repository's migrations are applied on top of it, in file order, and stay as applied history: never rewrite or delete one.

## Tables

| Table | What it holds | Who reaches it |
| --- | --- | --- |
| `planner_accounts` | One row per account: `user_id`, `"isDeleted"`, `deleted_at` (deletion and the 30-day manual removal). | `planner_list`, `planner_call`; owners may read their own row. |
| `planner_list_tasks` | The lists: one row per task (its space, title, done, created, last edited, finished), at most 1,000 per space. The website also allows only five open tasks at a time (`OPEN_TASK_LIMIT`, browser only; the database does not check it). | Only `planner_list` (no browser grants). |
| `planner_spaces` | Spaces: one Personal per account (its id is the user id) and group spaces (name, link token, owner). Deleting one deletes its tasks. | Only `planner_list`. |
| `planner_space_members` | Who is in which space (everyone in their Personal; owner and joiners in a group space). | Only `planner_list`. |
| `planner_email_reminders` | Come-back emails for accounts from before guests: time zone, last visit, the switch, send count, unsubscribe token, and the focus time and weekdays-only choice that set the morning window. | The reminder functions (service role); `planner_list` records visits. |
| `planner_push_subscriptions` | Browsers that turned notifications on in the day planner. | The reminder functions (service role). |
| `planner_helper_runs` | "Do it for me": one answer per task (the question it was asked with, the latest answer, its sources and the refine conversation). Deleting the task deletes it (trigger). | The `task-helper` Edge Function (service role). |
| `planner_helper_usage` | Answers a guest started, and each account's answers and calls today, for the limits. | `planner_helper_claim` (service role). |
| `error_log` | Connection error reports from `/api/error-log`, 90 days. | `log_client_error` (anon); service role. |

Every row goes with its Auth user (`on delete cascade`).

## Functions

| Function | Caller |
| --- | --- |
| `planner_list(action, args, timezone)` | The browser (`authenticated`, guests included): `'sync'` (a space, Personal by default; also lists the caller's spaces) and `'erase'` (deletes the spaces the caller owns, leaves the rest); signed-in accounts also `'share'` (Personal becomes a group space; a group space gives its link), `'create'` (an empty group space, the + beside Spaces), `'join'`, `'people'` (names and emails of everyone in a space, for its members only), `'rename'` and `'leave'` (the owner deletes the space). |
| `planner_call(action, args, timezone)` | The browser (`authenticated`, not guests): only `'delete_account'`. |
| `planner_claim_reminders`, `planner_release_reminder`, `planner_push_targets`, `planner_push_result` | The `daily-reminders` Edge Function. |
| `planner_unsubscribe` | The `email-unsubscribe` Edge Function. |
| `planner_helper_claim(user, guest, kind)` | The `task-helper` Edge Function: counts one use or says which limit stops it. |
| `log_client_error` | The `/api/error-log` relay (anon). |

## Retired with the day planner

`20261125000100_retire_day_planner.sql` copies each account's unfinished planner tasks for today and later into its list (for accounts that had not opened the list yet), then drops:

- `planner_tasks`, `planner_stops`, `planner_reviews`, `planner_receipts`, `planner_review_tasks`, `planner_history`, `planner_suggestion_usage`, `ai_controls`, `ai_usage`, `ai_review_requests`, and their triggers and policies;
- every function that read them (the executor `planner_execute` and `planner_call_active`, `planner_task_json`, month stats, reviews and check-ins, suggestions, history) and the scheduling entry points (`planner_schedule`, `planner_schedule_state`, `planner_track`);
- `planner_accounts`: `ai_enabled`, `ai_revision`, `consent_version`, `consent_recorded_at`, `check_in_day`, `check_in_plan`, `revision`, `last_event_at`, `list_started_at`;
- `planner_email_reminders`: the daily, start-time and getting-started columns.

It unschedules cron jobs that used them (`pro-ai-retention`) and runs the reminder job hourly again. Without `CASCADE`, an unknown view, trigger or foreign key on a retired table makes it fail and change nothing; its last step fails if any remaining function still names a retired table or column. Earlier drops: `planner_resources` and `ai_review_previews` (`20261123000100`, with the Mac app), `planner_clerk_identities` (`20261105000200`), the guest-mode and survey tables (`20261105000300`).

## Before any destructive migration

1. Back up the database. Check the hosted catalog (functions, grants, policies, views, triggers, cron jobs) with read-only access.
2. Check every caller: the website, each Edge Function, the cron jobs, open tabs of the previous website.
3. Deploy the callers that no longer need the objects first; drop them in a separate, reviewed, forward-only migration without `CASCADE`.
4. Test it in PGlite on top of the full chain (`tests/helpers/backend-db.mjs`).

## Realtime

After each write to `planner_list_tasks` or `planner_space_members`, statement triggers call `planner_space_notify`, which sends a Supabase Realtime broadcast `changed` with `{space}` (no task content) to the private topic `list:<user id>` of everyone in a group space with more than one person (and to whoever left or lost a deleted space). A policy on `realtime.messages` lets a signed-in user receive only their own topic. The browser (`ListChannel`, `src/cloud/realtime.ts`) listens while any of its spaces has other people and syncs the open space on each ping; a failed send never blocks a sync, and the half-minute poll stays as the fallback.

`20261128000100_spaces.sql` replaced `planner_list_shares` and `planner_list_members` (one shared list per account) with spaces: each shared list became a group space with the same link and people.
