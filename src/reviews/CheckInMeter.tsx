import { Index, Show } from "solid-js";
import { DAY_MS } from "../planner/time";
import { WEEKDAYS } from "./check-in";
import type { WeeklyReviewState } from "./create-weekly-review";

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );

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
    return next ? Math.min(7, Math.max(0, daysBetween(props.today, next))) : 7;
  };
  const hint = () => {
    if (writing()) return "Writing…";
    if (!data()) return "";
    if (left() === 0) return "Today";
    return left() === 1 ? "Tomorrow" : `In ${left()} days`;
  };
  const day = () => WEEKDAYS[data()?.checkIn?.day ?? 0];
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
                : `${7 - left()} of 7 days until your check-in.`
            }
          >
            <Index each={Array.from({ length: 7 })}>
              {(_, index) => (
                <span
                  classList={{ "is-past": writing() || index < 7 - left() }}
                />
              )}
            </Index>
          </span>
        </button>
      </section>
    </Show>
  );
}
