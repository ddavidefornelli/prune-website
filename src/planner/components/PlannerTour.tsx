import {
  createEffect,
  For,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import type { PlannerView } from "../constants";
import { errorMessage } from "../errors";
import { ESTIMATE } from "../constants";
import { parseQuickEntry } from "../quick-entry";
import { STARTERS } from "../starters";

export type TourView = Exclude<PlannerView, "profile" | "focus">;

interface Stop {
  view: TourView;
  target: string;
  title: string;
  text: string;
}

/** Why finishing tasks matters, shown from the first visit. */
const REVIEW: Stop = {
  view: "today",
  target: ".review-meter",
  title: "Finish 10, get an AI review",
  text: "Every 10 tasks you complete, AI reviews what slowed you down and what to try next. This bar counts them.",
};

const AROUND: readonly Stop[] = [
  {
    view: "tomorrow",
    target: "nav button[aria-current]",
    title: "Plan ahead",
    text: "Add tomorrow’s tasks here.",
  },
  {
    view: "habits",
    target: "nav button[aria-current]",
    title: "See your progress",
    text: "Your activity and AI reviews live here.",
  },
];

/** With a planned task: point at it, then end by starting its timer. */
const WITH_TASK: readonly Stop[] = [
  {
    view: "today",
    target: ".task .editable-title",
    title: "Your task is here",
    text: "Tap the title to edit it. Keep today to three tasks.",
  },
  {
    view: "today",
    target: ".task .task-estimate",
    title: "Adjust your estimate",
    text: "Turn this dial to change the minutes.",
  },
  REVIEW,
  ...AROUND,
  {
    view: "today",
    target: ".task > button",
    title: "Ready to focus?",
    text: "Start your task’s timer when you’re ready. You can pause anytime.",
  },
];

/** A new, empty planner: explain the rule, then require the first task. */
const EMPTY: readonly Stop[] = [
  {
    view: "today",
    target: ".plan-heading",
    title: "Three tasks a day",
    text: "That’s the whole rule. Fewer tasks, more focus.",
  },
  REVIEW,
  ...AROUND,
  {
    view: "today",
    // The form is inside the popup; highlight the plan it fills, not a second form.
    target: ".plan-heading",
    title: "Add your first task",
    text: "Your plan starts here. Write one, or pick an idea. Add a time like 45m to set the estimate.",
  },
];

interface PlannerTourProps {
  /** Read once: whether Today has a planned task to point at and start. */
  hasTask: boolean;
  onVisit: (view: TourView) => void;
  onDone: (started: boolean) => void;
  onStart: () => Promise<void>;
  /**
   * The empty tour's last step: creating the first task is required, and is
   * the only way to finish. Resolves false (with the reason) when it failed.
   */
  onCreate: (outcome: string, minutes: number) => Promise<string | null>;
}

/** Only measurement/positioning is imperative; coach-mark content stays reactive. */
export function PlannerTour(props: PlannerTourProps) {
  const [index, setIndex] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [outcome, setOutcome] = createSignal("");
  const headingId = createUniqueId();
  const hasTask = untrack(() => props.hasTask);
  const stops = hasTask ? WITH_TASK : EMPTY;
  const stop = () => stops[index()]!;
  const last = () => index() === stops.length - 1;
  let popup!: HTMLElement;
  let highlight!: HTMLDivElement;
  let arrow!: HTMLSpanElement;
  let heading!: HTMLHeadingElement;
  let target: HTMLElement | null = null;
  let frame = 0;
  let disposed = false;

  const position = () => {
    if (!target?.isConnected || disposed) return;
    const rect = target.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.left - 5}px`,
      top: `${rect.top - 5}px`,
      width: `${rect.width + 10}px`,
      height: `${rect.height + 10}px`,
    });
    const box = popup.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(
        window.innerWidth - box.width - 12,
        rect.left + rect.width / 2 - box.width / 2,
      ),
    );
    const below = rect.bottom + box.height + 26 < window.innerHeight;
    const top = below
      ? rect.bottom + 18
      : Math.max(12, rect.top - box.height - 18);
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px` });
    const x = Math.max(
      left + 16,
      Math.min(left + box.width - 24, rect.left + rect.width / 2),
    );
    Object.assign(arrow.style, {
      left: `${x}px`,
      top: `${below ? top - 5 : top + box.height - 5}px`,
    });
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(position);
  };
  const finish = () => {
    if (!busy()) props.onDone(false);
  };
  // The tour can't be skipped: no Skip button, and Escape does nothing.
  // It ends only from its last step.

  createEffect(() => {
    const current = stop();
    props.onVisit(current.view);
    setError("");
    queueMicrotask(() => {
      if (disposed) return;
      const app = document.getElementById("app");
      target =
        app?.querySelector<HTMLElement>(current.target) ??
        app?.querySelector<HTMLElement>("nav button[aria-current]") ??
        null;
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
      heading.focus({ preventScroll: true });
      schedule();
    });
  });
  onMount(() => {
    const observer = new ResizeObserver(schedule);
    observer.observe(popup);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    onCleanup(() => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    });
  });

  async function create(text: string, fallbackMinutes: number): Promise<void> {
    if (busy() || !text.trim()) return;
    const parsed = parseQuickEntry(text.trim());
    setBusy(true);
    setError("");
    try {
      const failure = await props.onCreate(
        parsed.outcome,
        parsed.minutes ?? fallbackMinutes,
      );
      if (failure && !disposed) setError(failure);
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function start(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onStart();
      if (!disposed) props.onDone(true);
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  return (
    <Dialog
      class="planner-tour-dialog"
      aria-labelledby={headingId}
      onDismiss={() => {}}
      preventCancel
    >
      <div
        ref={(element) => {
          highlight = element;
        }}
        class="tour-highlight"
        aria-hidden="true"
      />
      <section
        ref={(element) => {
          popup = element;
        }}
        class="tour-popup"
      >
        <div class="tour-top">
          <span class="tour-step">
            {index() + 1} / {stops.length}
          </span>
        </div>
        <h2
          ref={(element) => {
            heading = element;
          }}
          id={headingId}
          tabIndex={-1}
        >
          {stop().title}
        </h2>
        <p class="muted">{stop().text}</p>
        <Show when={last() && !hasTask}>
          <form
            class="tour-task-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create(outcome(), ESTIMATE.defaultMinutes);
            }}
          >
            <input
              aria-label="Your first task"
              placeholder="e.g. Write the intro 45m"
              maxLength={500}
              value={outcome()}
              disabled={busy()}
              onInput={(event) => setOutcome(event.currentTarget.value)}
            />
            <div class="tour-starters" role="group" aria-label="Ideas">
              <For each={STARTERS}>
                {(starter) => (
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() =>
                      void create(starter.outcome, starter.minutes)
                    }
                  >
                    {starter.outcome}
                    <span>{starter.minutes} min</span>
                  </button>
                )}
              </For>
            </div>
            <div class="tour-actions">
              <button
                type="button"
                disabled={busy()}
                onClick={() => setIndex(index() - 1)}
              >
                Back
              </button>
              <button
                type="submit"
                class="tour-primary"
                disabled={busy() || !outcome().trim()}
              >
                Add task
              </button>
            </div>
          </form>
        </Show>
        <p class="error" role="alert" hidden={!error()}>
          {error()}
        </p>
        <div class="tour-actions" hidden={last() && !hasTask}>
          <Show when={index() > 0}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => setIndex(index() - 1)}
            >
              Back
            </button>
          </Show>
          <Show
            when={last()}
            fallback={
              <button
                type="button"
                class="tour-primary"
                onClick={() => setIndex(index() + 1)}
              >
                Next
              </button>
            }
          >
            <Show when={hasTask} fallback={null}>
              <button type="button" disabled={busy()} onClick={finish}>
                Not now
              </button>
              <button
                type="button"
                class="tour-primary"
                disabled={busy()}
                onClick={() => {
                  void start();
                }}
              >
                Start focusing
              </button>
            </Show>
          </Show>
        </div>
      </section>
      <span
        ref={(element) => {
          arrow = element;
        }}
        class="tour-arrow"
        aria-hidden="true"
      />
    </Dialog>
  );
}
