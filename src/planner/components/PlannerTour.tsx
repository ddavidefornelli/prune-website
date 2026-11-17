import {
  createEffect,
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
import { MOBILE_QUERY } from "../constants";

export type TourView = Exclude<PlannerView, "profile" | "focus">;

interface Stop {
  view: TourView;
  target: string;
  title: string;
  text: string;
  /** Hug the content: leave the target's top padding out of the highlight. */
  trimTop?: boolean;
}

/** The weekly check-in, shown from the first visit. */
const REVIEW: Stop = {
  view: "today",
  target: ".review-meter",
  title: "A weekly check-in",
  text: "Three days after you start, then once a week, prune looks back at your last seven days: how your estimates held up, how many tasks you really finish, and a plan for next week.",
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
    text: "Tap the title to edit it. Keep today to five tasks.",
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
    title: "Five tasks a day",
    text: "That’s the whole rule. Fewer tasks, more focus.",
  },
  REVIEW,
  ...AROUND,
  {
    view: "today",
    // Point at the task row the first task will fill, not the page title.
    target: ".task-form",
    trimTop: true,
    title: "What’s the most important thing you have to do today?",
    text: "Type it in the green box and press Add. Add a time like 45m to set the estimate.",
  },
];

interface PlannerTourProps {
  /**
   * Whether Today has a planned task. Read once to pick the tour; after that,
   * a task appearing ends the empty tour, since its last step is adding one.
   */
  hasTask: boolean;
  onVisit: (view: TourView) => void;
  onDone: (started: boolean) => void;
  onStart: () => Promise<void>;
}

/** Only measurement/positioning is imperative; coach-mark content stays reactive. */
export function PlannerTour(props: PlannerTourProps) {
  const [index, setIndex] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const headingId = createUniqueId();
  const hasTask = untrack(() => props.hasTask);
  const stops = hasTask ? WITH_TASK : EMPTY;
  const stop = () => stops[index()]!;
  const last = () => index() === stops.length - 1;
  /** The empty tour's last step: the user types into the real task form. */
  const writing = () => last() && !hasTask;
  let popup!: HTMLElement;
  let highlight!: HTMLDivElement;
  let arrow!: HTMLSpanElement;
  let heading!: HTMLHeadingElement;
  let target: HTMLElement | null = null;
  let frame = 0;
  let disposed = false;

  const position = () => {
    if (!target?.isConnected || disposed) return;
    const box0 = target.getBoundingClientRect();
    const trim = stop().trimTop
      ? parseFloat(getComputedStyle(target).paddingTop) || 0
      : 0;
    const rect = {
      left: box0.left,
      width: box0.width,
      top: box0.top + trim,
      bottom: box0.bottom,
      height: box0.height - trim,
    };
    // Even breathing room on every side, kept inside the viewport.
    const padX = writing() ? 12 : 10;
    const padY = writing() ? 12 : 8;
    const frameLeft = Math.max(4, rect.left - padX);
    const frameRight = Math.min(
      document.documentElement.clientWidth - 4,
      rect.left + rect.width + padX,
    );
    const frameTop = rect.top - padY;
    const frameBottom = rect.bottom + padY;
    const frameWidth = frameRight - frameLeft;
    const frameHeight = frameBottom - frameTop;
    Object.assign(highlight.style, {
      left: `${frameLeft}px`,
      top: `${frameTop}px`,
      width: `${frameWidth}px`,
      height: `${frameHeight}px`,
    });
    // The overlay keeps blocking the page, except for a hole over the form.
    const overlay = highlight.parentElement!;
    if (writing()) {
      // Cut along the frame's inner, rounded edge so the whole border shows.
      const style = getComputedStyle(highlight);
      const inset = parseFloat(style.borderTopWidth) || 0;
      const [l, t] = [frameLeft + inset, frameTop + inset];
      const [r, b] = [
        frameLeft + frameWidth - inset,
        frameTop + frameHeight - inset,
      ];
      const k = Math.max(
        0,
        Math.min(
          (parseFloat(style.borderTopLeftRadius) || 0) - inset,
          (r - l) / 2,
          (b - t) / 2,
        ),
      );
      const [w, h] = [window.innerWidth, window.innerHeight];
      overlay.style.clipPath =
        `path(evenodd, "M0 0H${w}V${h}H0Z` +
        `M${l + k} ${t}H${r - k}A${k} ${k} 0 0 1 ${r} ${t + k}V${b - k}` +
        `A${k} ${k} 0 0 1 ${r - k} ${b}H${l + k}A${k} ${k} 0 0 1 ${l} ${b - k}` +
        `V${t + k}A${k} ${k} 0 0 1 ${l + k} ${t}Z")`;
    } else overlay.style.clipPath = "";
    // The popup hangs off the frame, centred on it, by the arrow's length.
    const box = popup.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const gap = 14;
    const centre = frameLeft + frameWidth / 2;
    const left = Math.max(
      12,
      Math.min(viewportWidth - box.width - 12, centre - box.width / 2),
    );
    const roomBelow = window.innerHeight - frameBottom - gap - 12;
    const roomAbove = frameTop - gap - 12;
    const below = box.height <= roomBelow || roomBelow >= roomAbove;
    const top = below
      ? frameBottom + gap
      : Math.max(12, frameTop - gap - box.height);
    Object.assign(popup.style, { left: `${left}px`, top: `${top}px` });
    const x = Math.max(left + 20, Math.min(left + box.width - 20, centre));
    Object.assign(arrow.style, {
      left: `${x - 5}px`,
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

  // The empty tour ends once the first task exists, from the real form.
  createEffect(() => {
    if (!hasTask && props.hasTask) props.onDone(false);
  });

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
      target?.scrollIntoView({
        block: writing() ? "center" : "nearest",
        inline: "nearest",
      });
      // On a phone, focusing the field would cover the hint with the keyboard.
      const field = writing()
        ? target?.querySelector<HTMLInputElement>("input")
        : null;
      if (field && !window.matchMedia(MOBILE_QUERY).matches)
        field.focus({ preventScroll: true });
      else heading.focus({ preventScroll: true });
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
      classList={{ "is-writing": writing() }}
      modal={!writing()}
      aria-labelledby={headingId}
      onDismiss={() => {}}
      preventCancel
    >
      <div
        ref={(element) => {
          highlight = element;
        }}
        class="tour-highlight"
        classList={{ "is-writing": writing() }}
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
        <p class="error" role="alert" hidden={!error()}>
          {error()}
        </p>
        <div class="tour-actions">
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
