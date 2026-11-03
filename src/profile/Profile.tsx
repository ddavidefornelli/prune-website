import { createMemo, For, Show, untrack } from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import { ActivityCalendar } from "../planner/components/ActivityCalendar";
import type { PlannerState } from "../planner/create-planner";
import { profileStats, todayFocusSeconds } from "./profile-stats";

function focusMinutes(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}

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
  guest?: boolean;
  planner: PlannerState;
}) {
  const planner = untrack(() => props.planner);
  const stats = createMemo(() => {
    const data = planner.data();
    return data ? profileStats(data) : null;
  });
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
                [
                  "Current streak",
                  `${value().currentStreak} ${value().currentStreak === 1 ? "day" : "days"}`,
                ],
                [
                  "Best streak",
                  `${value().bestStreak} ${value().bestStreak === 1 ? "day" : "days"}`,
                ],
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
                  focusMinutes(
                    todayFocusSeconds(planner.data()!, planner.now()),
                  ),
                ],
              ]}
            />
            <p class="muted">
              Today’s plan:{" "}
              {
                planner
                  .data()!
                  .todayTasks.filter((task) => task.status === "completed")
                  .length
              }
              /{planner.data()!.todayTasks.length} complete ·{" "}
              {focusMinutes(value().todayEstimatedMinutes * 60)} estimated
            </p>
            <ActivityCalendar
              today={planner.data()!.today}
              completions={planner.data()!.completions}
            />
          </>
        )}
      </Show>
      <div class="profile-links">
        <PrivacyPolicyButton />
        <button
          type="button"
          class="privacy-policy-button"
          onClick={() =>
            window.dispatchEvent(new Event("prune:preferences:open"))
          }
        >
          Cookie settings
        </button>
      </div>
      <Show when={!props.guest}>
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
            {planner.accountAction() === "signOut"
              ? "Signing out…"
              : "Sign out"}
          </button>
        </footer>
      </Show>
    </section>
  );
}
