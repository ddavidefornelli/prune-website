import {
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { CalendarFormat } from "../../calendar/format";
import type { TaskDrag } from "../../calendar/task-drag";
import { LIST_TIMING, TASK_LIMITS } from "../constants";
import type { HelperState } from "../helper-state";
import type { ListState } from "../list-state";
import type { Task } from "../types";
import { preview } from "./AnswerText";

/**
 * One task: tick the circle, tap the words to change them, × to delete.
 * Emptying the words deletes it too; Undo brings it back either way. Rows are
 * keyed by id, so a sync or a rename never rebuilds the row being edited.
 */
export function TaskItem(props: {
  id: string;
  state: ListState;
  /** Absent for done tasks: the helper only works on open ones. */
  helper?: HelperState;
  /** Open tasks can be dragged onto the calendar. */
  drag?: TaskDrag;
}) {
  // The last version seen: the row may outlive its task by a frame when deleted.
  const task = createMemo<Task | undefined>(
    (last) => props.state.task(props.id) ?? last,
  );
  const [editing, setEditing] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;
  let title: HTMLButtonElement | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(leaving));
  const run = () => props.helper?.run(props.id);
  const working = () => run()?.status === "working";

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
          ref={(element) =>
            props.drag?.attach(element, {
              id: () => props.id,
              from: "list",
              title: () => current().title,
              enabled: () => !editing() && !current().done && !working(),
            })
          }
          class="task"
          classList={{
            "is-done": current().done,
            "is-editing": editing(),
            "is-draggable": !!props.drag && !current().done,
          }}
        >
          <Show
            when={!working()}
            fallback={
              <span
                class="check is-working"
                role="img"
                aria-label={`Working on ${current().title}`}
              >
                <span class="helper-spinner" />
              </span>
            }
          >
            <label class="check">
              <input
                type="checkbox"
                checked={current().done}
                aria-label={current().title}
                onChange={(event) => {
                  props.state.toggle(props.id);
                  // A refused toggle (five open tasks) leaves the task as it was.
                  event.currentTarget.checked = Boolean(current().done);
                }}
              />
              <span class="check-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6.5 12.5l3.5 3.5 7.5-8" />
                </svg>
              </span>
            </label>
          </Show>
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
          <Show when={!editing() && current().startAt}>
            {(start) => (
              <span class="task-when">{CalendarFormat.when(start())}</span>
            )}
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
          <Show
            when={
              props.helper?.kind(props.id) &&
              !working() &&
              (editing() || !run())
            }
          >
            <button
              type="button"
              class="do-it"
              aria-label={`Do it for me: ${current().title}`}
              title="Do it for me"
              onClick={() => {
                // Saves any edit first; a tap here moved focus off the editor.
                finish(true, false);
                void props.helper?.open(props.id);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3c.6 5.4 3.6 8.4 9 9-5.4.6-8.4 3.6-9 9-.6-5.4-3.6-8.4-9-9 5.4-.6 8.4-3.6 9-9z" />
              </svg>
            </button>
          </Show>
          <Show when={!editing() && !current().done && run()}>
            {(answer) => (
              <div class="task-extra">
                <Switch>
                  <Match when={answer().status === "working"}>
                    <button
                      type="button"
                      class="task-answer is-working"
                      onClick={() => props.helper?.show(props.id)}
                    >
                      {answer().answer === null
                        ? "Working on it…"
                        : "Changing it…"}
                    </button>
                  </Match>
                  <Match when={answer().status === "failed"}>
                    <button
                      type="button"
                      class="task-answer is-failed"
                      onClick={() => props.helper?.show(props.id)}
                    >
                      Didn't finish. Try again
                    </button>
                  </Match>
                  <Match when={answer().answer}>
                    {(text) => (
                      <button
                        type="button"
                        class="task-answer"
                        aria-label={`Open the answer for ${current().title}`}
                        onClick={() => props.helper?.show(props.id)}
                      >
                        <span class="task-answer-text">{preview(text())}</span>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </button>
                    )}
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
        </li>
      )}
    </Show>
  );
}
