import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import PixelBackground from "../components/PixelBackground";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { Profile } from "../profile/Profile";
import { createWeeklyReview } from "../reviews/create-weekly-review";
import {
  buildPlan,
  readSurvey,
  tasksToAdd,
  updateSurvey,
} from "../survey/model";
import type { PlanningClient } from "./api";
import { FocusView } from "./components/FocusView";
import { Overview } from "./components/Overview";
import { PlanView } from "./components/PlanView";
import { PlannerNavigation } from "./components/PlannerNavigation";
import { PlannerTour } from "./components/PlannerTour";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { RESUME_VIEW_KEY, VIEW_LABELS, type PlannerView } from "./constants";
import { createPlanner } from "./create-planner";
import { createHints } from "./hints";
import { onboardingKey, shouldOfferOnboarding } from "./onboarding";
import { createShortcuts } from "./shortcuts";
import { focusBlockMinutes, startersFor } from "./starters";
import type { Account, Dashboard } from "./types";

export function Planner(props: {
  client: PlanningClient;
  account: Account;
  guest?: boolean;
  onSaveAndSync?: () => void;
}) {
  const client = untrack(() => props.client);
  const planner = createPlanner(client);
  const review = createWeeklyReview(
    client,
    () => !props.guest && planner.view() === "habits",
  );
  const hints = createHints(untrack(() => props.account.accountKey));
  // Survey answers stay on this device and personalize its first plan.
  const answers = readSurvey(localStorage).answers;
  const starters = startersFor(answers);
  const defaultMinutes = focusBlockMinutes(answers.focusMinutes);
  const [firstRun, setFirstRun] = createSignal(false);
  const [shortcuts, setShortcuts] = createSignal(false);
  const [tour, setTour] = createSignal(false);
  const [welcome, setWelcome] = createSignal("");
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

  function saveAndSync(): void {
    try {
      sessionStorage.setItem(RESUME_VIEW_KEY, planner.view());
    } catch {
      /* Signing in still works; it just opens on Today. */
    }
    props.onSaveAndSync?.();
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

  /** A plan kept from the survey lands in Today once, guest or account. */
  async function addKeptPlan(data: Dashboard): Promise<void> {
    const survey = readSurvey(localStorage);
    if (survey.plan !== "pending") return;
    // Claim it first, so a reload or a second tab cannot add it twice.
    updateSurvey(localStorage, (state) => ({ ...state, plan: "applied" }));
    const tasks = tasksToAdd(buildPlan(survey.answers).tasks, data.todayTasks);
    if (!tasks.length) return;
    const today = data.today;
    const success = await planner.mutate(async () => {
      for (const task of tasks)
        await client.create(task.outcome, today, task.minutes);
    });
    if (success) setTour(true);
  }

  onMount(() => {
    if (props.guest) return;
    let resume: string | null;
    try {
      resume = sessionStorage.getItem(RESUME_VIEW_KEY);
      sessionStorage.removeItem(RESUME_VIEW_KEY);
    } catch {
      return;
    }
    if (resume === null) return;
    if (resume in VIEW_LABELS) planner.visit(resume as PlannerView);
    setWelcome("Signed in. Your plan now syncs across your devices.");
    const timer = setTimeout(() => setWelcome(""), 5000);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const data = planner.data();
    if (!data || firstRunChecked) return;
    firstRunChecked = true;
    // A kept survey plan fills Today instead of the first-run prompt.
    const keptPlan = readSurvey(localStorage).plan === "pending";
    setFirstRun(
      !keptPlan &&
        shouldOfferOnboarding(data, props.account.accountKey, localStorage),
    );
    if (keptPlan) untrack(() => void addKeptPlan(data));
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
                <Profile
                  email={props.account.email}
                  planner={planner}
                  guest={props.guest}
                />
              </Match>
              <Match when={planner.view() === "focus"}>
                <FocusView
                  planner={planner}
                  client={props.client}
                  hints={hints}
                />
              </Match>
              <Match when={planner.view() === "habits"}>
                <Overview
                  planner={planner}
                  review={review}
                  guest={props.guest}
                  onSignIn={saveAndSync}
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
                  starters={starters}
                  defaultMinutes={defaultMinutes}
                  guest={props.guest}
                  onSignIn={saveAndSync}
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
        <p class="toast" role="status" hidden={!welcome()}>
          {welcome()}
        </p>
      </div>
    </>
  );
}
