import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { TASK_LIMITS } from "../../tasks/constants";
import type { ListState } from "../../tasks/list-state";
import { CalendarFormat } from "../format";
import { findLinks } from "../links";
import type { PlannedElsewhere } from "../types";

/** An empty hour, a planned task, or a task planned in another space. */
export type SheetFor =
  | { kind: "plan"; start: number }
  | { kind: "task"; id: string }
  | { kind: "elsewhere"; task: PlannedElsewhere };

const STEP = TASK_LIMITS.stepMinutes;
const DAY_MINUTES = 24 * 60;
/** A description is saved this long after typing stops (and on close). */
const SAVE_MS = 600;

/**
 * The tap side of the calendar: plan a task on an empty hour; for a planned
 * task, its length, a description with links, and taking it off.
 */
export function CalendarSheet(props: {
  for: SheetFor;
  list: ListState;
  onClose: () => void;
}) {
  const unplanned = () =>
    props.list.open().filter((task) => !task.done && task.startAt === null);
  // Fixed for the sheet's life, so saving as it closes never reads a target that is gone.
  const taskId = untrack(() =>
    props.for.kind === "task" ? props.for.id : null,
  );
  const task = () => (taskId ? props.list.task(taskId) : undefined);

  // The description being typed, saved quietly as it settles.
  const [draft, setDraft] = createSignal(task()?.notes ?? "");
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    const current = task();
    if (current && draft() !== current.notes)
      props.list.describe(current.id, draft());
  };
  onCleanup(save);
  const close = () => {
    save();
    props.onClose();
  };

  const label = () => {
    if (props.for.kind === "plan") return CalendarFormat.when(props.for.start);
    if (props.for.kind === "elsewhere") return props.for.task.title;
    return task()?.title ?? "";
  };

  return (
    <Dialog
      class="sheet calendar-sheet"
      aria-label={label()}
      onDismiss={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLElement>(".sheet-row, .sheet-close")?.focus()
      }
    >
      <div class="sheet-body">
        <header class="sheet-header">
          <h2 class="sheet-title calendar-sheet-title">{label()}</h2>
          <button
            type="button"
            class="sheet-close"
            aria-label="Close"
            onClick={close}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </header>

        <Show when={props.for.kind === "plan"}>
          <div class="sheet-rows">
            <For
              each={unplanned()}
              fallback={
                <p class="calendar-sheet-empty">Nothing left to plan</p>
              }
            >
              {(open) => (
                <button
                  type="button"
                  class="sheet-row"
                  onClick={() => {
                    props.list.schedule(
                      open.id,
                      (props.for as { start: number }).start,
                    );
                    props.onClose();
                  }}
                >
                  {open.title}
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={task()}>
          {(current) => (
            <div class="calendar-sheet-task">
              <WhenFields
                startAt={current().startAt!}
                minutes={current().minutes}
                onStart={(start) => props.list.schedule(current().id, start)}
                onMinutes={(minutes) =>
                  props.list.resize(current().id, minutes)
                }
              />
              <textarea
                class="calendar-notes"
                aria-label="Description"
                placeholder="Description or links"
                rows={3}
                maxLength={TASK_LIMITS.notesLength}
                value={draft()}
                onInput={(event) => {
                  setDraft(event.currentTarget.value);
                  clearTimeout(saveTimer);
                  saveTimer = setTimeout(save, SAVE_MS);
                }}
                onBlur={save}
              />
              <Links text={draft()} />
              <div class="sheet-rows">
                <button
                  type="button"
                  class="sheet-row is-danger"
                  onClick={() => {
                    save();
                    props.list.schedule(current().id, null);
                    props.onClose();
                  }}
                >
                  Remove from calendar
                </button>
              </div>
            </div>
          )}
        </Show>

        <Show
          when={props.for.kind === "elsewhere" ? props.for.task : undefined}
        >
          {(other) => (
            <div class="calendar-sheet-task">
              <p class="calendar-sheet-when">
                {other().spaceName} ·{" "}
                {CalendarFormat.span(other().startAt, other().minutes)}
              </p>
              <Show when={other().notes}>
                <p class="calendar-sheet-notes">{other().notes}</p>
              </Show>
              <Links text={other().notes} />
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  );
}

/** The description's web addresses, ready to open. */
function Links(props: { text: string }) {
  return (
    <Show when={findLinks(props.text).length}>
      <ul class="calendar-links" aria-label="Links">
        <For each={findLinks(props.text)}>
          {(link) => (
            <li>
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
                  <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
                </svg>
                <span>{link.label}</span>
              </a>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** Minutes from local midnight to `at`. */
const minuteOfDay = (at: number) => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};
const midnight = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};
const dateValue = (at: number) => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
/** `day` at `minutes` past its midnight, in local time. */
const at = (day: Date, minutes: number) =>
  new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    0,
    minutes,
  ).getTime();

/**
 * When, the way calendars show it: the day, then start – end. Each opens the
 * device's own picker; the end lists times with the length beside them, and
 * moving the start keeps the length.
 */
function WhenFields(props: {
  startAt: number;
  minutes: number;
  onStart: (start: number) => void;
  onMinutes: (minutes: number) => void;
}) {
  const day = () => midnight(props.startAt);
  const startMinute = () => minuteOfDay(props.startAt);
  /** Every quarter hour, plus the current start if it is off the grid. */
  const starts = () => {
    const list = Array.from(
      { length: DAY_MINUTES / STEP },
      (_, index) => index * STEP,
    );
    if (!list.includes(startMinute())) list.push(startMinute());
    return list.sort((a, b) => a - b);
  };
  /** Ends from 15 minutes after the start, up to 12 hours, in quarter hours. */
  const lengths = () => {
    const list: number[] = [];
    for (
      let length = TASK_LIMITS.minMinutes;
      length <= TASK_LIMITS.maxMinutes;
      length += STEP
    )
      list.push(length);
    if (!list.includes(props.minutes)) list.push(props.minutes);
    return list.sort((a, b) => a - b);
  };
  const end = () => props.startAt + props.minutes * 60_000;
  let dateInput: HTMLInputElement | undefined;

  return (
    <div class="calendar-when">
      <svg class="calendar-when-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
      <div class="calendar-when-lines">
        <label
          class="calendar-field"
          onClick={() => {
            try {
              dateInput?.showPicker();
            } catch {
              /* Older browsers open it on their own. */
            }
          }}
        >
          <span class="calendar-field-text">{CalendarFormat.day(day())}</span>
          <input
            ref={(element) => (dateInput = element)}
            type="date"
            aria-label="Day"
            required
            value={dateValue(props.startAt)}
            onChange={(event) => {
              const [year, month, date] = event.currentTarget.value
                .split("-")
                .map(Number);
              if (!year || !month || !date) return;
              props.onStart(at(new Date(year, month - 1, date), startMinute()));
            }}
          />
        </label>
        <div class="calendar-when-times">
          <label class="calendar-field">
            <span class="calendar-field-text">
              {CalendarFormat.time(props.startAt)}
            </span>
            <select
              aria-label="Starts"
              value={String(startMinute())}
              onChange={(event) =>
                props.onStart(at(day(), Number(event.currentTarget.value)))
              }
            >
              <For each={starts()}>
                {(minute) => (
                  <option value={String(minute)}>
                    {CalendarFormat.time(at(day(), minute))}
                  </option>
                )}
              </For>
            </select>
          </label>
          <span class="calendar-when-dash" aria-hidden="true">
            –
          </span>
          <label class="calendar-field">
            <span class="calendar-field-text">
              {CalendarFormat.time(end())}
            </span>
            <select
              aria-label="Ends"
              value={String(props.minutes)}
              onChange={(event) =>
                props.onMinutes(Number(event.currentTarget.value))
              }
            >
              <For each={lengths()}>
                {(length) => (
                  <option value={String(length)}>
                    {`${CalendarFormat.time(props.startAt + length * 60_000)} (${CalendarFormat.duration(length)})`}
                  </option>
                )}
              </For>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
