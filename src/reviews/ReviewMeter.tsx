import { Index, Show } from "solid-js";
import type { WeeklyReviewState } from "./create-weekly-review";

/**
 * Today's reminder of why tasks get finished: every 10 completed tasks earn an
 * AI review. Shown from the very first visit; hidden only for accounts with
 * reviews off or a backend that still reviews weekly.
 */
export function ReviewMeter(props: {
  review: WeeklyReviewState;
  onOpen: () => void;
}) {
  const data = () => props.review.data();
  const shown = () => {
    const current = data();
    return !current || (current.settings.enabled && !!current.progress);
  };
  const target = () => data()?.progress?.target ?? 10;
  const completed = () => data()?.progress?.completed;
  const preparing = () =>
    data()?.status === "pending" || data()?.status === "running";
  const first = () => !data()?.reviews.length;
  const caption = () => {
    if (preparing()) return "Your AI review is being written…";
    const done = completed();
    if (done === undefined) return "Finish tasks to earn your AI review.";
    const left = Math.max(0, target() - done);
    return `${left} more ${left === 1 ? "task" : "tasks"} to your ${first() ? "first" : "next"} AI review.`;
  };

  return (
    <Show when={shown()}>
      <button
        type="button"
        class="review-meter"
        classList={{ "is-preparing": preparing() }}
        aria-label={`${caption()} ${completed() ?? 0} of ${target()} tasks done. Open Overview.`}
        onClick={() => props.onOpen()}
      >
        <span class="review-meter-top">
          <span class="review-meter-label">AI review</span>
          <span class="review-meter-count">
            {completed() ?? "–"}
            <span> / {target()}</span>
          </span>
        </span>
        <span class="review-meter-steps" aria-hidden="true">
          <Index each={Array.from({ length: target() })}>
            {(_, index) => (
              <span
                classList={{ "is-done": index < (completed() ?? 0) }}
                style={{ "--step": index }}
              />
            )}
          </Index>
        </span>
        <span class="review-meter-caption">{caption()}</span>
      </button>
    </Show>
  );
}
