import { onCleanup } from "solid-js";
import type { CalendarState, Dragging } from "./calendar-state.ts";
import { CALENDAR } from "./constants.ts";

/** What the calendar view tells a drag. */
export interface CalendarView {
  /** Brings the calendar into sight (it may have scrolled away). */
  reveal(): void;
  /** Scrolls the hours when (x, y) is near their top or bottom edge. */
  scrollEdge(x: number, y: number): void;
  /** The day in the week strip under (x, y), or -1. */
  dayAt(x: number, y: number): number;
}

interface Source {
  id: () => string;
  from: Dragging["from"];
  title: () => string;
  /** False while the row is being edited, or for done tasks. */
  enabled?: () => boolean;
}

/** Controls a press must not start a drag from. */
const NOT_A_HANDLE =
  "input, textarea, .check, .task-delete, .do-it, .task-answer, .calendar-resize";

/**
 * Picks tasks up and carries them onto the calendar's hours, or off it.
 * A mouse drags once it moves a few pixels; a finger holds a moment first, so
 * a swipe still scrolls the page. One drag at a time.
 */
export class TaskDrag {
  private readonly calendar: CalendarState;
  private view: CalendarView | null = null;
  private ghost: HTMLElement | null = null;
  private element: HTMLElement | null = null;
  private source: Source | null = null;
  private origin = { x: 0, y: 0 };
  private point = { x: 0, y: 0 };
  private grab = { x: 0, y: 0 };
  private active = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private dayTimer: ReturnType<typeof setTimeout> | undefined;
  private hoveredDay = -1;
  private frame = 0;
  private release: (() => void) | null = null;

  constructor(calendar: CalendarState) {
    this.calendar = calendar;
    onCleanup(() => this.finish(true));
  }

  setView(view: CalendarView | null): void {
    this.view = view;
  }

  /** Makes `element` draggable; undone with the element's owner. */
  attach(element: HTMLElement, source: Source): void {
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (!this.ready(event, source)) return;
      this.press(element, source, event.clientX, event.clientY, "mouse");
    };
    const touch = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !this.ready(event, source)) return;
      const [finger] = event.touches;
      this.press(element, source, finger.clientX, finger.clientY, "touch");
    };
    // A held finger opens the browser's menu otherwise.
    const menu = (event: Event) => {
      if (this.source) event.preventDefault();
    };
    element.addEventListener("pointerdown", pointer);
    element.addEventListener("touchstart", touch, { passive: true });
    element.addEventListener("contextmenu", menu);
    onCleanup(() => {
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("touchstart", touch);
      element.removeEventListener("contextmenu", menu);
      // Rebuilt mid-drag (the week refreshed): the drag goes on, it is about ids.
      if (this.element === element && !this.active) this.finish(true);
    });
  }

  private ready(event: Event, source: Source): boolean {
    if (this.source || source.enabled?.() === false) return false;
    const target = event.target as Element | null;
    return !target?.closest(NOT_A_HANDLE);
  }

  private press(
    element: HTMLElement,
    source: Source,
    x: number,
    y: number,
    input: "mouse" | "touch",
  ): void {
    this.element = element;
    this.source = source;
    this.origin = { x, y };
    this.point = { x, y };
    const box = element.getBoundingClientRect();
    this.grab = { x: Math.min(x - box.left, 160), y: y - box.top };
    if (input === "touch")
      this.holdTimer = setTimeout(() => {
        navigator.vibrate?.(8);
        this.begin();
      }, CALENDAR.holdMs);
    this.release = input === "mouse" ? this.listenMouse() : this.listenTouch();
  }

  private listenMouse(): () => void {
    const move = (event: PointerEvent) => {
      this.point = { x: event.clientX, y: event.clientY };
      if (!this.active) {
        const far = Math.hypot(
          event.clientX - this.origin.x,
          event.clientY - this.origin.y,
        );
        if (far >= CALENDAR.dragDistance) this.begin();
        return;
      }
      event.preventDefault();
      this.move();
    };
    const up = () => this.finish(false);
    const cancel = () => this.finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.finish(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }

  private listenTouch(): () => void {
    const move = (event: TouchEvent) => {
      const finger = event.touches[0];
      if (!finger) return;
      this.point = { x: finger.clientX, y: finger.clientY };
      if (!this.active) {
        // Moved before the hold finished: a scroll, not a drag.
        const far = Math.hypot(
          finger.clientX - this.origin.x,
          finger.clientY - this.origin.y,
        );
        if (far > CALENDAR.touchSlop) this.finish(true);
        return;
      }
      // Holding a task: the page stays still under the finger.
      if (event.cancelable) event.preventDefault();
      this.move();
    };
    const end = () => this.finish(false);
    const cancel = () => this.finish(true);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", cancel);
    return () => {
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", cancel);
    };
  }

  private begin(): void {
    const source = this.source;
    const element = this.element;
    if (!source || !element || this.active) return;
    this.active = true;
    clearTimeout(this.holdTimer);
    this.calendar.beginDrag(source.id(), source.from);
    this.view?.reveal();
    document.documentElement.classList.add("is-dragging");
    element.classList.add("is-drag-source");
    window.getSelection()?.removeAllRanges();

    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = source.title();
    const box = element.getBoundingClientRect();
    ghost.style.width = `${Math.min(box.width, 280)}px`;
    document.body.append(ghost);
    this.ghost = ghost;
    this.move();
    const tick = () => {
      if (!this.active) return;
      this.view?.scrollEdge(this.point.x, this.point.y);
      // The hours scrolled or the calendar grew: the target under a still pointer changed.
      this.calendar.moveDrag(this.point.x, this.point.y);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private move(): void {
    const { x, y } = this.point;
    if (this.ghost) {
      // Always whole on screen, however near the edge the task was picked up.
      const room =
        window.innerWidth - this.ghost.offsetWidth - CALENDAR.ghostMargin;
      const left = Math.max(
        CALENDAR.ghostMargin,
        Math.min(x - this.grab.x, room),
      );
      this.ghost.style.transform = `translate3d(${left}px, ${y - this.grab.y}px, 0)`;
    }
    const target = this.calendar.moveDrag(x, y);
    this.ghost?.classList.toggle("is-over", target?.kind === "slot");
    // Phones: resting on a day in the strip opens that day.
    const day = this.calendar.wide() ? -1 : (this.view?.dayAt(x, y) ?? -1);
    if (day !== this.hoveredDay) {
      clearTimeout(this.dayTimer);
      this.hoveredDay = day;
      if (day >= 0)
        this.dayTimer = setTimeout(
          () => this.calendar.showDay(day),
          CALENDAR.dayHoverMs,
        );
    }
  }

  private finish(cancelled: boolean): void {
    clearTimeout(this.holdTimer);
    clearTimeout(this.dayTimer);
    cancelAnimationFrame(this.frame);
    this.release?.();
    this.release = null;
    this.hoveredDay = -1;
    if (this.active) {
      this.active = false;
      this.calendar.endDrag(cancelled);
      document.documentElement.classList.remove("is-dragging");
      this.element?.classList.remove("is-drag-source");
      this.ghost?.remove();
      this.ghost = null;
      // The press that ended the drag is not also a tap on the row.
      const swallow = (event: Event) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        400,
      );
    }
    this.element = null;
    this.source = null;
  }
}
