import { createMemo, For, Show, untrack } from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import type { PlanningClient } from "../planner/api";
import { ActivityCalendar } from "../planner/components/ActivityCalendar";
import { DayPlan } from "../planner/day-plan";
import type { PlannerState } from "../planner/planner-state";
import { Duration } from "../shared/duration";
import { APP_EVENTS } from "../shared/storage-keys";
import { Reminders } from "./Reminders";
import { ProfileStats } from "./profile-stats";

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function StatGrid(props: { metrics: readonly (readonly [string, string])[] }) {
  return (
    <dl class="profile-stats">
      <For each={props.metrics}>
        {([label, value]) => (
          <div class="profile-stat">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

export function Profile(props: {
  email: string;
  planner: PlannerState;
  client: PlanningClient;
}) {
  const planner = untrack(() => props.planner);
  const stats = createMemo(() => {
    const data = planner.data();
    return data ? new ProfileStats(data) : null;
  });
  // Live focus reads only today's plan, so the clock never rescans history.
  const today = createMemo(() => new DayPlan(planner.data()?.todayTasks ?? []));
  return (
    <section class="profile-page" aria-labelledby="profile-heading">
      <header class="profile-heading">
        <h1 id="profile-heading">Profile</h1>
        <p class="profile-email">{props.email}</p>
      </header>
      <Show when={stats()} fallback={<p class="muted">Stats unavailable.</p>}>
        {(value) => (
          <>
            <h2 class="profile-section-heading">All time</h2>
            <StatGrid
              metrics={[
                ["Tasks completed", value().totalCompleted.toLocaleString()],
                ["Active days", value().activeDays.toLocaleString()],
                ["Current streak", days(value().currentStreak)],
                ["Best streak", days(value().bestStreak)],
              ]}
            />
            <h2 class="profile-section-heading">Recent activity</h2>
            <StatGrid
              metrics={[
                ["Completed today", value().todayCompleted.toLocaleString()],
                ["Completed this week", value().weekCompleted.toLocaleString()],
                [
                  "Completed this month",
                  value().monthCompleted.toLocaleString(),
                ],
                [
                  "Today’s task focus",
                  new Duration(today().focusedSeconds(planner.now())).short(),
                ],
              ]}
            />
            <p class="muted">
              Today’s plan: {today().completedCount}/{today().tasks.length}{" "}
              complete ·{" "}
              {Duration.ofMinutes(value().todayEstimatedMinutes).short()}{" "}
              estimated
            </p>
            <ActivityCalendar
              today={planner.data()!.today}
              completions={planner.data()!.completions}
            />
          </>
        )}
      </Show>
      <Reminders client={props.client} />
      <div class="profile-links">
        <PrivacyPolicyButton />
        <button
          type="button"
          class="privacy-policy-button"
          onClick={() =>
            window.dispatchEvent(new Event(APP_EVENTS.openPrivacyPreferences))
          }
        >
          Cookie settings
        </button>
      </div>
      <footer class="profile-footer">
        <button
          type="button"
          class="delete-account-button"
          disabled={planner.busy()}
          onClick={() => {
            void planner.deleteAccount();
          }}
        >
          {planner.accountAction() === "delete"
            ? "Deleting account…"
            : "Delete account"}
        </button>
        <button
          type="button"
          class="danger-button"
          disabled={planner.busy()}
          onClick={() => {
            void planner.signOut();
          }}
        >
          {planner.accountAction() === "signOut" ? "Signing out…" : "Sign out"}
        </button>
      </footer>
    </section>
  );
}
