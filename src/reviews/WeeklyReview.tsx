import { createMemo, createUniqueId, For, Show, untrack } from "solid-js";
import type { WeeklyOverview } from "../planner/types";
import { CALENDAR } from "../shared/time-constants";
import { CheckIn } from "./CheckIn";
import { ReviewFormat } from "./format";
import { ReviewCountdown } from "./review-countdown";
import type { WeeklyReviewState } from "./weekly-review-state";

const COUNTDOWN_LABELS = ["Days", "Hours", "Minutes", "Seconds"] as const;

function NextCheckIn(props: { data: WeeklyOverview; now: number }) {
  const countdown = createMemo(() =>
    ReviewCountdown.of(props.data.week, props.now),
  );
  const preparing = () =>
    props.data.status === "pending" || props.data.status === "running";
  const day = () => props.data.checkIn?.day ?? 0;
  return (
    <section
      class="review-countdown"
      classList={{ "is-preparing": preparing() }}
    >
      <h3 class="review-countdown-title">
        {preparing()
          ? "Writing your check-in…"
          : `Next check-in · ${CALENDAR.weekdayNames[day()]}`}
      </h3>
      <Show when={!preparing() && countdown()}>
        <div
          class="review-countdown-clock"
          role="timer"
          aria-live="off"
          aria-label={`${countdown()?.values[0]} days, ${countdown()?.values[1]} hours, ${countdown()?.values[2]} minutes, ${countdown()?.values[3]} seconds until your next check-in`}
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
      </Show>
      <p class="review-countdown-date">
        <Show when={props.data.checkIn}>
          Your first check-in is three days after you started, then every{" "}
          {CALENDAR.weekdayNames[day()]}.{" "}
        </Show>
        Each check-in looks at the seven days before it: your trends, a plan for
        next week, and a short note.
      </p>
    </section>
  );
}

function statusMessage(data: WeeklyOverview): string {
  const messages: Record<WeeklyOverview["status"], string> = {
    disabled:
      "AI check-ins are off for this account. Turning them on sends a week of planner activity to OpenAI once a week for your check-in note, and for daily task suggestions. Once on, they can’t be turned off.",
    unavailable:
      "Hosted AI check-ins are temporarily unavailable. Your planner is unaffected.",
    pending: `Your check-in for ${ReviewFormat.range(data.week.start, data.week.end)} is queued.`,
    running: `Writing your check-in for ${ReviewFormat.range(data.week.start, data.week.end)}… You can keep using prune.`,
    failed: `${data.error ?? "Your check-in could not be written."} We’ll retry automatically. Your previous check-ins are unchanged.`,
    no_data: `Nothing was planned for ${ReviewFormat.range(data.week.start, data.week.end)}, so there was nothing to check in on. No AI request was made.`,
    up_to_date: "Your latest check-in is ready.",
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
      <h2 id={titleId}>Weekly check-in</h2>
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
        fallback={<p class="muted">Loading your check-in…</p>}
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
              <NextCheckIn data={data()} now={props.now} />
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
                Turn on AI check-ins
              </button>
            </Show>
            <Show when={data().reviews[0]}>
              {(latest) => (
                <CheckIn
                  review={latest()}
                  history={data().reviews}
                  plan={data().checkIn?.plan ?? null}
                  state={review}
                />
              )}
            </Show>
            <Show when={data().reviews.length > 1}>
              <h3 class="check-in-history-title">Earlier check-ins</h3>
              <For each={data().reviews.slice(1)}>
                {(report) => (
                  <details class="weekly-history">
                    <summary>
                      {ReviewFormat.range(report.weekStart, report.weekEnd)}
                    </summary>
                    <p>{ReviewFormat.text(report.analysis.summary)}</p>
                    <ol class="weekly-improvements">
                      <For each={report.analysis.improvements}>
                        {(tip) => <li>{ReviewFormat.text(tip)}</li>}
                      </For>
                    </ol>
                  </details>
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
