import {
  createEffect,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { analytics } from "../analytics.ts";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { Profile } from "../profile/Profile";
import { WeeklyReviewState } from "../reviews/weekly-review-state";
import type { PlanningClient } from "./api";
import { FocusView } from "./components/FocusView";
import { Overview } from "./components/Overview";
import { PlanView } from "./components/PlanView";
import { PlannerNavigation } from "./components/PlannerNavigation";
import { ONBOARDING, PlannerTour } from "./components/PlannerTour";
import { FirstTaskDialog } from "./components/FirstTaskDialog";
import { FocusTimeDialog } from "./components/FocusTimeDialog";
import { StreakParty } from "./components/StreakParty";
import { Streak } from "./streak";
import { StartLink } from "./deep-link";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { PLANNER_TIMING, VIEW_LABELS } from "./constants";
import { DayPlan } from "./day-plan";
import { HintBook } from "./hints";
import { InsightDrops, type Insight } from "./insights";
import { FirstRun } from "./onboarding";
import { PlannerState } from "./planner-state";
import { KeyboardShortcuts } from "./shortcuts";
import type { Account, Task } from "./types";

export function Planner(props: { client: PlanningClient; account: Account }) {
  const client = untrack(() => props.client);
  const accountKey = untrack(() => props.account.accountKey);
  const planner = new PlannerState(client);
  const review = new WeeklyReviewState(
    client,
    () => planner.view() === "habits",
  );
  const hints = new HintBook(accountKey);
  const firstRunFlags = new FirstRun(localStorage, accountKey);
  const insightDrops = new InsightDrops(localStorage, accountKey);
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
  const startLink = StartLink.take();
  const plannedToday = () =>
    new DayPlan(planner.data()?.todayTasks ?? []).nextPlanned();
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
  // The streak party: today's streak lit up by a task finished here. A sync
  // from another device lights it quietly, so it never interrupts typing.
  const [party, setParty] = createSignal<Streak | null>(null);
  let litToday: { day: string; lit: boolean } | null = null;
  let completingAt = -Infinity;
  createEffect(() => {
    const data = planner.data();
    if (!data) return;
    const streak = Streak.of(data);
    const lit = streak.lit;
    const finishedHere =
      performance.now() - completingAt < PLANNER_TIMING.partyWindowMs;
    if (lit && litToday?.day === data.today && !litToday.lit && finishedHere) {
      completingAt = -Infinity;
      setParty(streak);
      analytics.capture("streak_lit", { days: streak.days });
    }
    litToday = { day: data.today, lit };
  });
  let firstRunChecked = false;
  let previousView = planner.view();
  new KeyboardShortcuts(planner, () => setShortcuts(true));
  /** A finished task may drop a fact about the owner's own habits. */
  function taskCompleted(task: Task): void {
    const data = planner.data();
    if (!data) return;
    const dropped = insightDrops.afterCompletion(task, data);
    if (dropped) setInsight(dropped);
  }
  // An insight belongs to the moment after finishing, not to the next task.
  createEffect(() => {
    if (planner.view() === "focus") setInsight(null);
  });

  function finishFirstRun(): void {
    if (!firstRun()) return;
    setFirstRun(false);
    firstRunFlags.finishOnboarding();
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
    if (added) {
      client.track("first_task_added", { minutes });
      endFirstTask();
    }
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
    firstRunFlags.finishTour();
  }

  async function startFirstTask(): Promise<void> {
    const task = plannedToday();
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
    const isNew = firstRunFlags.offersOnboarding(data);
    setFirstRun(isNew);
    client.track("planner_opened", {
      new_account: isNew,
      from: startLink ? "reminder" : "app",
      active_task: Boolean(data.activeTask),
      today_tasks: data.todayTasks.length,
    });
    if (startLink) {
      if (data.activeTask) planner.visit("focus");
      else if (plannedToday()) {
        void startFirstTask().catch(() => planner.visit("today"));
        return;
      }
    }
    // Right after sign-in, once per account and device.
    const showTour = firstRunFlags.offersTour(data);
    setTour(showTour);
    if (showTour) client.track("tour_shown");
  });
  // A planner left open in a tab or on the phone's home screen never reloads, so
  // coming back to it after a while also counts as opening it (from: "back").
  let hiddenSince = 0;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }
    if (
      hiddenSince &&
      Date.now() - hiddenSince >= PLANNER_TIMING.returnAfterMs
    ) {
      const data = untrack(planner.data);
      client.track("planner_opened", {
        new_account: false,
        from: "back",
        active_task: Boolean(data?.activeTask),
        today_tasks: data?.todayTasks.length ?? 0,
      });
    }
    hiddenSince = 0;
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() =>
    document.removeEventListener("visibilitychange", onVisibility),
  );
  // Journey history: what the owner was asked, and what went wrong on screen.
  createEffect((wasOpen: boolean) => {
    const mode = focusPicker();
    if (mode && !wasOpen) client.track("focus_time_shown", { mode });
    return Boolean(mode);
  }, false);
  createEffect((wasBlocked: boolean) => {
    const blocked = planner.syncBlocked();
    if (blocked && !wasBlocked) client.track("change_rejected");
    return blocked;
  }, false);
  createEffect((previous: string) => {
    const error = planner.error();
    if (error && error !== previous)
      client.track("error_shown", {
        view: untrack(planner.view),
        online: navigator.onLine,
      });
    return error;
  }, "");
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
                  onCompleting={() => (completingAt = performance.now())}
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
            onFinish={() => {
              setTour(false);
              client.track("tour_finished");
              planner.visit("today");
              setFirstTask(true);
              client.track("first_task_shown");
            }}
          />
        </Show>
        <Show when={firstTask()}>
          <FirstTaskDialog
            step={ONBOARDING.task}
            onAdd={addFirstTask}
            onLater={() => {
              client.track("first_task_later");
              endFirstTask();
            }}
          />
        </Show>
        <Show when={focusPicker()} keyed>
          {(mode) => (
            <FocusTimeDialog
              client={props.client}
              schedule={schedule() ?? null}
              onboarding={mode === "onboarding"}
              firstTask={
                mode === "onboarding" && plannedToday()
                  ? {
                      outcome: plannedToday()!.outcome,
                      minutes: plannedToday()!.estimatedMinutes,
                    }
                  : undefined
              }
              onStartNow={
                mode === "onboarding" && plannedToday()
                  ? startFirstTask
                  : undefined
              }
              onSaved={(state) => {
                setSchedule(state);
                client.track("focus_time_saved", {
                  mode,
                  minute: state.focusMinute ?? "none",
                  weekdays_only: state.weekdaysOnly,
                  push_devices: state.pushDevices,
                });
              }}
              onClose={() => {
                setFocusPicker(null);
                client.track("focus_time_closed", { mode });
              }}
            />
          )}
        </Show>
        <Show when={party()} keyed>
          {(streak) => (
            <StreakParty streak={streak} onClose={() => setParty(null)} />
          )}
        </Show>
        <Show when={shortcuts()}>
          <ShortcutSheet onDismiss={() => setShortcuts(false)} />
        </Show>
      </div>
    </>
  );
}
