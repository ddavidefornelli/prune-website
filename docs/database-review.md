# Database review — SolidJS refactor

## Decision

**No table or column has been proven safe to drop. No database migration or hosted database change is part of this refactor.**

The web app and Mac app share a Supabase schema. The base schema lives in `../pro/supabase/migrations/`; this repository contains additive website/shared-backend migrations. This review inspected both migration histories and the existing Clerk bridge source, not production user data or the live database catalog. Absence from the web UI is not evidence that persisted data is unused.

## Tables retained

| Table | Current dependency |
| --- | --- |
| `planner_accounts` | Account provisioning, deletion, AI preferences, revision and event-time guards. |
| `planner_tasks` | Plans, estimates, focus timestamps, task history and completed-task statistics. |
| `planner_resources` | Mac resource metadata; also returned by task serialization and preserved in browser snapshots. |
| `planner_stops` | Pause reasons and the evidence behind weekly review patterns. |
| `planner_reviews` | Saved weekly reports and report history. |
| `planner_receipts` | Idempotency: retrying an ambiguously acknowledged queued mutation must not apply it twice. |
| `ai_controls` | Server-side AI availability, development-mode controls and bounded usage budgets. |
| `ai_usage` | Daily/monthly aggregate request limits used by scheduled reviews and Mac previews. |
| `ai_review_requests` | Scheduled generation, per-account quotas, request leases, preference revisions and retention. |
| `ai_review_previews` | Mac preview quotas and leases. The website has no preview UI, but the shared backend still implements it. |
| `planner_clerk_identities` | Dropped, with `planner_call_as`, by `20261105000200_drop_clerk_bridge.sql` once the Clerk transport was removed. The migration refuses to run while any mapping remains. |

## Fields that may look redundant

- **`planner_tasks.is_priority` / API `isPriority`:** not used to rank tasks on the website, but used by Mac clients, legacy commands, task serialization and acknowledgement validation. Retain until a coordinated shared-protocol migration retires them.
- **`planner_tasks.slot`:** implements the unique per-day task positions and three-task limit. It is not just a presentation preference.
- **Resource labels, targets and kinds:** intentionally inert on the web, not unused on the Mac. Removing resource controls/helpers/styles does not authorize deleting the underlying metadata.
- **`consent_version`, `consent_recorded_at`, AI/consent revision fields:** legacy naming does not make these removable. Existing review reservation and completion functions use the version/revision gates; other clients still write the preference metadata. These fields are not evidence of affirmative legal consent.
- **`revision`, `last_event_at`, receipt inputs/results:** required by ordered outbox replay, clock validation, conflict detection and exactly-once mutation identities.
- **`"isDeleted"`, `deleted_at`:** enforce immediate account access denial and the manual 30-day removal policy. Never replace this process with a schema cleanup.
- **AI request activity/analysis/model fields:** some content is transient or copied into saved reviews, but it participates in generation and retention functions. Dropping it would require replacing those functions and auditing the Mac/Edge Function deployment together.
- **API `canPlanTomorrow`:** a shared response/projection field, not a newly introduced table column. The web UI no longer gates tomorrow planning on it; preserving it keeps saved snapshots and older clients compatible.

## Cleanup completed without touching user data

Removed the website's unused resource mutation methods and resource URL helper, unused manual-preview client method, legacy imperative UI/mount adapters, resource/preview/onboarding styles for retired screens, and unreferenced public artwork/font assets. Durable queue replay still supports legacy priority/resource/pause commands: a command already saved on someone's device is not dead code.

## Requirements before any future destructive migration

1. Inspect the hosted catalog, function bodies, grants, policies, indexes and retention jobs using operator-approved read-only access.
2. Audit every supported Mac/web client, Edge Function, pending outbox version and administrative integration.
3. First deploy a compatible replacement protocol and migrate existing rows; verify cross-device and rollback behavior.
4. Back up data and apply a separately reviewed, forward-only migration through the shared backend's deployment history.

Do not reset the database, rewrite migration history, drop columns with `CASCADE`, or infer that a table is disposable merely because the website does not render it.
