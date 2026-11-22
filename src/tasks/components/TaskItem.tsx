import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { LIST_TIMING, TASK_LIMITS } from "../constants";
import type { ListState } from "../list-state";
import type { Task } from "../types";

/**
 * One task: tick the circle, tap the words to change them, × to delete.
 * Emptying the words deletes it too; Undo brings it back either way. Rows are
 * keyed by id, so a sync or a rename never rebuilds the row being edited.
 */
export function TaskItem(props: { id: string; state: ListState }) {
  // The last version seen: the row may outlive its task by a frame when deleted.
  const task = createMemo<Task | undefined>(
    (last) => props.state.task(props.id) ?? last,
  );
  const [editing, setEditing] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;
  let title: HTMLButtonElement | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(leaving));

  const fit = () => {
    if (!editor) return;
    editor.style.height = "auto";
    editor.style.height = `${editor.scrollHeight}px`;
  };

  // Called inside the tap itself where possible: phones only raise the
  // keyboard for a focus that happens during the tap.
  function focusEditor(): void {
    if (!editor || document.activeElement === editor) return;
    fit();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function startEditing(): void {
    setEditing(true);
    focusEditor();
  }

  function finish(save: boolean, refocus: boolean): void {
    clearTimeout(leaving);
    if (!editing()) return;
    const value = editor?.value ?? "";
    editor = undefined;
    setEditing(false);
    if (save) props.state.rename(props.id, value);
    if (refocus) title?.focus();
  }

  return (
    <Show when={task()}>
      {(current) => (
        <li
          class="task"
          classList={{ "is-done": current().done, "is-editing": editing() }}
        >
          <label class="check">
            <input
              type="checkbox"
              checked={current().done}
              aria-label={current().title}
              onChange={() => props.state.toggle(props.id)}
            />
            <span class="check-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6.5 12.5l3.5 3.5 7.5-8" />
              </svg>
            </span>
          </label>
          <Show
            when={editing()}
            fallback={
              <button
                ref={(element) => (title = element)}
                type="button"
                class="task-title"
                aria-label={`Edit ${current().title}`}
                onClick={startEditing}
              >
                {current().title}
              </button>
            }
          >
            <textarea
              ref={(element) => {
                editor = element;
                queueMicrotask(focusEditor);
              }}
              class="task-editor"
              aria-label="Task"
              rows={1}
              enterkeyhint="done"
              maxLength={TASK_LIMITS.titleLength}
              value={current().title}
              onInput={fit}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.isComposing) {
                  event.preventDefault();
                  finish(true, true);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  finish(false, true);
                }
              }}
              onFocus={() => clearTimeout(leaving)}
              onBlur={() => {
                // Not at once: a tap on × moves focus before its click lands.
                // (Cancelling that focus change would cancel the click on iOS.)
                clearTimeout(leaving);
                leaving = setTimeout(
                  () => finish(true, false),
                  LIST_TIMING.blurGraceMs,
                );
              }}
            />
          </Show>
          <button
            type="button"
            class="task-delete"
            aria-label={`Delete ${current().title}`}
            onClick={() => {
              clearTimeout(leaving);
              props.state.remove(props.id);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </li>
      )}
    </Show>
  );
}
