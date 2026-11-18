import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import type { PlannerView } from "../constants";

export type TourView = Exclude<PlannerView, "profile" | "focus">;

interface Stop {
  view: TourView;
  target: string;
  title: string;
  text: string;
}

/**
 * A new, empty planner: a short look around the real screens. Onboarding
 * then continues on one card: the first task (FirstTaskDialog), the focus
 * time and its reminders (FocusTimeDialog).
 */
const STOPS: readonly Stop[] = [
  {
    view: "today",
    target: ".plan-heading",
    title: "Five tasks a day",
    text: "That’s the whole rule. Plan a few things that matter, then do them one at a time.",
  },
  {
    view: "tomorrow",
    target: "nav button[aria-current]",
    title: "Plan ahead",
    text: "Add tomorrow’s tasks the evening before, so the morning starts with a plan.",
  },
  {
    view: "habits",
    target: ".today-panels",
    title: "Watch your progress",
    text: "Your streak, your weekly check-in and your focus time live in Overview.",
  },
];

/** Onboarding's step numbers: the tour, then the first task and the focus time's two screens. */
export const ONBOARDING = {
  task: STOPS.length + 1,
  focus: STOPS.length + 2,
  total: STOPS.length + 3,
} as const;

interface PlannerTourProps {
  onVisit: (view: TourView) => void;
  /** The last step's Next: on to the first task. */
  onFinish: () => void;
}

/** Only measurement/positioning is imperative; coach-mark content stays reactive. */
export function PlannerTour(props: PlannerTourProps) {
  const [index, setIndex] = createSignal(0);
  const headingId = createUniqueId();
  const stops = STOPS;
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
    const box0 = target.getBoundingClientRect();
    const rect = box0;
    // Even breathing room on every side, kept inside the viewport.
    const padX = 10;
    const padY = 8;
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
  // The tour can't be skipped: no Skip button, and Escape does nothing.
  createEffect(() => {
    const current = stop();
    props.onVisit(current.view);
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
            {index() + 1} / {ONBOARDING.total}
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
        <div class="tour-actions">
          <Show when={index() > 0}>
            <button type="button" onClick={() => setIndex(index() - 1)}>
              Back
            </button>
          </Show>
          <button
            type="button"
            class="tour-primary"
            onClick={() => (last() ? props.onFinish() : setIndex(index() + 1))}
          >
            Next
          </button>
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
