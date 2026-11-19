import { createMemo, For, Show } from "solid-js";
import { Estimate } from "../planner/estimate";
import type { CheckInPlan, WeeklyReview } from "../planner/types";
import { Duration } from "../shared/duration";
import { CheckInSummary } from "./check-in";
import { ReviewFormat } from "./format";
import type { WeeklyReviewState } from "./weekly-review-state";
import { ReviewReport } from "./ReviewReport";

/**
 * Raw weeks as dots, the smoothed trend as a line: the trend is the number,
 * the dots show how noisy the weeks behind it were. Decorative; every value
 * is also written out next to it.
 */
function Sparkline(props: {
  raw: readonly (number | null)[];
  trend: readonly (number | null)[];
  /** Draws a dashed line at this value, such as 1 for "on estimate". */
  reference?: number;
}) {
  const W = 120;
  const H = 36;
  const pad = 4;
  const bounds = () => {
    const values = [...props.raw, ...props.trend, props.reference].filter(
      (value): value is number => typeof value === "number",
    );
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max - min < 1e-6 ? { min: min - 1, max: max + 1 } : { min, max };
  };
  const x = (index: number) =>
    props.raw.length < 2
      ? W / 2
      : pad + (index * (W - pad * 2)) / (props.raw.length - 1);
  const y = (value: number) =>
    H -
    pad -
    ((value - bounds().min) / (bounds().max - bounds().min)) * (H - pad * 2);
  const line = () =>
    props.trend
      .map((value, index) =>
        value === null ? null : `${x(index).toFixed(1)},${y(value).toFixed(1)}`,
      )
      .filter(Boolean)
      .join(" ");
  return (
    <svg
      class="check-in-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <Show when={props.reference !== undefined}>
        <line
          class="check-in-spark-reference"
          x1="0"
          x2={W}
          y1={y(props.reference!)}
          y2={y(props.reference!)}
        />
      </Show>
      <polyline class="check-in-spark-trend" points={line()} />
      <For each={props.raw}>
        {(value, index) => (
          <Show when={value !== null}>
            <circle
              class="check-in-spark-dot"
              cx={x(index())}
              cy={y(value!)}
              r="2"
            />
          </Show>
        )}
      </For>
    </svg>
  );
}

const lastValue = (values: readonly (number | null)[]) =>
  values[values.length - 1] ?? null;

function TrendCards(props: { summary: CheckInSummary }) {
  const week = () => props.summary.points[props.summary.points.length - 1];
  const ratio = () => lastValue(props.summary.estimateTrend);
  const pace = () => lastValue(props.summary.paceTrend);
  return (
    <div class="check-in-trends">
      <section class="check-in-trend">
        <h4>Estimates</h4>
        <p class="check-in-value">
          {ratio() === null ? "—" : CheckInSummary.ratioLabel(ratio()!)}
        </p>
        <Sparkline
          raw={props.summary.points.map((point) => point.estimateRatio)}
          trend={props.summary.estimateTrend}
          reference={1}
        />
        <p class="check-in-note">
          {week()?.estimateRatio == null
            ? "No timed tasks this week."
            : `This week: ${CheckInSummary.ratioLabel(week()!.estimateRatio!).toLowerCase()}`}
        </p>
      </section>
      <section class="check-in-trend">
        <h4>Tasks a day</h4>
        <p class="check-in-value">
          {pace() === null ? "—" : pace()!.toFixed(1)}
        </p>
        <Sparkline
          raw={props.summary.points.map((point) =>
            point.activeDays ? point.completed / point.activeDays : null,
          )}
          trend={props.summary.paceTrend}
        />
        <p class="check-in-note">
          This week: {week()?.completed ?? 0} done of {week()?.planned ?? 0}{" "}
          planned
        </p>
      </section>
      <section class="check-in-trend">
        <h4>Capacity</h4>
        <p class="check-in-value">
          {props.summary.capacityMinutes === null
            ? "—"
            : Duration.ofMinutes(props.summary.capacityMinutes).rounded()}
        </p>
        <p class="check-in-note">
          Focus on finished tasks, on a day you worked.
          {week()?.activeDays
            ? ` ${week()!.activeDays} ${week()!.activeDays === 1 ? "day" : "days"} worked this week.`
            : ""}
        </p>
      </section>
    </div>
  );
}

/** Next week's numbers, old next to new. Accepting is the only way they change. */
function PlanCard(props: {
  summary: CheckInSummary;
  review: WeeklyReview;
  plan: CheckInPlan | null;
  state: WeeklyReviewState;
}) {
  const decided = () => props.plan?.decidedFor === props.review.weekEnd;
  const rows = () => {
    const { current, suggested } = props.summary;
    return [
      {
        label: "New tasks start at",
        from: Duration.ofMinutes(
          Estimate.forFactor(current.estimateFactor),
        ).rounded(),
        to: Duration.ofMinutes(
          Estimate.forFactor(suggested.estimateFactor),
        ).rounded(),
      },
      {
        label: "Tasks a day",
        from: String(current.dailyTarget),
        to: String(suggested.dailyTarget),
      },
    ] as const;
  };
  const decide = (plan: Omit<CheckInPlan, "decidedFor">) =>
    void props.state.decide({ ...plan, decidedFor: props.review.weekEnd });
  return (
    <section class="check-in-plan" classList={{ "is-decided": decided() }}>
      <h4>Your plan for next week</h4>
      <dl>
        <For each={rows()}>
          {(row) => (
            <div classList={{ "is-changed": row.from !== row.to }}>
              <dt>{row.label}</dt>
              <dd>
                <Show
                  when={!decided() && row.from !== row.to}
                  fallback={<strong>{decided() ? row.from : row.to}</strong>}
                >
                  <s>{row.from}</s>
                  <span aria-hidden="true">→</span>
                  <strong>{row.to}</strong>
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
      <Show
        when={!decided()}
        fallback={
          <p class="check-in-note">
            Plan set. It holds until your next check-in.
          </p>
        }
      >
        <Show
          when={props.summary.changed}
          fallback={
            <p class="check-in-note">
              No change needed: your plan matches how your weeks go.
            </p>
          }
        >
          <p class="check-in-note">
            <Show
              when={props.summary.enoughTiming}
              fallback="Not enough timed tasks to adjust estimates yet. "
            >
              Based on your trend, not just this week.{" "}
            </Show>
            You can still change any task by hand.
          </p>
          <div class="check-in-actions">
            <button
              type="button"
              class="primary-button"
              disabled={props.state.saving()}
              onClick={() => decide(props.summary.suggested)}
            >
              Accept plan
            </button>
            <button
              type="button"
              class="text-button"
              disabled={props.state.saving()}
              onClick={() => decide(props.summary.current)}
            >
              Keep current
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}

/**
 * The latest check-in, read top to bottom: where your trends are, what to
 * plan next week, a short note, and the full breakdown on request.
 */
export function CheckIn(props: {
  review: WeeklyReview;
  history: readonly WeeklyReview[];
  plan: CheckInPlan | null;
  state: WeeklyReviewState;
}) {
  const summary = createMemo(
    () => new CheckInSummary(props.history, props.plan),
  );
  return (
    <article class="check-in">
      <p class="check-in-eyebrow">
        Check-in ·{" "}
        {ReviewFormat.range(props.review.weekStart, props.review.weekEnd)}
      </p>
      <TrendCards summary={summary()} />
      <PlanCard
        summary={summary()}
        review={props.review}
        plan={props.plan}
        state={props.state}
      />
      <section class="check-in-coach">
        <h4>Coach&rsquo;s note</h4>
        <p>{ReviewFormat.text(props.review.analysis.summary)}</p>
        <ol class="weekly-improvements">
          <For each={props.review.analysis.improvements}>
            {(improvement) => <li>{ReviewFormat.text(improvement)}</li>}
          </For>
        </ol>
      </section>
      <details class="check-in-details">
        <summary>Full breakdown</summary>
        <ReviewReport review={props.review} />
      </details>
    </article>
  );
}
