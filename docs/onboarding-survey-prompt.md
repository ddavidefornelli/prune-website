# Build prompt: pre-sign-up survey → "Your focus plan" → Continue with Google

Paste everything below the line into a new Claude Code session in this repo.

---

## Goal

prune lets guests plan immediately at `/`. Task creation is up, but almost nobody signs up: guests already get the full planner, and the only sign-in sits behind **Overview → Sign in** with email one-time codes. Build a short survey flow that ends in a personal result the user has to sign in to keep, with **Continue with Google** as the only sign-in action at that point.

The pattern is copied from resumax.ai's `/welcome` flow (studied 2026-11-02): an intro screen, about 12 one-tap questions that address the user by first name, a progress bar ("step X / 16"), two "Did you know" interstitials, optional skippable steps, a "Building your plan…" checklist that echoes the answers back, a personal result, then a "Save your plan" screen that repeats the result above a single Continue with Google button.

## Before writing code

Read these first and follow their conventions (SolidJS signals/stores, one render root, no manual DOM building):

- `README.md` and `PRODUCTION_READINESS.md`
- `src/App.tsx`, `src/auth/SignIn.tsx`, `src/planner/browser.ts` (Supabase auth; it still completes `/?oauth=google` callbacks around line 132, but no UI starts Google sign-in)
- `src/planner/guest.ts`, `src/planner/guest-usage.ts`, `src/planner/onboarding.ts`, `src/planner/privacy-state.ts`
- `src/planner/components/PlanView.tsx` (hardcoded `STARTERS` at line 21)
- `server/task-suggestions/` (existing AI task suggestions)
- `tests/landing.spec.ts`, `tests/first-run.spec.ts`, `tests/guest.spec.ts`, `tests/no-trackers.test.mjs`, `tests/helpers/`

Ignore `src/planner/clerk-cloud.ts`. It is unused Clerk code.

The existing sign-in page (heading "DO LESS. ACHIEVE MORE.") is the entry point. Reuse its look and copy for the survey intro rather than inventing a new style.

## The flow

1. **Intro**: reuse the sign-in page's hero. Copy idea: "A few quick questions, then you'll get a focus plan built for you. About 1 minute, no account needed yet." Button: **Start**. Also show a quiet "Skip, just let me plan" link that opens the guest planner exactly as today.
2. **Name**: "First, what should we call you?" (first name only). Use it in later questions.
3. **Goal**: "{name}, what are you here to do?" Ship a project / Study / Stop procrastinating / Run my business / Just exploring
4. **Role**: "What do you do?" Student / Engineer / Designer or creative / Founder / Other
5. **Focus window**: "When do you focus best?" Morning / Afternoon / Evening / It varies
6. **Focus length**: "How long can you focus before you drift?" 15 / 30 / 60 / 90+ min
7. **Interstitial "Did you know"**: one big number plus one line. Use only a stat with a real, citable source, and put the source in a code comment. If none is verified, use a product truth instead ("3 tasks. That's the whole rule.").
8. **Derailer**: "{name}, what derails you most?" My phone / Too many tasks / Not knowing where to start / Interruptions
9. **Deep work target**: "How many hours of deep work do you want each day?" 1 / 2 / 3 / 4+
10. **Week outcome** (free text, skippable): "One outcome you want this week?" This becomes the weekly AI review's goal.
11. **Building your plan…**: a short checklist animation that echoes real answers ("matching 60-minute blocks to your mornings"). It must reflect what the code actually computes. Keep it under 3 s.
12. **Your focus plan** (result):
    - 3 starter tasks with estimates, chosen from goal + role + focus length + derailer
    - Best focus window ("Mornings, 60-minute blocks")
    - Week goal (if given)
    - Button: **Save my plan →**
13. **Save your plan**: repeats the plan summary in a card, with a single **Continue with Google** button and the privacy-notice line. Secondary, small: "Use email instead" (the existing code flow) and "Not now, start planning" (guest mode with the plan's tasks already added).

Every question screen needs a back button and a progress bar. Single-choice answers move on automatically when tapped; multi-field screens need a Continue button. Make it phone-first and match the existing touch sizes and the 16px input rule.

## Making the rest of the app use the answers

- **Starters**: replace the hardcoded `STARTERS` with a pure function `startersFor(answers)` in its own module, with unit tests. With no answers, fall back to the current three starters.
- **Plan tasks**: on "Save my plan" or "Not now", add the 3 plan tasks to Today (guest journal or account), respecting the 3-task limit and existing tasks.
- **Weekly review**: store the week outcome and send it as context to the weekly AI review once the user is signed in. Check `server/` and the review preferences for where this fits. If it needs a server or DB change, add a migration under `supabase/migrations/` and document it in the README the same way the existing migrations are documented.
- **Focus length** sets the default estimate for new tasks.

## Storage and privacy

- Before sign-in, keep the answers only in browser storage next to the guest data (a new versioned key, e.g. `prune:survey:v1`), wrapped in try/catch like the existing storage code. Send nothing to Supabase or the server before sign-in.
- After sign-in, transfer the answers along with the existing guest import (`supabase/migrations/20261028000100_guest_import.sql` flow). Don't add a second, separate import path.
- The privacy-notice acknowledgment in `privacy-state.ts` must still be given before any sign-in. Fold it into the Google screen (an unchecked checkbox, as today, or explicit "By continuing you accept…" copy, whichever matches the current rules), and update `PRIVACY.md` and the in-app notice for: the survey data, what is stored, and Google as a sign-in provider.
- Don't add new trackers. `tests/no-trackers.test.mjs` must keep passing.

## Google sign-in

- Add a `sign_in_with_google` action in `src/planner/browser.ts` using Supabase `signInWithOAuth({ provider: 'google', options: { redirectTo: <origin>/?oauth=google } })`, reusing the existing callback handling.
- If the Google provider is not enabled in the Supabase project, the button must fail with a clear message, not a silent redirect loop. Note in the README that the operator has to enable Google in the Supabase dashboard and add the redirect URL.
- `tests/landing.spec.ts` currently asserts there is **no** Google button. Update it on purpose and say so in the commit message.

## Rollout and measurement

- Put the whole flow behind a feature flag (e.g. `VITE_SURVEY_FLOW=on|off|split`). With `split`, assign 50/50 per browser, and persist the assignment.
- Add anonymous funnel counters to the existing guest-usage counting (`guest-usage.ts` / `guest_record_usage`), not a new tool: survey started, finished, plan shown, Google clicked, signed up, skipped. Include the variant. No personal answers in the counters.
- Default the flag to `off`, so merging changes nothing until it is turned on.

## Done means

- `npm run check` and `npm test` pass, with new Playwright specs for: the full survey → plan → Google button (mock the OAuth redirect), skip → guest planner, "Not now" adds the plan tasks, back navigation, a mobile viewport, and flag `off` matching today's behavior.
- Unit tests for `startersFor` and the survey state.
- Verified in the browser preview at phone and desktop width, light and dark.
- README updated: the flag, the Google provider setup, the storage key.
- Work on a branch off `dev`, in small commits. Don't push or open a PR until I ask.

## Don't

- Don't block the guest planner. A "Skip" path must always exist.
- Don't invent statistics or fake "AI is analyzing" steps that don't match the code.
- Don't touch the Mac app (`../pro`) or reset or migrate any data destructively.
