import { Index, Show } from "solid-js";
import { CalendarDay } from "../shared/calendar-day";
import { CALENDAR } from "../shared/time-constants";
import type { WeeklyReviewState } from "./weekly-review-state";

const WEEK = CALENDAR.daysPerWeek;

/**
 * Today's reminder of the weekly check-in: which day it is, how far off, and
 * the week as seven cells filling up toward it.
 */
export function CheckInMeter(props: {
  review: WeeklyReviewState;
  today: string;
  onOpen: () => void;
}) {
  const data = () => props.review.data();
  const writing = () =>
    data()?.status === "pending" || data()?.status === "running";
  const left = () => {
    const next = data()?.week.nextUpdate;
    return next
      ? Math.min(
          WEEK,
          Math.max(
            0,
            CalendarDay.parse(next).daysSince(CalendarDay.parse(props.today)),
          ),
        )
      : WEEK;
  };
  const hint = () => {
    if (writing()) return "Writing…";
    if (!data()) return "";
    if (left() === 0) return "Today";
    return left() === 1 ? "Tomorrow" : `In ${left()} days`;
  };
  const day = () => CALENDAR.weekdayNames[data()?.checkIn?.day ?? 0];
  return (
    <Show when={!data() || data()!.settings.enabled}>
      <section class="review-meter" aria-label="Weekly check-in">
        <button
          type="button"
          class="hud check-in-meter"
          classList={{ "is-writing": writing() }}
          onClick={() => props.onOpen()}
        >
          <span class="check-in-meter-row">
            <span class="check-in-meter-label">
              Weekly check-in
              <Show when={data()?.checkIn}>
                <span class="check-in-meter-day"> · {day()}</span>
              </Show>
            </span>
            <span class="check-in-meter-hint">{hint()}</span>
          </span>
          <span
            class="check-in-week"
            role="img"
            aria-label={
              writing()
                ? "Your check-in is being written."
                : `${WEEK - left()} of ${WEEK} days until your check-in.`
            }
          >
            <Index each={Array.from({ length: WEEK })}>
              {(_, index) => (
                <span
                  classList={{ "is-past": writing() || index < WEEK - left() }}
                />
              )}
            </Index>
          </span>
        </button>
      </section>
    </Show>
  );
}
