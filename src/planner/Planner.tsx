import {
  createEffect,
  createSignal,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import PixelBackground from "../components/PixelBackground";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { Profile } from "../profile/Profile";
import { createWeeklyReview } from "../reviews/create-weekly-review";
import type { PlanningClient } from "./api";
import { FocusView } from "./components/FocusView";
import { Overview } from "./components/Overview";
import { PlanView } from "./components/PlanView";
import { PlannerNavigation } from "./components/PlannerNavigation";
import { PlannerTour } from "./components/PlannerTour";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { VIEW_LABELS } from "./constants";
import { createPlanner } from "./create-planner";
import { createHints } from "./hints";
import { onboardingKey, shouldOfferOnboarding } from "./onboarding";
import { createShortcuts } from "./shortcuts";
import type { Account } from "./types";

export function Planner(props: { client: PlanningClient; account: Account }) {
  const client = untrack(() => props.client);
  const planner = createPlanner(client);
  const review = createWeeklyReview(client, () => planner.view() === "habits");
  const hints = createHints(untrack(() => props.account.accountKey));
  const [firstRun, setFirstRun] = createSignal(false);
  const [shortcuts, setShortcuts] = createSignal(false);
  const [tour, setTour] = createSignal(false);
  let firstRunChecked = false;
  let previousView = planner.view();
  createShortcuts(planner, () => setShortcuts(true));

  function finishFirstRun(): void {
    if (!firstRun()) return;
    setFirstRun(false);
    try {
      localStorage.setItem(onboardingKey(props.account.accountKey), "done");
    } catch {
      /* The first plan does not depend on persistence. */
    }
  }

  /** The tour's last stop starts the first planned task, as its button would. */
  async function startFirstTask(): Promise<void> {
    const task = planner.data()?.todayTasks.find((t) => t.status === "planned");
    if (!task) return;
    hints.dismiss("start");
    const success = await planner.mutate(async () => {
      await client.start(task.id);
      planner.visit("focus");
    });
    if (!success) throw new Error(planner.error());
  }

  createEffect(() => {
    const data = planner.data();
    if (!data || firstRunChecked) return;
    firstRunChecked = true;
    setFirstRun(
      shouldOfferOnboarding(data, props.account.accountKey, localStorage),
    );
  });
  createEffect(() => {
    if (!firstRun() || !planner.data()?.todayTasks.length) return;
    finishFirstRun();
    setTour(true);
  });
  createEffect(() => {
    const view = planner.view();
    if (view !== previousView) window.scrollTo(0, 0);
    previousView = view;
  });

  return (
    <>
      <PixelBackground completionLevel={planner.completionLevel()} />
      <div
        id="app"
        data-view={planner.view()}
        data-completion-level={planner.completionLevel()}
        data-focus-running={planner.focusLocked() ? "" : undefined}
      >
        <PlannerNavigation planner={planner} />
        <div class="sync-bar" hidden={!planner.syncBlocked()}>
          <span role="alert">
            {planner.syncBlocked()
              ? "Some recent changes could not be applied. They are kept on this device until you discard them."
              : ""}
          </span>
          <button
            type="button"
            disabled={planner.busy()}
            onClick={() => {
              void planner.discardPending();
            }}
          >
            Discard rejected changes
          </button>
        </div>
        <p class="error" role="alert" hidden={!planner.error()}>
          {planner.error()}
        </p>
        <main id="planner-content" aria-label={VIEW_LABELS[planner.view()]}>
          <Show
            when={planner.data()}
            fallback={
              <Show when={planner.error()} fallback={<LoadingIndicator />}>
                <button
                  type="button"
                  onClick={() => {
                    void planner.refresh();
                  }}
                >
                  Retry
                </button>
              </Show>
            }
          >
            <Switch>
              <Match when={planner.view() === "profile"}>
                <Profile email={props.account.email} planner={planner} />
              </Match>
              <Match when={planner.view() === "focus"}>
                <FocusView
                  planner={planner}
                  client={props.client}
                  hints={hints}
                />
              </Match>
              <Match when={planner.view() === "habits"}>
                <Overview planner={planner} review={review} />
              </Match>
              <Match
                when={
                  planner.view() === "today" || planner.view() === "tomorrow"
                }
              >
                <PlanView
                  planner={planner}
                  client={props.client}
                  hints={hints}
                  firstRun={firstRun()}
                  onShortcuts={() => setShortcuts(true)}
                />
              </Match>
            </Switch>
          </Show>
        </main>
        <Show when={tour()}>
          <PlannerTour
            onVisit={planner.visit}
            onDone={(started) => {
              setTour(false);
              if (!started) planner.visit("today");
            }}
            onStart={startFirstTask}
          />
        </Show>
        <Show when={shortcuts()}>
          <ShortcutSheet onDismiss={() => setShortcuts(false)} />
        </Show>
      </div>
    </>
  );
}
