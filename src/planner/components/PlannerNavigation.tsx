import { createEffect, For, onCleanup, onMount, untrack } from "solid-js";
import { NAVIGATION_VIEWS, VIEW_LABELS } from "../constants";
import type { PlannerState } from "../planner-state";

const VIEW_SHORTCUTS = { today: "T", focus: "F", tomorrow: "M", habits: "O" };

export function PlannerNavigation(props: { planner: PlannerState }) {
  let navigation!: HTMLElement;
  const planner = untrack(() => props.planner);
  const views = () =>
    NAVIGATION_VIEWS.filter(
      (view) => view !== "focus" || !planner.todayComplete(),
    );
  const updateIndicator = () => {
    const selected = navigation.querySelector<HTMLButtonElement>(
      "button[aria-current]",
    );
    navigation.classList.toggle("has-selection", !!selected);
    if (!selected) return;
    navigation.style.setProperty(
      "--selection-left",
      `${selected.offsetLeft}px`,
    );
    navigation.style.setProperty(
      "--selection-width",
      `${selected.offsetWidth}px`,
    );
    navigation.style.setProperty(
      "--selection-height",
      `${selected.offsetHeight}px`,
    );
  };
  createEffect(() => {
    planner.view();
    planner.todayComplete();
    queueMicrotask(() => {
      if (navigation.isConnected) updateIndicator();
    });
  });
  onMount(() => {
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(navigation);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div class="navigation-header">
      <nav
        ref={(element) => (navigation = element)}
        aria-label="Main navigation"
        classList={{
          "today-complete-selected":
            planner.todayComplete() && planner.view() === "today",
        }}
      >
        <For each={views()}>
          {(view) => (
            <button
              type="button"
              classList={{
                "day-complete": view === "today" && planner.todayComplete(),
              }}
              aria-label={VIEW_LABELS[view]}
              aria-keyshortcuts={VIEW_SHORTCUTS[view]}
              aria-controls="planner-content"
              disabled={
                planner.busy() || (planner.focusLocked() && view !== "focus")
              }
              title={
                planner.focusLocked() && view !== "focus"
                  ? "Pause the focus timer to access other pages"
                  : undefined
              }
              aria-current={view === planner.view() ? "page" : undefined}
              onClick={() => planner.visit(view)}
            >
              {VIEW_LABELS[view]}
            </button>
          )}
        </For>
      </nav>
    </div>
  );
}
