# Database review

## Decision

**No table or column has been proven safe to drop.** The task list (2026-11-22) only adds `planner_list_tasks`, `planner_accounts.list_started_at` and the `planner_list` function, and narrows `planner_claim_reminders` to come-back emails; the day planner's tables keep their data until each account is deleted, though the website no longer reads or writes them.

The base schema lives in `../pro/supabase/migrations/`; this repository contains additive website/shared-backend migrations. This review inspected both migration histories, not production user data or the live database catalog. The Mac app that also used this schema is retired, and Clerk is not used. Absence from the web UI is not evidence that persisted data is unused.

## Tables retained

| Table | Current dependency |
| --- | --- |
| `planner_accounts` | Account provisioning, deletion, AI preferences, revision and event-time guards. |
| `planner_list_tasks` | The task list (since `20261124000100_task_list.sql`): one row per task, reached only through `planner_list`. |
| `planner_tasks` | Plans, estimates, focus timestamps, task history and completed-task statistics. |
| `planner_stops` | Pause reasons and the evidence behind weekly review patterns. |
| `planner_reviews` | Saved weekly reports and report history. |
| `planner_receipts` | Idempotency: retrying an ambiguously acknowledged queued mutation must not apply it twice. |
| `ai_controls` | Server-side AI availability, development-mode controls and bounded usage budgets. |
| `ai_usage` | Daily/monthly aggregate request limits used by scheduled reviews. |
| `ai_review_requests` | Scheduled generation, per-account quotas, request leases, preference revisions and retention. |

## Tables dropped

| Table | Dropped by |
| --- | --- |
| `planner_resources`, `ai_review_previews` | `20261123000100_drop_mac_only_tables.sql`, with the Mac app. Task JSON keeps `resources: []`; the resource commands are no-ops. |
| `planner_clerk_identities` | `20261105000200_drop_clerk_bridge.sql`, with `planner_call_as`, once the Clerk transport was removed. |

## Fields that may look redundant

- **`planner_tasks.is_priority` / API `isPriority`:** no client reads it any more (the browser ignores it), but task serialization and the server's command handling still write it. Retire it with a reviewed migration of those functions.
- **`planner_tasks.slot`:** implements the unique per-day task positions and the five-task limit (three until `20261119000100_five_tasks_per_day.sql`). It is not just a presentation preference.
- **`consent_version`, `consent_recorded_at`, AI/consent revision fields:** legacy naming does not make these removable. Existing review reservation and completion functions use the version/revision gates; other clients still write the preference metadata. These fields are not evidence of affirmative legal consent.
- **`revision`, `last_event_at`, receipt inputs/results:** required by ordered outbox replay, clock validation, conflict detection and exactly-once mutation identities.
- **`"isDeleted"`, `deleted_at`:** enforce immediate account access denial and the manual 30-day removal policy. Never replace this process with a schema cleanup.
- **AI request activity/analysis/model fields:** some content is transient or copied into saved reviews, but it participates in generation and retention functions. Dropping it would require replacing those functions and auditing the Edge Function deployment together.
- **API `canPlanTomorrow`:** a response field the server still sends; tomorrow is always available, and the browser ignores it.

## Cleanup completed without touching user data

Removed the website's unused resource mutation methods and resource URL helper, unused manual-preview client method, legacy imperative UI/mount adapters, resource/preview/onboarding styles for retired screens, and unreferenced public artwork/font assets. A retired command already saved in someone's offline queue still replays (as a no-op locally), so old outboxes never fail.

## Requirements before any future destructive migration

1. Inspect the hosted catalog, function bodies, grants, policies, indexes and retention jobs using operator-approved read-only access.
2. Audit the web client, every Edge Function, pending outbox versions and administrative integrations.
3. First deploy a compatible replacement protocol and migrate existing rows; verify cross-device and rollback behavior.
4. Back up data and apply a separately reviewed, forward-only migration through the shared backend's deployment history.

Do not reset the database, rewrite migration history, drop columns with `CASCADE`, or infer that a table is disposable merely because the website does not render it.
