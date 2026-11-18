import { Show } from "solid-js";
import { formatMinute } from "../focus-time";
import type { ScheduleState } from "../types";

/** Today's single line about the focus time: what it is, or an invitation to set it. */
export function FocusTimeLine(props: {
  schedule: ScheduleState;
  onChange: () => void;
}) {
  return (
    <Show
      when={props.schedule.focusMinute !== null}
      fallback={
        <aside class="focus-time-line is-ask" aria-label="Focus time">
          <p>
            <strong>Set your focus time</strong>
            prune reminds you every day.
          </p>
          <button
            type="button"
            class="secondary-button"
            onClick={() => props.onChange()}
          >
            Set time
          </button>
        </aside>
      }
    >
      <aside class="focus-time-line" aria-label="Focus time">
        <p>
          <strong>Focus time</strong>
          <span class="focus-time-value">
            {formatMinute(props.schedule.focusMinute!)}
          </span>
          <span class="focus-time-days">
            {props.schedule.weekdaysOnly ? " · weekdays" : " · every day"}
          </span>
        </p>
        <button
          type="button"
          class="text-button"
          onClick={() => props.onChange()}
        >
          Change
        </button>
      </aside>
    </Show>
  );
}
