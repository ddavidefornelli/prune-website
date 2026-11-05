import { untrack } from "solid-js";
import type { WeeklyReviewState } from "../../reviews/create-weekly-review";
import { WeeklyReview } from "../../reviews/WeeklyReview";
import type { PlannerState } from "../create-planner";
import { ActivityCalendar } from "./ActivityCalendar";

export function Overview(props: {
  planner: PlannerState;
  review: WeeklyReviewState;
}) {
  const planner = untrack(() => props.planner);
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
        <ActivityCalendar
          today={planner.data()!.today}
          completions={planner.data()!.completions}
        />
        <WeeklyReview review={props.review} now={planner.clock()} />
      </div>
    </div>
  );
}
