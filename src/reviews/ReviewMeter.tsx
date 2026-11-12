import { Index, Show } from "solid-js";
import type { WeeklyReviewState } from "./create-weekly-review";

/**
 * Today's reminder of why tasks get finished: every 10 completed tasks earn an
 * AI review. Shown from the very first visit; hidden only for accounts with
 * reviews off or a backend that still reviews weekly.
 */
export function ReviewMeter(props: { review: WeeklyReviewState }) {
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
      <section
        class="review-meter"
        classList={{ "is-preparing": preparing() }}
        aria-label="AI review progress"
      >
        <div class="review-meter-top">
          <p class="review-meter-label">AI review</p>
          <p class="review-meter-count">
            {completed() ?? "–"}
            <span>/{target()}</span>
          </p>
        </div>
        <div
          class="review-meter-steps"
          role="progressbar"
          aria-label="Completed tasks toward your next AI review"
          aria-valuemin={0}
          aria-valuemax={target()}
          aria-valuenow={completed() ?? 0}
        >
          <Index each={Array.from({ length: target() })}>
            {(_, index) => (
              <span
                classList={{ "is-done": index < (completed() ?? 0) }}
                style={{ "--step": index }}
              />
            )}
          </Index>
        </div>
        <p class="review-meter-caption">{caption()}</p>
      </section>
    </Show>
  );
}
