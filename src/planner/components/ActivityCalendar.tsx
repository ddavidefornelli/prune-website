import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  splitProps,
  type JSX,
} from "solid-js";
import {
  CALENDAR_MONTHS,
  calendarMonth,
  MONTHS,
  WEEKDAYS,
  type CalendarDay,
  type CalendarMonth,
  type Completion,
} from "../activity-calendar-model";
import { PLANNER_LIMITS } from "../constants";

interface ActivityCalendarProps {
  today: string;
  completions: readonly Completion[];
}

const dateLabel = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** A reusable intensity swatch, shared by the chart and its legend. */
function ActivitySwatch(
  props: { count: number } & JSX.HTMLAttributes<HTMLSpanElement>,
) {
  const [local, attributes] = splitProps(props, ["count", "class"]);
  return (
    <span
      {...attributes}
      class={`activity-day activity-level-${Math.max(0, Math.min(local.count, PLANNER_LIMITS.tasksPerDay))}${local.class ? ` ${local.class}` : ""}`}
    />
  );
}

function ActivityLegend() {
  return (
    <div
      class="activity-legend"
      aria-label="Daily completions: no tasks, one task, two tasks, three or more tasks"
    >
      <span>Less</span>
      <For each={[0, 1, 2, 3]}>
        {(level) => <ActivitySwatch count={level} aria-hidden="true" />}
      </For>
      <span>More</span>
    </div>
  );
}

function ActivityDay(props: {
  day: CalendarDay;
  today: string;
  tabIndex: number;
}) {
  const label = createMemo(() => {
    const formatted = dateLabel.format(new Date(`${props.day.day}T00:00:00Z`));
    return props.day.future
      ? `${formatted} — upcoming`
      : `${props.day.count} ${props.day.count === 1 ? "task" : "tasks"} completed on ${formatted}`;
  });
  return (
    <ActivitySwatch
      count={props.day.count}
      class={`${props.day.future ? "is-future" : ""}${props.day.day === props.today ? " is-today" : ""}`}
      style={{
        "grid-row": props.day.week + 2,
        "grid-column": props.day.column + 1,
      }}
      title={label()}
      role="listitem"
      aria-label={label()}
      aria-current={props.day.day === props.today ? "date" : undefined}
      tabIndex={props.day.future ? undefined : props.tabIndex}
    />
  );
}

/** Owns roving focus; date calculation and day presentation stay independent. */
function ActivityGrid(props: {
  calendar: CalendarMonth;
  today: string;
  labelledBy: string;
}) {
  const [focusedDay, setFocusedDay] = createSignal<string>();
  const available = createMemo(() =>
    props.calendar.days.filter((day) => !day.future),
  );
  const tabStop = createMemo(() => {
    const days = available();
    return (
      days.find((day) => day.day === focusedDay())?.day ?? days.at(-1)?.day
    );
  });
  const navigate: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const cells = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[role=listitem][tabindex]",
      ),
    );
    const index = cells.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    const delta = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
        string,
        number
      >
    )[event.key];
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cells.length - 1
          : delta === undefined
            ? null
            : Math.max(0, Math.min(cells.length - 1, index + delta));
    if (next === null) return;
    event.preventDefault();
    setFocusedDay(available()[next].day);
    cells[next].focus();
  };
  return (
    <div
      class="activity-grid"
      role="list"
      aria-labelledby={props.labelledBy}
      onKeyDown={navigate}
    >
      <For each={WEEKDAYS}>
        {(weekday) => (
          <span class="activity-weekday" aria-hidden="true">
            {weekday}
          </span>
        )}
      </For>
      <For each={props.calendar.days}>
        {(day) => (
          <ActivityDay
            day={day}
            today={props.today}
            tabIndex={day.day === tabStop() ? 0 : -1}
          />
        )}
      </For>
    </div>
  );
}

export function ActivityCalendar(props: ActivityCalendarProps) {
  const headingId = createUniqueId();
  // 0 is the current month; earlier months are negative.
  const [offset, setOffset] = createSignal(0);
  const calendar = createMemo(() =>
    calendarMonth(props.today, props.completions, offset()),
  );
  const monthName = (calendar: CalendarMonth) =>
    `${MONTHS[calendar.month]} ${calendar.year}`;
  const heading = () =>
    `${calendar().total.toLocaleString()} ${calendar().total === 1 ? "task" : "tasks"} completed in ${monthName(calendar())}`;
  const earliest = -(CALENDAR_MONTHS - 1);
  return (
    <section class="activity-calendar" aria-label="Task completion history">
      <div class="activity-chart">
        <div class="activity-header">
          <h2 class="activity-heading" id={headingId} aria-live="polite">
            {heading()}
          </h2>
          <div class="activity-pager">
            <button
              type="button"
              class="activity-page"
              aria-label="Previous month"
              disabled={offset() <= earliest}
              onClick={() => setOffset((value) => Math.max(earliest, value - 1))}
            >
              {"‹"}
            </button>
            <button
              type="button"
              class="activity-page"
              aria-label="Next month"
              disabled={offset() >= 0}
              onClick={() => setOffset((value) => Math.min(0, value + 1))}
            >
              {"›"}
            </button>
          </div>
        </div>
        <div class="activity-card">
          <ActivityGrid
            calendar={calendar()}
            today={props.today}
            labelledBy={headingId}
          />
          <div class="activity-footer">
            <ActivityLegend />
          </div>
        </div>
      </div>
    </section>
  );
}
