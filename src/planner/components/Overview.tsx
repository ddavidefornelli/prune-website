import { Show, untrack } from "solid-js";
import type { WeeklyReviewState } from "../../reviews/weekly-review-state";
import { WeeklyReview } from "../../reviews/WeeklyReview";
import { CheckInMeter } from "../../reviews/CheckInMeter";
import { Streak } from "../streak";
import { StreakCounter } from "./StreakCounter";
import type { PlanningClient } from "../api";
import type { PlannerState } from "../planner-state";
import type { ScheduleState } from "../types";
import { ActivityCalendar } from "./ActivityCalendar";
import { FocusTimeLine } from "./FocusTimeLine";

export function Overview(props: {
  planner: PlannerState;
  client: PlanningClient;
  review: WeeklyReviewState;
  /** The daily focus time; absent on a backend that cannot store one. */
  schedule?: ScheduleState | null;
  onChangeFocusTime?: () => void;
}) {
  const planner = untrack(() => props.planner);
  const client = untrack(() => props.client);
  return (
    <div class="overview-screen">
      <div class="overview-content">
        <div class="overview-actions">
          <button
            type="button"
            class="profile-button"
            aria-controls="planner-content"
            disabled={planner.busy() || planner.focusLocked()}
            onClick={() => planner.visit("profile")}
          >
            Profile
          </button>
        </div>
        {/* The streak and the check-in, stacked on phones, side by side on laptops. */}
        <div class="today-panels">
          <Show when={planner.data()} keyed>
            {(data) => <StreakCounter streak={Streak.of(data)} />}
          </Show>
          <CheckInMeter
            review={props.review}
            today={planner.data()!.today}
            onOpen={() =>
              document
                .querySelector(".weekly-overview")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        </div>
        <Show when={props.schedule} keyed>
          {(schedule) => (
            <FocusTimeLine
              schedule={schedule}
              onChange={() => props.onChangeFocusTime?.()}
            />
          )}
        </Show>
        <ActivityCalendar
          today={planner.data()!.today}
          completions={planner.data()!.completions}
          loadStats={(month) => client.monthStats(month)}
          version={planner.data()!.revision}
        />
        <WeeklyReview review={props.review} now={planner.clock()} />
      </div>
    </div>
  );
}
