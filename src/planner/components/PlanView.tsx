import {
  createMemo,
  createResource,
  For,
  Index,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { PlanningClient } from "../api";
import { PLANNER_LIMITS } from "../constants";
import type { PlannerState } from "../create-planner";
import { formatClock, formatMinutes, summarizeDay } from "../quick-entry";
import type { Hints } from "../hints";
import { STARTERS } from "../starters";
import { formatDuration, previousDay } from "../time";
import { DoneBadge } from "./DoneBadge";
import { EstimateDial } from "./EstimateDial";
import { TaskForm } from "./TaskForm";
import { TaskTitle } from "./TaskTitle";

const DESKTOP_QUERY = "(hover: hover) and (min-width: 760px)";

export function PlanView(props: {
  planner: PlannerState;
  client: PlanningClient;
  hints: Hints;
  firstRun: boolean;
  onShortcuts: () => void;
}) {
  const planner = untrack(() => props.planner);
  const tomorrow = () => planner.view() === "tomorrow";
  const tasks = () =>
    (tomorrow() ? planner.data()?.tomorrowTasks : planner.data()?.todayTasks) ??
    [];
  const day = () =>
    (tomorrow() ? planner.data()?.tomorrow : planner.data()?.today) ?? "";
  const summary = createMemo(() => summarizeDay(tasks(), planner.now()));
  const desktop = window.matchMedia(DESKTOP_QUERY).matches;
  const completedTotal = () =>
    planner.data()?.completions.reduce((sum, entry) => sum + entry.count, 0) ??
    0;
  const everCompleted = () => completedTotal() > 0;
  const yesterdayCount = () => {
    const data = planner.data();
    if (!data) return 0;
    const yesterday = previousDay(data.today);
    return (
      data.completions.find((entry) => entry.day === yesterday)?.count ?? 0
    );
  };
  const nextTaskId = () =>
    tomorrow() || planner.data()?.activeTask
      ? null
      : (tasks().find((task) => task.status === "planned")?.id ?? null);
  const firstPlan = () => props.firstRun && !tomorrow() && !tasks().length;
  const eveningId = () => `evening:${planner.data()?.today}` as const;
  const hint = createMemo(() => {
    const data = planner.data();
    if (tomorrow() || !data) return null;
    if (
      completedTotal() > 0 &&
      completedTotal() <= 3 &&
      data.todayTasks.some((task) => task.status === "completed") &&
      !props.hints.seen("progress")
    )
      return "progress";
    if (nextTaskId() && !everCompleted() && !props.hints.seen("start"))
      return "start";
    if (
      new Date(planner.now() * 1000).getHours() >= 17 &&
      !planner.todayComplete() &&
      data.canPlanTomorrow &&
      !data.tomorrowTasks.length &&
      !props.hints.seen(eveningId())
    )
      return "evening";
    return null;
  });
  const showShortcutHint = () =>
    desktop && props.hints.visits() >= 3 && !props.hints.seen("shortcuts");
  const create = (outcome: string, minutes: number) =>
    planner.mutate(() => props.client.create(outcome, day(), minutes));
  const openSlots = () =>
    Math.max(0, PLANNER_LIMITS.tasksPerDay - tasks().length);
  // Tomorrow's proposals come from today's plan, so refresh them when it changes.
  const sourceVersion = () =>
    tomorrow()
      ? (planner.data()?.todayTasks ?? [])
          .map((task) => `${task.outcome}\u0000${task.status}`)
          .join("\u0001")
      : "";
  const suggestionKey = () =>
    day() ? `${planner.view()}|${day()}|${sourceVersion()}` : undefined;
  const [suggested] = createResource(suggestionKey, async (key) => ({
    key,
    items: await props.client.suggestTasks(
      tomorrow() ? "tomorrow" : "today",
      day(),
      sourceVersion(),
    ),
  }));
  const suggestions = () => {
    const loaded = suggested.latest;
    if (
      !loaded ||
      firstPlan() ||
      !openSlots() ||
      loaded.key !== suggestionKey()
    )
      return [];
    const planned = new Set(
      tasks().map((task) => task.outcome.trim().toLocaleLowerCase()),
    );
    return loaded.items
      .filter((item) => !planned.has(item.outcome.trim().toLocaleLowerCase()))
      .slice(0, openSlots());
  };
  const status = () => {
    const { completed, remainingSeconds, focusedSeconds, finishAt } = summary();
    if (!tasks().length) {
      if (tomorrow())
        return (
          <>
            Pick tomorrow&rsquo;s <em>three</em>.
          </>
        );
      if (firstPlan())
        return (
          <>
            What would make today <em>count</em>?
          </>
        );
      const yesterday = yesterdayCount();
      return yesterday ? (
        <>
          {yesterday} down yesterday. Today&rsquo;s <em>three</em>?
        </>
      ) : (
        <>
          Pick today&rsquo;s <em>three</em>.
        </>
      );
    }
    if (tomorrow())
      return `${tasks().length} of ${PLANNER_LIMITS.tasksPerDay} planned\u00a0· ${formatMinutes(remainingSeconds)} of focus`;
    if (finishAt === null)
      return `All done\u00a0· ${formatMinutes(focusedSeconds)} focused`;
    return `${completed} of ${tasks().length} done\u00a0· ${formatMinutes(remainingSeconds)} left\u00a0· finish around ${formatClock(finishAt)}`;
  };

  return (
    <>
      <header class="plan-heading">
        <p
          class="plan-summary"
          classList={{
            "is-first-plan": firstPlan(),
            "is-prompt": !tasks().length,
          }}
          aria-live="polite"
        >
          {status()}
        </p>
        <ol class="plan-slots" aria-hidden="true">
          <Index each={Array.from({ length: PLANNER_LIMITS.tasksPerDay })}>
            {(_, index) => (
              <li
                classList={{
                  "is-planned": index < tasks().length,
                  "is-done":
                    !tomorrow() && tasks()[index]?.status === "completed",
                  "is-active": tasks()[index]?.status === "active",
                }}
              />
            )}
          </Index>
        </ol>
      </header>
      <ul class="task-list">
        <For each={tasks()}>
          {(task) => (
            <li
              class="task"
              classList={{
                "is-completed": !tomorrow() && task.status === "completed",
                "is-next": task.id === nextTaskId(),
              }}
            >
              <div class="task-details">
                <Show when={task.id === nextTaskId()}>
                  <p class="up-next">Up next</p>
                </Show>
                <TaskTitle
                  task={task}
                  heading="h2"
                  editable={task.status === "planned"}
                  disabled={planner.busy()}
                  onRename={(outcome) =>
                    planner.mutate(() => props.client.rename(task.id, outcome))
                  }
                />
                <Show
                  when={
                    task.status !== "planned" &&
                    (tomorrow() || task.status !== "completed")
                  }
                >
                  <p class="muted">
                    {task.status === "completed"
                      ? `${formatDuration(task.actualSeconds)} · completed`
                      : `${task.estimatedMinutes} min estimated · ${task.status}`}
                  </p>
                </Show>
              </div>
              <Show when={!tomorrow() && task.status === "completed"}>
                <DoneBadge
                  actualSeconds={task.actualSeconds}
                  estimatedMinutes={task.estimatedMinutes}
                />
              </Show>
              <Show when={task.status === "planned"}>
                <EstimateDial
                  class="task-estimate"
                  value={task.estimatedMinutes}
                  disabled={planner.busy()}
                  onChange={(minutes) =>
                    planner.mutate(() =>
                      props.client.changeEstimate(task.id, minutes),
                    )
                  }
                />
              </Show>
              <Show when={!tomorrow() && task.status === "planned"}>
                <button
                  type="button"
                  disabled={planner.busy() || !!planner.data()?.activeTask}
                  onClick={() => {
                    props.hints.dismiss("start");
                    void planner.mutate(async () => {
                      await props.client.start(task.id);
                      planner.visit("focus");
                    });
                  }}
                >
                  Start focus
                </button>
              </Show>
              <Show when={task.status === "active"}>
                <button
                  type="button"
                  disabled={planner.busy()}
                  onClick={() => planner.visit("focus")}
                >
                  Return to focus
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={suggestions().length}>
        <section
          class="starters suggestions"
          aria-label={`Suggested from ${tomorrow() ? "today" : "yesterday"}`}
        >
          <p class="muted">From {tomorrow() ? "today" : "yesterday"}</p>
          <div class="starter-list">
            <For each={suggestions()}>
              {(item) => (
                <button
                  type="button"
                  disabled={planner.busy()}
                  onClick={() =>
                    void create(item.outcome, item.estimatedMinutes)
                  }
                >
                  <span>{item.outcome}</span>
                  <span class="muted">
                    {item.basis === "carry_over" ? "Unfinished · " : ""}
                    {item.estimatedMinutes} min
                  </span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
      <Show when={openSlots() > 0}>
        <TaskForm
          busy={planner.busy()}
          autofocus={firstPlan() && desktop}
          onCreate={create}
        />
      </Show>
      <Show when={firstPlan()}>
        <section class="starters" aria-label="Starting ideas">
          <p class="muted">
            Or start with one of these. When you write your own, add a time like{" "}
            <q>45m</q> to set the estimate.
          </p>
          <div class="starter-list">
            <For each={STARTERS}>
              {(starter) => (
                <button
                  type="button"
                  disabled={planner.busy()}
                  onClick={() => void create(starter.outcome, starter.minutes)}
                >
                  <span>{starter.outcome}</span>
                  <span class="muted">{starter.minutes} min</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
      <Switch>
        <Match when={hint() === "start"}>
          <aside class="hint-card" aria-label="Tip">
            <p>
              Start when you’re ready.{" "}
              {desktop
                ? "Press Space to pause, and write a line about why."
                : "Tap the timer to pause."}
            </p>
            <button type="button" onClick={() => props.hints.dismiss("start")}>
              Got it
            </button>
          </aside>
        </Match>
        <Match when={hint() === "progress"}>
          <aside class="hint-card" aria-label="Tip">
            <p>Nice work. Your streak and AI reviews live in Overview.</p>
            <button
              type="button"
              class="primary-button"
              onClick={() => {
                props.hints.dismiss("progress");
                planner.visit("habits");
              }}
            >
              Open Overview
            </button>
            <button
              type="button"
              onClick={() => props.hints.dismiss("progress")}
            >
              Got it
            </button>
          </aside>
        </Match>
        <Match when={hint() === "evening"}>
          <aside class="hint-card evening-card" aria-label="Evening planning">
            <div class="evening-copy">
              <p class="evening-eyebrow">After hours</p>
              <p class="evening-title">
                Tomorrow&rsquo;s still <em>blank</em>.
              </p>
              <p class="evening-note">Lock in three before today fades.</p>
            </div>
            <div class="evening-actions">
              <button
                type="button"
                class="evening-primary"
                onClick={() => planner.visit("tomorrow")}
              >
                Plan tomorrow
              </button>
              <button
                type="button"
                class="text-button"
                onClick={() => props.hints.dismiss(eveningId())}
              >
                Not tonight
              </button>
            </div>
          </aside>
        </Match>
      </Switch>
      <Show when={showShortcutHint()}>
        <p class="shortcut-hint">
          <button
            type="button"
            class="text-button"
            onClick={() => props.onShortcuts()}
          >
            Press <kbd>?</kbd> for keyboard shortcuts
          </button>
          <button
            type="button"
            class="text-button"
            aria-label="Hide shortcut tip"
            onClick={() => props.hints.dismiss("shortcuts")}
          >
            ×
          </button>
        </p>
      </Show>
    </>
  );
}
