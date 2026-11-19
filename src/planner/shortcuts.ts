import { onCleanup, onMount } from "solid-js";
import type { PlannerView } from "./constants.ts";
import type { PlannerState } from "./planner-state.ts";

export const SHORTCUTS = [
  { key: "N", label: "New outcome" },
  { key: "T", label: "Today" },
  { key: "F", label: "Focus" },
  { key: "M", label: "Tomorrow" },
  { key: "O", label: "Overview" },
  { key: "Space", label: "Pause or resume the timer" },
  { key: "?", label: "Show shortcuts" },
] as const;

const VIEW_KEYS: Readonly<Record<string, PlannerView>> = {
  t: "today",
  f: "focus",
  m: "tomorrow",
  o: "habits",
};

const KEYS = {
  help: "?",
  newTask: "n",
  space: " ",
  slashCode: "Slash",
} as const;

/** Elements whose keys belong to the control, not to the shortcuts. */
const TYPING_TARGETS = "input, textarea, select, [role='slider']";
const SELECTORS = {
  openDialog: "dialog[open]",
  focusTimer: "#focus-timer",
  newTaskInput: ".task-form input",
} as const;

/**
 * Keyboard-first navigation that follows the same locks as the visible
 * controls. Listens for the lifetime of the Solid owner that creates it.
 */
export class KeyboardShortcuts {
  private readonly planner: PlannerState;
  private readonly onHelp: () => void;

  constructor(planner: PlannerState, onHelp: () => void) {
    this.planner = planner;
    this.onHelp = onHelp;
    onMount(() => {
      document.addEventListener("keydown", this.handle);
      onCleanup(() => document.removeEventListener("keydown", this.handle));
    });
  }

  private static typing(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || !!target.closest(TYPING_TARGETS))
    );
  }

  private canVisit(view: PlannerView): boolean {
    const planner = this.planner;
    return (
      !planner.busy() &&
      !(planner.focusLocked() && view !== "focus") &&
      !(view === "focus" && planner.todayComplete())
    );
  }

  private readonly handle = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
    if (event.altKey || KeyboardShortcuts.typing(event.target)) return;
    if (document.querySelector(SELECTORS.openDialog)) return;
    const key = event.key.toLowerCase();
    const planner = this.planner;

    if (
      key === KEYS.help ||
      (event.code === KEYS.slashCode && event.shiftKey)
    ) {
      event.preventDefault();
      this.onHelp();
    } else if (key === KEYS.space && planner.view() === "focus") {
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      document.querySelector<HTMLButtonElement>(SELECTORS.focusTimer)?.click();
    } else if (key === KEYS.newTask) {
      const view = planner.view();
      if (view !== "today" && view !== "tomorrow") {
        if (!this.canVisit("today")) return;
        planner.visit("today");
      }
      event.preventDefault();
      queueMicrotask(() =>
        document
          .querySelector<HTMLInputElement>(SELECTORS.newTaskInput)
          ?.focus(),
      );
    } else if (key in VIEW_KEYS && !event.shiftKey) {
      const view = VIEW_KEYS[key]!;
      if (!this.canVisit(view)) return;
      event.preventDefault();
      planner.visit(view);
    }
  };
}
