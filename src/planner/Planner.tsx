import {
  createEffect,
  createResource,
  createSignal,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { Profile } from "../profile/Profile";
import { createWeeklyReview } from "../reviews/create-weekly-review";
import type { PlanningClient } from "./api";
import { FocusView } from "./components/FocusView";
import { Overview } from "./components/Overview";
import { PlanView } from "./components/PlanView";
import { PlannerNavigation } from "./components/PlannerNavigation";
import { ONBOARDING, PlannerTour } from "./components/PlannerTour";
import { FirstTaskDialog } from "./components/FirstTaskDialog";
import { FocusTimeDialog } from "./components/FocusTimeDialog";
import { takeStartLink } from "./deep-link";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { VIEW_LABELS } from "./constants";
import { createPlanner } from "./create-planner";
import { createHints } from "./hints";
import { completionInsight, type Insight } from "./insights";
import {
  onboardingKey,
  shouldOfferOnboarding,
  shouldOfferTour,
  tourKey,
} from "./onboarding";
import { createShortcuts } from "./shortcuts";
import type { Account, Task } from "./types";

export function Planner(props: { client: PlanningClient; account: Account }) {
  const client = untrack(() => props.client);
  const planner = createPlanner(client);
  const review = createWeeklyReview(client, () => planner.view() === "habits");
  const hints = createHints(untrack(() => props.account.accountKey));
  const [firstRun, setFirstRun] = createSignal(false);
  const [shortcuts, setShortcuts] = createSignal(false);
  const [tour, setTour] = createSignal(false);
  // Onboarding's step after the tour; the tour counts as seen once it is answered.
  const [firstTask, setFirstTask] = createSignal(false);
  const [insight, setInsight] = createSignal<Insight | null>(null);
  const [checkInReady, setCheckInReady] = createSignal(false);
  // The focus-time question; `onboarding` also offers to start right away.
  const [focusPicker, setFocusPicker] = createSignal<
    "onboarding" | "change" | null
  >(null);
  // Missing on an older backend: the focus-time features stay hidden.
  const [schedule, { mutate: setSchedule }] = createResource(() =>
    client.schedule().catch(() => null),
  );
  // A link from a reminder (/?start=next) opens the timer on the next task.
  const startLink = takeStartLink();
  const plannedToday = () =>
    planner.data()?.todayTasks.find((t) => t.status === "planned") ?? null;
  // A check-in that lands while the planner is open is announced on Today.
  let newestReview: number | null = null;
  createEffect(() => {
    const data = review.data();
    if (!data) return;
    const newest = data.reviews[0]?.generatedAt ?? 0;
    if (newestReview !== null && newest > newestReview) setCheckInReady(true);
    newestReview = newest;
  });
  createEffect(() => {
    if (planner.view() === "habits") setCheckInReady(false);
  });
  let firstRunChecked = false;
  let previousView = planner.view();
  createShortcuts(planner, () => setShortcuts(true));
  /** A finished task may drop a fact about the owner's own habits. */
  function taskCompleted(task: Task): void {
    const data = planner.data();
    if (!data) return;
    const dropped = completionInsight(
      localStorage,
      props.account.accountKey,
      task,
      data,
    );
    if (dropped) setInsight(dropped);
  }
  // An insight belongs to the moment after finishing, not to the next task.
  createEffect(() => {
    if (planner.view() === "focus") setInsight(null);
  });

  function finishFirstRun(): void {
    if (!firstRun()) return;
    setFirstRun(false);
    try {
      localStorage.setItem(onboardingKey(props.account.accountKey), "done");
    } catch {
      /* The first plan does not depend on persistence. */
    }
  }

  async function addFirstTask(
    outcome: string,
    minutes: number,
  ): Promise<boolean> {
    const today = planner.data()?.today;
    if (!today) return false;
    const added = await planner.mutate(() =>
      client.create(outcome, today, minutes),
    );
    if (added) endFirstTask();
    return added;
  }

  /** After the first task (or Later): remember the tour, then ask for the focus time. */
  function endFirstTask(): void {
    setFirstTask(false);
    finishTour();
    // Only with a backend that can save a focus time.
    if (schedule()) setFocusPicker("onboarding");
  }

  function finishTour(): void {
    setTour(false);
    try {
      localStorage.setItem(tourKey(props.account.accountKey), "done");
    } catch {
      /* It is simply offered again on the next load. */
    }
  }

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
    const account = props.account.accountKey;
    setFirstRun(shouldOfferOnboarding(data, account, localStorage));
    if (startLink) {
      if (data.activeTask) planner.visit("focus");
      else if (plannedToday()) {
        void startFirstTask().catch(() => planner.visit("today"));
        return;
      }
    }
    // Right after sign-in, once per account and device.
    setTour(shouldOfferTour(data, account, localStorage));
  });
  createEffect(() => {
    if (firstRun() && planner.data()?.todayTasks.length) finishFirstRun();
  });
  createEffect(() => {
    const view = planner.view();
    if (view !== previousView) window.scrollTo(0, 0);
    previousView = view;
  });

  return (
    <>
      <div
        id="app"
        data-view={planner.view()}
        data-completion-level={planner.completionLevel()}
        data-focus-running={planner.focusLocked() ? "" : undefined}
      >
        <PlannerNavigation planner={planner} />
        <div class="sync-bar" hidden={!planner.syncBlocked()}>
          <p role="alert">
            <Show when={planner.syncBlocked()}>
              <strong>A change couldn&rsquo;t be saved</strong>
              <span>
                {planner.syncBlockedReason() ??
                  "Your plan changed somewhere else."}{" "}
                Discard it to keep working from your saved plan.
              </span>
            </Show>
          </p>
          <button
            type="button"
            disabled={planner.busy()}
            onClick={() => {
              void planner.discardPending();
            }}
          >
            Discard change
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
                <Profile
                  email={props.account.email}
                  planner={planner}
                  client={props.client}
                />
              </Match>
              <Match when={planner.view() === "focus"}>
                <FocusView
                  planner={planner}
                  client={props.client}
                  hints={hints}
                  onCompleted={taskCompleted}
                />
              </Match>
              <Match when={planner.view() === "habits"}>
                <Overview
                  planner={planner}
                  client={props.client}
                  review={review}
                  schedule={schedule() ?? null}
                  onChangeFocusTime={() => setFocusPicker("change")}
                />
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
                  review={review}
                  insight={insight()}
                  onDismissInsight={() => setInsight(null)}
                  checkInReady={checkInReady()}
                  onDismissCheckIn={() => setCheckInReady(false)}
                />
              </Match>
            </Switch>
          </Show>
        </main>
        <Show when={tour()}>
          <PlannerTour
            onVisit={planner.visit}
            onFinish={() => {
              setTour(false);
              planner.visit("today");
              setFirstTask(true);
            }}
          />
        </Show>
        <Show when={firstTask()}>
          <FirstTaskDialog
            step={ONBOARDING.task}
            total={ONBOARDING.total}
            onAdd={addFirstTask}
            onLater={endFirstTask}
          />
        </Show>
        <Show when={focusPicker()} keyed>
          {(mode) => (
            <FocusTimeDialog
              client={props.client}
              schedule={schedule() ?? null}
              onboardingSteps={
                mode === "onboarding" ? ONBOARDING.total : undefined
              }
              onStartNow={
                mode === "onboarding" && plannedToday()
                  ? startFirstTask
                  : undefined
              }
              onSaved={(state) => setSchedule(state)}
              onClose={() => setFocusPicker(null)}
            />
          )}
        </Show>
        <Show when={shortcuts()}>
          <ShortcutSheet onDismiss={() => setShortcuts(false)} />
        </Show>
      </div>
    </>
  );
}
