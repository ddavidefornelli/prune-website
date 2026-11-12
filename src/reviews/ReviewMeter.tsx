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
  /** One short trailing hint, like "7 to go", kept on the same line as the count. */
  const hint = () => {
    if (preparing()) return "Writing your review…";
    const done = completed();
    if (done === undefined) return "";
    const left = Math.max(0, target() - done);
    return `${left} to go`;
  };
  const label = () =>
    preparing()
      ? "Your AI review is being written."
      : `${completed() ?? 0} of ${target()} tasks done toward your ${first() ? "first" : "next"} AI review.`;

  return (
    <Show when={shown()}>
      <section
        class="review-meter"
        classList={{ "is-preparing": preparing() }}
        aria-label="AI review progress"
      >
        <p class="review-meter-row">
          <span class="review-meter-label">AI review</span>
          <span class="review-meter-count">
            {completed() ?? "–"}/{target()}
            <Show when={hint()}>
              <span class="review-meter-hint"> · {hint()}</span>
            </Show>
          </span>
        </p>
        <div
          class="review-meter-steps"
          role="progressbar"
          aria-label={label()}
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
      </section>
    </Show>
  );
}
