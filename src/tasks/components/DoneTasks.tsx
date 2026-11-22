import { createSignal, For, Show } from "solid-js";
import type { ListState } from "../list-state";
import { TaskItem } from "./TaskItem";

/** Finished tasks, folded away under one line until asked for. */
export function DoneTasks(props: { state: ListState }) {
  const [open, setOpen] = createSignal(false);
  const count = () => props.state.doneIds().length;
  return (
    <Show when={count()}>
      <section class="done" aria-label="Done">
        <div class="done-bar">
          <button
            type="button"
            class="done-toggle"
            aria-expanded={open()}
            aria-controls="done-tasks"
            onClick={() => setOpen(!open())}
          >
            Done <span class="done-count">{count()}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 10l4 4 4-4" />
            </svg>
          </button>
          <Show when={open()}>
            <button
              type="button"
              class="done-clear"
              aria-label="Clear done tasks"
              onClick={() => props.state.clearDone()}
            >
              Clear
            </button>
          </Show>
        </div>
        <Show when={open()}>
          <ul id="done-tasks" class="tasks" aria-label="Done tasks">
            <For each={props.state.doneIds()}>
              {(id) => <TaskItem id={id} state={props.state} />}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}
