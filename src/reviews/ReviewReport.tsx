import { createMemo, For, Show } from "solid-js";
import type { WeeklyReview } from "../planner/types";
import { averageTaskTiming, focusDuration } from "../shared/task-timing";
import { reviewText } from "./format";

/** Decorative bars supplement explicit values, never color-only information. */
function ReviewBar(props: { value: number; maximum: number; class: string }) {
  return (
    <div class="review-bar-track" aria-hidden="true">
      <span
        class={props.class}
        style={{
          width: `${Math.min(100, Math.max(0, (props.value / props.maximum) * 100))}%`,
        }}
      />
    </div>
  );
}

function TimingComparison(props: { review: WeeklyReview }) {
  const timing = createMemo(() =>
    averageTaskTiming(
      props.review.activity.tasks,
      props.review.weekStart,
      props.review.weekEnd,
    ),
  );
  return (
    <Show
      when={timing()}
      fallback={
        <p class="muted">
          Not enough recorded time for completed tasks to compare averages yet.
        </p>
      }
    >
      {(value) => (
        <div
          class={`weekly-task-timing review-timing-comparison is-${value().severity}`}
        >
          <div class="review-timing-header">
            <span class="muted">
              Average per task · {value().count} completed{" "}
              {value().count === 1 ? "task" : "tasks"}
            </span>
            <span class="review-timing-delta">
              {value().severity === "green"
                ? "Within margin"
                : "Outside margin"}{" "}
              ·{" "}
              {value().differenceSeconds === 0
                ? "On estimate"
                : `${focusDuration(Math.abs(value().differenceSeconds))} ${value().differenceSeconds > 0 ? "over" : "under"} estimate`}
            </span>
          </div>
          <For each={["estimate", "actual"] as const}>
            {(kind) => {
              const seconds = () =>
                kind === "estimate"
                  ? value().estimatedSeconds
                  : value().actualSeconds;
              return (
                <div class="review-timing-row">
                  <div class="review-timing-caption">
                    <span class="review-timing-label">Average {kind}</span>
                    <span class="review-timing-value">
                      {focusDuration(seconds())}
                    </span>
                  </div>
                  <ReviewBar
                    value={seconds()}
                    maximum={Math.max(
                      value().estimatedSeconds,
                      value().actualSeconds,
                      1,
                    )}
                    class={`review-bar-${kind}`}
                  />
                </div>
              );
            }}
          </For>
          <Show when={value().omittedCount}>
            <p class="muted review-legend">
              {value().omittedCount} completed{" "}
              {value().omittedCount === 1 ? "task excluded" : "tasks excluded"}{" "}
              without recorded time.
            </p>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function ReviewReport(props: { review: WeeklyReview }) {
  const completed = createMemo(
    () =>
      props.review.activity.tasks.filter(
        (task) =>
          task.completedOn !== null &&
          task.completedOn >= props.review.weekStart &&
          task.completedOn <= props.review.weekEnd,
      ).length,
  );
  const taskNames = createMemo(
    () =>
      new Map(
        props.review.activity.tasks.map((task) => [task.id, task.outcome]),
      ),
  );
  const stops = createMemo(
    () => new Map(props.review.activity.stops.map((stop) => [stop.id, stop])),
  );
  const rankedReasons = createMemo(() =>
    props.review.analysis.mainReasons
      .map((reason) => ({
        ...reason,
        evidenceStopIds: [...new Set(reason.evidenceStopIds)].filter((id) =>
          stops().has(id),
        ),
      }))
      .sort((a, b) => b.evidenceStopIds.length - a.evidenceStopIds.length),
  );
  const stats = () =>
    [
      ["Tasks completed", completed()],
      ["Stops logged", props.review.activity.totalStops],
      ["Stop patterns", props.review.analysis.mainReasons.length],
    ] as const;

  return (
    <article class="weekly-report">
      <h4>What to improve next</h4>
      <ol class="weekly-improvements">
        <For each={props.review.analysis.improvements}>
          {(improvement) => <li>{reviewText(improvement)}</li>}
        </For>
      </ol>
      <h4>Estimated vs actual task time</h4>
      <TimingComparison review={props.review} />
      <h4>Comprehensive review</h4>
      <dl class="review-stats">
        <For each={stats()}>
          {([label, value]) => (
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={props.review.activity.omittedStops > 0}>
        <p class="muted">
          {props.review.activity.stops.length} stop entries analyzed ·{" "}
          {props.review.activity.omittedStops} earlier stops were omitted.
        </p>
      </Show>
      <Show
        when={rankedReasons().length}
        fallback={<p class="muted">No stop patterns to analyze yet.</p>}
      >
        <p class="muted">Stop patterns · AI-grouped, may overlap</p>
      </Show>
      <For each={rankedReasons()}>
        {(reason) => (
          <div class="weekly-reason">
            <div class="review-reason-caption">
              <p>{reviewText(reason.reason)}</p>
              <span class="review-count">
                {reason.evidenceStopIds.length}{" "}
                {reason.evidenceStopIds.length === 1 ? "entry" : "entries"}
              </span>
            </div>
            <ReviewBar
              value={reason.evidenceStopIds.length}
              maximum={Math.max(1, props.review.activity.stops.length)}
              class="review-bar-reason"
            />
            <details class="review-evidence">
              <summary>
                View {reason.evidenceStopIds.length} supporting stop{" "}
                {reason.evidenceStopIds.length === 1 ? "entry" : "entries"}
              </summary>
              <ul>
                <For each={reason.evidenceStopIds}>
                  {(id) => {
                    const stop = () => stops().get(id)!;
                    return (
                      <li>
                        <span class="muted">
                          {taskNames().get(stop().taskId) ?? "Task"}
                        </span>
                        <p>{stop().reason}</p>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </details>
          </div>
        )}
      </For>
    </article>
  );
}
