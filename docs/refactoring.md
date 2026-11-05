# Refactoring boundaries

## Responsibilities

- **UI components** render and collect input. Small Solid state factories own reactive state and lifecycle cleanup; they are not classes because Solid tracks accessors and ownership, not class property mutation.
- **`createSession`** restores a saved session or completes a Google redirect once at startup, and ignores late responses after disposal. `Session.tsx` renders loading, sign-in or the planner; `App.tsx` only selects the route and error boundary.
- **`PlanningClient`** coordinates authenticated access, typed RPC queries and task mutations. Queries are never mistaken for outbox writes. The constructor takes named options (`{ cloud }`).
- **`BrowserCloud` / `api-fetch.ts`** separate Supabase authentication from bounded HTTP I/O.
- **`createAccountQueue`** supplies browser locks, account-scoped storage keys, online/storage listeners and queue-protocol negotiation.
- **`LocalQueue`** owns atomic snapshot/outbox persistence, serialized sends, acknowledgement validation, conflicts and retry backoff.
- **`task-projection.ts` / `dashboard.ts`** contain rendering-independent mutation replay, task selection and day rollover. The authenticated outbox uses them.
- **`server/http.ts`** owns safe API errors and bounded request/response reads. Gateway code no longer imports HTTP primitives from the AI provider implementation.

## Shared contracts and constants

`commands.ts` defines allowed task action names, arguments, RPC results and the persisted command envelope. Domain types come from `types.ts`, not through client implementation re-exports. UI/domain bounds remain in `constants.ts`; exact backend paths and browser HTTP limits live in `shared/api-routes.ts`. CSP generation derives its backend allowlist from those same paths. Server review types, bounds, consent version and model metadata reuse existing definitions rather than maintaining divergent copies.

Classes are used for stateful storage/network clients. Pure projections, formatting, date arithmetic and Solid lifecycle helpers remain functions. Avoid adding an abstraction solely to wrap an existing standard-library function.

## Removed or reduced

- Guest mode (`GuestStore`, guest import and usage counters), the onboarding survey, and email-code sign-in. Google is the only sign-in, and only `/?oauth=google` callbacks complete.
- Implementation-module type re-exports and private component helper exports.
- Duplicate task-selection, day-rollover, error-code inspection, queue-stop recovery and retry scheduling logic.
- Redundant loading branches and the nested session-rendering tree.
- Duplicate sign-out/deletion UI orchestration and verbose DOM-reference assignment callbacks. Confirmation wording, busy guards, failure reporting and reload behavior remain unchanged.
- Clock-driven profile-history recomputation: live focus totals now read only today's plan. History totals are accumulated in one pass, and streaks walk consecutive runs without sorting.
- Retired account-bar/privacy-warning CSS, overridden layout declarations, and the unreferenced `public/prune-logo.png` asset. A temporary before/after browser audit compared rendered styles for Today, Tomorrow, Overview, Profile, Focus and the pause dialog at seven widths in Chromium and WebKit. The navigation now clips its moving selection background to prevent transient horizontal overflow when resizing from desktop to phone widths.
- Stale browser expectations for signup-first navigation, a retired logo/header, the old sign-in button label and direct Profile navigation. Shared fixtures use an explicit optional-analytics opt-out so the cookie banner cannot intercept unrelated workflow clicks; dedicated cookie tests still exercise real first-visit consent behavior.

## Intentionally retained

- All storage keys, storage versions, request identities, account isolation and atomic persistence rules. There is no storage reset or data migration.
- The dashboard's time-independent signature guard. Benchmarking showed that unconditionally reconciling unchanged history is slower; a shorter implementation would not be an optimization here.
- Legacy priority/resource/pause projection commands: existing saved outboxes may still contain them.
- Mac-only resource metadata and shared response fields such as `isPriority` and `canPlanTomorrow`.
- All database migrations and account deletion/retention semantics. See [the database review](database-review.md).

## Checks

`npm run check` now lints and checks formatting for `src` and `server`. TypeScript already covers those directories plus scripts and tests. Unit tests cover the extracted HTTP/projection modules, unordered/duplicate completion history and single-read guest mutations; Solid lifecycle tests cover session races, client disposal, protocol negotiation, deletion recovery, account-action confirmations and guest network isolation. Playwright also verifies that profile clock ticks do not reparse completion history. It exercises the production artifact against local intercepted fixtures, not hosted accounts or paid services.
