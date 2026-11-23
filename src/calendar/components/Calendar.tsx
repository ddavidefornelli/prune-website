import {
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { ListState } from "../../tasks/list-state";
import { TaskList } from "../../tasks/task-list";
import type { Task } from "../../tasks/types";
import type { CalendarState } from "../calendar-state";
import { CALENDAR } from "../constants";
import { CalendarFormat } from "../format";
import type { TaskDrag } from "../task-drag";
import { Week, type Placed } from "../week";
import type { PlannedElsewhere } from "../types";
import { CalendarSheet, type SheetFor } from "./CalendarSheet";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_MINUTES = 24 * 60;

/** A task of this space, or (in Personal) one planned in a group. */
type Item =
  { kind: "task"; task: Task } | { kind: "elsewhere"; task: PlannedElsewhere };

/**
 * The week above the list. Closed, it is a strip of seven days; it opens to
 * the hours when a task is dragged towards it or with its button, and never
 * takes the whole screen. Tasks dragged onto an hour are planned there;
 * dragged out, they leave it. A tap on an empty hour plans a task too.
 */
export function Calendar(props: {
  calendar: CalendarState;
  list: ListState;
  drag: TaskDrag;
}) {
  const calendar = () => props.calendar;
  const [sheet, setSheet] = createSignal<SheetFor | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), CALENDAR.hourMs / 60);
  onCleanup(() => clearInterval(clock));

  let section!: HTMLElement;
  let strip!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let columns!: HTMLDivElement;

  const shown = createMemo(() =>
    calendar().wide()
      ? calendar()
          .week()
          .days.map((_, index) => index)
      : [calendar().day()],
  );
  const today = createMemo(() => calendar().week().dayOf(now()));

  /** Each day's tasks, side by side where they overlap; a late one ends at midnight. */
  const days = createMemo<Placed<Item>[][]>((previous) => {
    const week = calendar().week();
    // Blocks that did not change keep their element: a sync never replays
    // their landing or interrupts a drag; only new and moved ones land.
    const kept = new Map(
      (previous ?? []).flat().map((placed) => [placedKey(placed), placed]),
    );
    const items: Item[] = [
      ...calendar()
        .planned()
        .map((task) => ({ kind: "task" as const, task })),
      ...calendar()
        .elsewhere()
        .map((task) => ({ kind: "elsewhere" as const, task })),
    ];
    return week.days.map((_, day) =>
      Week.place(
        items
          .filter((item) => week.dayOf(item.task.startAt!) === day)
          .map((item) => {
            const from = week.minutes(day, item.task.startAt!);
            const to = Math.min(DAY_MINUTES, from + item.task.minutes);
            return { item, from, to: Math.max(to, from + 15) };
          }),
      ).map((placed) => kept.get(placedKey(placed)) ?? placed),
    );
  });
  /** Each day's busy time (group spaces), clipped to the day. */
  const busy = createMemo(() => {
    const week = calendar().week();
    return week.days.map((_, day) =>
      calendar()
        .busy()
        .map((span) => ({
          from: Math.max(0, week.minutes(day, span.start)),
          to: Math.min(DAY_MINUTES, week.minutes(day, span.end)),
        }))
        .filter((span) => span.to > span.from),
    );
  });
  const draggedMinutes = () => {
    const drag = calendar().dragging();
    return (drag && props.list.task(drag.id)?.minutes) || CALENDAR.taskMinutes;
  };

  const target = () => {
    const found = calendar().target();
    return found?.kind === "slot" ? found.start : null;
  };
  const draggedTitle = () => {
    const drag = calendar().dragging();
    return drag ? (props.list.task(drag.id)?.title ?? "") : "";
  };

  /** The hours' scale: the grid is 24 equal rows. */
  const hourHeight = () => columns.getBoundingClientRect().height / 24;

  onMount(() => {
    // Opens on the working day: the current hour this week, the morning otherwise.
    const first = () => {
      const hour =
        today() >= 0
          ? Math.max(0, new Date().getHours() - 1)
          : CALENDAR.firstHour;
      scroller.scrollTop = hour * hourHeight();
    };
    first();
    const reopened = new ResizeObserver(() => {
      if (scroller.clientHeight > 0 && scroller.dataset.ready !== "1") {
        scroller.dataset.ready = "1";
        first();
      } else if (scroller.clientHeight === 0) delete scroller.dataset.ready;
    });
    reopened.observe(scroller);
    onCleanup(() => reopened.disconnect());

    // Read during a drag, not rendered: nothing here needs tracking.
    // eslint-disable-next-line solid/reactivity
    calendar().setHitTest((x, y) => {
      const box = section.getBoundingClientRect();
      if (
        x < box.left - 8 ||
        x > box.right + 8 ||
        y < box.top - 8 ||
        y > box.bottom + 8
      )
        return null;
      const hours = scroller.getBoundingClientRect();
      const grid = columns.getBoundingClientRect();
      if (
        hours.height < 24 ||
        y < hours.top ||
        y > hours.bottom ||
        x < grid.left ||
        x > grid.right
      )
        return { kind: "calendar" };
      const order = shown();
      const column = Math.min(
        order.length - 1,
        Math.floor(((x - grid.left) / grid.width) * order.length),
      );
      const hour = Math.min(
        23,
        Math.max(0, Math.floor((y - grid.top) / hourHeight())),
      );
      return { kind: "slot", start: calendar().week().at(order[column], hour) };
    });
    props.drag.setView({
      reveal: () => {
        const top = section.getBoundingClientRect().top;
        const header =
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--header",
            ),
          ) || 56;
        if (top < header)
          window.scrollBy({ top: top - header - 8, behavior: "smooth" });
      },
      scrollEdge: (x, y) => {
        const box = scroller.getBoundingClientRect();
        if (box.height < 24 || x < box.left || x > box.right) return;
        if (y < box.top + CALENDAR.edgePx && y > box.top - CALENDAR.edgePx)
          scroller.scrollTop -= CALENDAR.edgeSpeed;
        else if (
          y > box.bottom - CALENDAR.edgePx &&
          y < box.bottom + CALENDAR.edgePx
        )
          scroller.scrollTop += CALENDAR.edgeSpeed;
      },
      dayAt: (x, y) => {
        const box = strip.getBoundingClientRect();
        if (y < box.top || y > box.bottom || x < box.left || x > box.right)
          return -1;
        return Math.min(6, Math.floor(((x - box.left) / box.width) * 7));
      },
    });
    onCleanup(() => props.drag.setView(null));
  });

  /** A tap on an empty hour: which tasks could go there. */
  function tapHours(event: MouseEvent, day: number): void {
    if ((event.target as Element).closest(".calendar-item")) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const hour = Math.min(
      23,
      Math.max(0, Math.floor((event.clientY - box.top) / hourHeight())),
    );
    setSheet({ kind: "plan", start: calendar().week().at(day, hour) });
  }

  /** Up to three dots under a day in the strip, one per planned task. */
  const dots = (day: number) =>
    Array.from({ length: Math.min(days()[day].length, 3) }, (_, i) => i);

  return (
    <section
      ref={(element) => (section = element)}
      class="calendar"
      classList={{
        "is-open": calendar().open(),
        "is-wide": calendar().wide(),
        "is-dragging": !!calendar().dragging(),
      }}
      aria-label="Calendar"
    >
      <div class="calendar-strip">
        <button
          type="button"
          class="calendar-toggle"
          aria-expanded={calendar().open()}
          aria-controls="calendar-hours"
          aria-label={calendar().open() ? "Close calendar" : "Open calendar"}
          onClick={() => calendar().toggle()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
        <div ref={(element) => (strip = element)} class="calendar-days">
          <Index each={calendar().week().days}>
            {(date, day) => (
              <button
                type="button"
                class="calendar-day"
                classList={{
                  "is-today": today() === day,
                  "is-selected": !calendar().wide() && calendar().day() === day,
                }}
                aria-pressed={!calendar().wide() && calendar().day() === day}
                aria-label={CalendarFormat.day(date())}
                onClick={() => {
                  calendar().showDay(day);
                  if (!calendar().open()) calendar().toggle();
                }}
              >
                <span class="calendar-weekday">
                  {CalendarFormat.weekday(date(), calendar().wide())}
                </span>
                <span class="calendar-date">{date().getDate()}</span>
                <span class="calendar-dots" aria-hidden="true">
                  <For each={dots(day)}>{() => <span />}</For>
                </span>
              </button>
            )}
          </Index>
        </div>
      </div>

      <div class="calendar-body" id="calendar-hours" inert={!calendar().open()}>
        <div class="calendar-bar">
          <button
            type="button"
            class="calendar-step"
            aria-label="Previous week"
            onClick={() => calendar().showWeek(-1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 6l-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            class="calendar-range"
            aria-label="Go to today"
            onClick={() => calendar().showToday()}
          >
            {CalendarFormat.week(calendar().week())}
          </button>
          <button
            type="button"
            class="calendar-step"
            aria-label="Next week"
            onClick={() => calendar().showWeek(1)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <div ref={(element) => (scroller = element)} class="calendar-scroll">
          <div class="calendar-grid">
            <div class="calendar-hours" aria-hidden="true">
              <For each={HOURS}>
                {(hour) => (
                  <span class="calendar-hour">
                    {hour === 0 ? "" : CalendarFormat.hour(hour)}
                  </span>
                )}
              </For>
            </div>
            <div
              ref={(element) => (columns = element)}
              class="calendar-columns"
              style={{ "--columns": shown().length }}
            >
              <For each={shown()}>
                {(day) => (
                  <div
                    class="calendar-column"
                    classList={{ "is-today": today() === day }}
                    onClick={(event) => tapHours(event, day)}
                  >
                    <For each={busy()[day]}>
                      {(span) => (
                        <div
                          class="calendar-busy"
                          style={{ "--from": span.from, "--to": span.to }}
                          role="img"
                          aria-label={`Busy ${CalendarFormat.span(
                            calendar()
                              .week()
                              .at(day, span.from / 60),
                            span.to - span.from,
                          )}`}
                        />
                      )}
                    </For>
                    <For each={days()[day]}>
                      {(placed) => (
                        <CalendarItem
                          placed={placed}
                          calendar={calendar()}
                          list={props.list}
                          drag={props.drag}
                          hourHeight={hourHeight}
                          onOpen={setSheet}
                        />
                      )}
                    </For>
                    <Show
                      when={
                        target() !== null &&
                        calendar().week().dayOf(target()!) === day
                      }
                    >
                      <div
                        class="calendar-drop"
                        style={{
                          "--from": calendar().week().minutes(day, target()!),
                          "--to":
                            calendar().week().minutes(day, target()!) +
                            draggedMinutes(),
                        }}
                      >
                        <span>{CalendarFormat.time(target()!)}</span>
                        <span class="calendar-drop-title">
                          {draggedTitle()}
                        </span>
                      </div>
                    </Show>
                    <Show when={today() === day}>
                      <div
                        class="calendar-now"
                        style={{
                          "--from": calendar().week().minutes(day, now()),
                        }}
                        aria-hidden="true"
                      />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
      <Show when={sheet()}>
        {(open) => (
          <CalendarSheet
            for={open()}
            list={props.list}
            onClose={() => setSheet(null)}
          />
        )}
      </Show>
    </section>
  );
}

/** Everything that makes a block look the way it does: same key, same block. */
const placedKey = (placed: Placed<Item>) =>
  JSON.stringify([
    placed.item.kind,
    placed.item.task,
    placed.from,
    placed.to,
    placed.lane,
    placed.lanes,
  ]);

/** Where an item sits: its minutes and its lane beside overlapping ones. */
const placement = (placed: Placed<Item>, minutes?: number) => ({
  "--from": placed.from,
  "--to": minutes === undefined ? placed.to : placed.from + minutes,
  "--lane": placed.lane,
  "--lanes": placed.lanes,
});

interface ItemProps {
  placed: Placed<Item>;
  calendar: CalendarState;
  list: ListState;
  drag: TaskDrag;
  hourHeight: () => number;
  onOpen: (sheet: SheetFor) => void;
}

/** This space's task (drag, resize, tap) or a task planned in a group (tap). */
function CalendarItem(props: ItemProps) {
  const other = () => {
    const item = props.placed.item;
    return item.kind === "elsewhere" ? item.task : null;
  };
  return (
    <Show when={other()} fallback={<TaskBlock {...props} />}>
      {(task) => (
        <button
          type="button"
          class="calendar-item is-elsewhere"
          classList={{ "is-done": task().done }}
          style={placement(props.placed)}
          aria-label={`${task().title}, ${task().spaceName}, ${CalendarFormat.span(task().startAt, task().minutes)}`}
          onClick={() => props.onOpen({ kind: "elsewhere", task: task() })}
        >
          <span class="calendar-item-title">{task().title}</span>
          <span class="calendar-item-space">{task().spaceName}</span>
        </button>
      )}
    </Show>
  );
}

/**
 * A planned task: drag it to another hour or out of the calendar, drag its
 * bottom edge to change how long it takes, or tap it for its details.
 */
function TaskBlock(props: ItemProps) {
  const task = () => (props.placed.item as { task: Task }).task;
  // The length while its edge is being dragged.
  const [stretch, setStretch] = createSignal<number | null>(null);
  let stretched = false;

  function resize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startMinutes = task().minutes;
    const room = DAY_MINUTES - props.placed.from;
    const move = (next: PointerEvent) => {
      const minutes =
        startMinutes + ((next.clientY - startY) / props.hourHeight()) * 60;
      setStretch(Math.min(room, TaskList.cleanMinutes(minutes)));
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      const minutes = stretch();
      setStretch(null);
      if (minutes !== null && minutes !== startMinutes) {
        stretched = true;
        props.list.resize(task().id, minutes);
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

  const minutes = () => stretch() ?? task().minutes;
  return (
    <button
      type="button"
      ref={(element) =>
        props.drag.attach(element, {
          id: () => task().id,
          from: "calendar",
          title: () => task().title,
        })
      }
      class="calendar-item is-task"
      classList={{
        "is-done": task().done,
        "is-moving": props.calendar.dragging()?.id === task().id,
        "is-stretching": stretch() !== null,
        "is-short": minutes() < 45,
      }}
      style={placement(props.placed, stretch() ?? undefined)}
      aria-label={`${task().title}, ${CalendarFormat.span(task().startAt!, task().minutes)}`}
      onClick={() => {
        // The press that resized it is not also a tap.
        if (stretched) {
          stretched = false;
          return;
        }
        props.onOpen({ kind: "task", id: task().id });
      }}
    >
      <span class="calendar-item-title">{task().title}</span>
      <span class="calendar-item-time">
        {CalendarFormat.hours(task().startAt!, minutes())}
      </span>
      <Show when={!task().done}>
        <span
          class="calendar-resize"
          aria-hidden="true"
          onPointerDown={resize}
        />
      </Show>
    </button>
  );
}
