import { createSignal, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { capture } from "../../analytics.ts";
import type { Task } from "../types";
import { PLANNER_LIMITS } from "../constants";

interface TaskTitleProps {
  task: Task;
  heading: "h1" | "h2";
  editable: boolean;
  disabled: boolean;
  onRename: (outcome: string) => Promise<boolean>;
}

export function TaskTitle(props: TaskTitleProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let saving = false;
  let editButton: HTMLButtonElement | undefined;

  async function save(): Promise<void> {
    if (!editing() || saving || !props.editable) return;
    const outcome = draft().trim();
    if (!outcome || outcome === props.task.outcome) {
      setEditing(false);
      return;
    }
    saving = true;
    if (await props.onRename(outcome)) {
      capture("task_renamed");
      setEditing(false);
    }
    saving = false;
  }

  return (
    <Dynamic component={props.heading} class="editable-title">
      <Show
        when={props.editable}
        fallback={<span class="task-title-text">{props.task.outcome}</span>}
      >
        <Show
          when={editing()}
          fallback={
            <button
              ref={(element) => (editButton = element)}
              type="button"
              disabled={props.disabled}
              title={`${props.task.outcome} — click to edit`}
              aria-label={`Edit task title: ${props.task.outcome}`}
              onClick={() => {
                setDraft(props.task.outcome);
                setEditing(true);
              }}
            >
              <span class="task-title-text">{props.task.outcome}</span>
            </button>
          }
        >
          <input
            ref={(input) =>
              queueMicrotask(() => {
                if (input.isConnected) {
                  input.focus();
                  input.select();
                }
              })
            }
            aria-label="Task title"
            value={draft()}
            maxLength={PLANNER_LIMITS.outcomeLength}
            disabled={props.disabled}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => {
              void save();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                editButton?.focus();
              }
            }}
          />
        </Show>
      </Show>
    </Dynamic>
  );
}
