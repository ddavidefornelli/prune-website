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
import { analytics } from "../../analytics.ts";
import type { WeeklyReviewState } from "../../reviews/weekly-review-state";
import { CalendarDay } from "../../shared/calendar-day";
import { Duration } from "../../shared/duration";
import { TIME } from "../../shared/time-constants";
import type { PlanningClient } from "../api";
import {
  COUNT_WORDS,
  HINT_RULES,
  MEDIA_QUERIES,
  PLANNER_LIMITS,
} from "../constants";
import { DayPlan } from "../day-plan";
import { Estimate } from "../estimate";
import type { HintBook } from "../hints";
import type { Insight } from "../insights";
import type { PlannerState } from "../planner-state";
import { DoneBadge } from "./DoneBadge";
import { EstimateDial } from "./EstimateDial";
import { InsightDrop } from "./InsightDrop";
import { TaskForm } from "./TaskForm";
import { TaskTitle } from "./TaskTitle";

/** Joins summary phrases so a narrow screen breaks the line only between them. */
const phrases = (...parts: string[]) =>
  parts.map((part) => part.replace(/ /g, "\u00a0")).join("\u00a0· ");

export function PlanView(props: {
  planner: PlannerState;
  client: PlanningClient;
  hints: HintBook;
  firstRun: boolean;
  onShortcuts: () => void;
  /** The weekly check-in: Today's meter, and the plan both days follow. */
  review?: WeeklyReviewState;
  /** Today only: a fact about the owner's habits, dropped by a finished task. */
  insight?: Insight | null;
  onDismissInsight?: () => void;
  /** Today only: a check-in that just landed. */
  checkInReady?: boolean;
  onDismissCheckIn?: () => void;
}) {
  const planner = untrack(() => props.planner);
  const tomorrow = () => planner.view() === "tomorrow";
  const tasks = () =>
    (tomorrow() ? planner.data()?.tomorrowTasks : planner.data()?.todayTasks) ??
    [];
  const day = () =>
    (tomorrow() ? planner.data()?.tomorrow : planner.data()?.today) ?? "";
  const summary = createMemo(() => new DayPlan(tasks()).summary(planner.now()));
  const desktop = window.matchMedia(MEDIA_QUERIES.desktop).matches;
  const completedTotal = () =>
    planner.data()?.completions.reduce((sum, entry) => sum + entry.count, 0) ??
    0;
  const everCompleted = () => completedTotal() > 0;
  const yesterdayCount = () => {
    const data = planner.data();
    if (!data) return 0;
    const yesterday = CalendarDay.parse(data.today).previous().key;
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
      completedTotal() <= HINT_RULES.progressMaxCompleted &&
      data.todayTasks.some((task) => task.status === "completed") &&
      !props.hints.seen("progress")
    )
      return "progress";
    if (nextTaskId() && !everCompleted() && !props.hints.seen("start"))
      return "start";
    if (
      new Date(planner.now() * TIME.msPerSecond).getHours() >=
        HINT_RULES.eveningHour &&
      !planner.todayComplete() &&
      !data.tomorrowTasks.length &&
      !props.hints.seen(eveningId())
    )
      return "evening";
    return null;
  });
  const showShortcutHint = () =>
    desktop &&
    props.hints.visits >= HINT_RULES.shortcutsAfterVisits &&
    !props.hints.seen("shortcuts");
  const create = async (outcome: string, minutes: number): Promise<boolean> => {
    const created = await planner.mutate(() =>
      props.client.create(outcome, day(), minutes),
    );
    if (created)
      analytics.capture("task_created", {
        day: tomorrow() ? "tomorrow" : "today",
        estimated_minutes: minutes,
      });
    return created;
  };
  // The plan from the last check-in: a soft daily target under the hard cap,
  // and the estimate new tasks start at.
  const plan = () => props.review?.data()?.checkIn?.plan ?? null;
  const target = () => plan()?.dailyTarget ?? PLANNER_LIMITS.tasksPerDay;
  const targetWord = () => COUNT_WORDS[target() - 1] ?? COUNT_WORDS.at(-1);
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
            Pick tomorrow&rsquo;s <em>{targetWord()}</em>.
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
          {yesterday} down yesterday. Today&rsquo;s <em>{targetWord()}</em>?
        </>
      ) : (
        <>
          Pick today&rsquo;s <em>{targetWord()}</em>.
        </>
      );
    }
    if (tomorrow())
      return phrases(
        `${tasks().length} of ${target()} planned`,
        `${new Duration(remainingSeconds).rounded()} of focus`,
      );
    if (finishAt === null)
      return phrases(
        "All done",
        `${new Duration(focusedSeconds).rounded()} focused`,
      );
    return phrases(
      `${completed} of ${tasks().length} done`,
      `${new Duration(remainingSeconds).rounded()} left`,
      `finish around ${Duration.timeOfDay(finishAt)}`,
    );
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
                  "is-extra": index >= target(),
                }}
              />
            )}
          </Index>
        </ol>
      </header>
      <Show when={!tomorrow() && props.checkInReady}>
        <aside class="review-unlocked" role="status">
          <p>
            <strong>Weekly check-in</strong>
            Your trends and next week&rsquo;s plan are ready.
          </p>
          <button
            type="button"
            class="primary-button"
            onClick={() => planner.visit("habits")}
          >
            Open it
          </button>
          <button
            type="button"
            class="text-button"
            onClick={() => props.onDismissCheckIn?.()}
          >
            Later
          </button>
        </aside>
      </Show>
      <Show when={!tomorrow() && props.insight} keyed>
        {(insight) => (
          <InsightDrop
            insight={insight}
            onDismiss={() => props.onDismissInsight?.()}
          />
        )}
      </Show>
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
                      ? `${new Duration(task.actualSeconds).clock()} · completed`
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
                    // The dial rolls back when this resolves to false, so the
                    // save result must be passed through.
                    planner
                      .mutate(() =>
                        props.client.changeEstimate(task.id, minutes),
                      )
                      .then((changed) => {
                        if (changed)
                          analytics.capture("task_estimate_changed", {
                            estimated_minutes: minutes,
                          });
                        return changed;
                      })
                  }
                />
              </Show>
              <Show when={!tomorrow() && task.status === "planned"}>
                <button
                  type="button"
                  disabled={planner.busy() || !!planner.data()?.activeTask}
                  onClick={() => {
                    props.hints.dismiss("start");
                    void planner
                      .mutate(async () => {
                        await props.client.start(task.id);
                        planner.visit("focus");
                      })
                      .then((started) => {
                        if (started)
                          analytics.capture("focus_started", {
                            estimated_minutes: task.estimatedMinutes,
                          });
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
          class="open-slots"
          aria-label={`Suggested from ${tomorrow() ? "today" : "yesterday"}`}
        >
          <For each={suggestions()}>
            {(item) => (
              <div class="open-slot">
                <span class="open-slot-label">Open slot</span>
                <button
                  type="button"
                  class="slot-suggestion"
                  disabled={planner.busy()}
                  onClick={() =>
                    void create(item.outcome, item.estimatedMinutes)
                  }
                >
                  <small>
                    {item.basis === "carry_over" ? "Carry over" : "Follow up"}{" "}
                    from {tomorrow() ? "today" : "yesterday"}
                  </small>
                  <span>
                    {item.outcome}
                    <span class="slot-suggestion-minutes">
                      {" "}
                      · {item.estimatedMinutes} min
                    </span>
                  </span>
                </button>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={openSlots() > 0}>
        <TaskForm
          busy={planner.busy()}
          autofocus={firstPlan() && desktop}
          defaultMinutes={Estimate.forFactor(plan()?.estimateFactor)}
          onCreate={create}
        />
      </Show>
      <Show when={firstPlan()}>
        <section class="starters" aria-label="First task">
          <p class="muted">
            What’s the most important thing you have to do today? Start with
            that. Add a time like <q>45m</q> to set the estimate.
          </p>
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
              <p class="evening-note">Lock in five before today fades.</p>
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
