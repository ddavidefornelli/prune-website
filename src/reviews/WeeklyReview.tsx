import { createMemo, createUniqueId, For, Show, untrack } from "solid-js";
import type { WeeklyOverview } from "../planner/types";
import type { WeeklyReviewState } from "./create-weekly-review";
import { reviewRange } from "./format";
import { reviewCountdown } from "./review-countdown";
import { ReviewReport } from "./ReviewReport";

const COUNTDOWN_LABELS = ["Days", "Hours", "Minutes", "Seconds"] as const;

function ReviewCountdown(props: { data: WeeklyOverview; now: number }) {
  const countdown = createMemo(() =>
    reviewCountdown(props.data.week, props.now),
  );
  const preparing = () =>
    props.data.status === "pending" || props.data.status === "running";
  return (
    <section
      class="review-countdown"
      classList={{ "is-preparing": preparing() }}
    >
      <h3 class="review-countdown-title">
        {preparing() ? "Preparing your review…" : "Next review"}
      </h3>
      <Show when={!preparing() && countdown()}>
        <div
          class="review-countdown-clock"
          role="timer"
          aria-live="off"
          aria-label={`${countdown()?.values[0]} days, ${countdown()?.values[1]} hours, ${countdown()?.values[2]} minutes, ${countdown()?.values[3]} seconds until your next weekly review`}
        >
          <For each={COUNTDOWN_LABELS}>
            {(label, index) => (
              <div class="review-countdown-unit">
                <span class="review-countdown-value">
                  {String(countdown()?.values[index()] ?? 0).padStart(2, "0")}
                </span>
                <span class="review-countdown-label">{label}</span>
              </div>
            )}
          </For>
        </div>
        <div class="review-countdown-track" aria-hidden="true">
          <span style={{ width: `${(countdown()?.progress ?? 0) * 100}%` }} />
        </div>
        <p class="review-countdown-date" hidden={!countdown()?.due}>
          Checking for your review…
        </p>
      </Show>
    </section>
  );
}

function statusMessage(data: WeeklyOverview): string {
  const messages: Record<WeeklyOverview["status"], string> = {
    disabled:
      "Weekly reviews are off for this account. Turning them on sends selected planner activity to OpenAI for weekly reviews and daily task suggestions. Once on, they can’t be turned off.",
    unavailable:
      "Hosted weekly AI is temporarily unavailable. Your planner is unaffected.",
    pending: `Your review for ${reviewRange(data.week.start, data.week.end)} is queued.`,
    running: `Reviewing ${reviewRange(data.week.start, data.week.end)}… You can keep using prune.`,
    failed: `${data.error ?? "The weekly review could not be generated."} We’ll retry automatically. Your previous reviews are unchanged.`,
    no_data: `No tasks or stops were recorded for ${reviewRange(data.week.start, data.week.end)}. No AI request was made.`,
    up_to_date: "Your latest weekly review is ready.",
  };
  return messages[data.status];
}

export function WeeklyReview(props: {
  review: WeeklyReviewState;
  now: number;
}) {
  const titleId = createUniqueId();
  const review = untrack(() => props.review);
  return (
    <section
      class="weekly-overview"
      aria-labelledby={titleId}
      aria-busy={review.saving()}
    >
      <h2 id={titleId}>Weekly review</h2>
      <Show when={review.error()}>
        <p class="error" role="alert">
          {review.error()}
        </p>
        <button
          type="button"
          disabled={review.saving()}
          onClick={() => {
            void review.refresh();
          }}
        >
          Retry loading
        </button>
      </Show>
      <Show
        when={review.data()}
        fallback={<p class="muted">Loading weekly review…</p>}
      >
        {(data) => (
          <>
            <Show when={!["no_data", "up_to_date"].includes(data().status)}>
              <p
                class={data().status === "failed" ? "error" : "muted"}
                role="status"
              >
                {statusMessage(data())}
              </p>
            </Show>
            <Show when={data().settings.enabled}>
              <ReviewCountdown data={data()} now={props.now} />
            </Show>
            {/* Reviews can't be turned off; only accounts that opted out earlier are disabled. */}
            <Show when={data().status === "disabled"}>
              <button
                type="button"
                disabled={review.saving()}
                onClick={() => {
                  void review.enable();
                }}
              >
                Turn on weekly reviews
              </button>
            </Show>
            <For each={data().reviews}>
              {(report, index) => (
                <Show
                  when={index() === 0}
                  fallback={
                    <details class="weekly-history">
                      <summary>Previous review {index()}</summary>
                      <ReviewReport review={report} />
                    </details>
                  }
                >
                  <ReviewReport review={report} />
                </Show>
              )}
            </For>
          </>
        )}
      </Show>
    </section>
  );
}
