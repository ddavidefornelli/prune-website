import { ESTIMATE } from "../constants";
import { formatDuration } from "../time";

interface DoneBadgeProps {
  actualSeconds: number;
  estimatedMinutes: number;
}

/** Sits where the estimate dial was: the ring keeps the time spent, the check says it's done. */
export function DoneBadge(props: DoneBadgeProps) {
  // Unrecorded time falls back to the estimate so the ring is never blank.
  const minutes = () =>
    Math.min(
      ESTIMATE.max,
      props.actualSeconds > 0
        ? Math.max(1, Math.round(props.actualSeconds / 60))
        : props.estimatedMinutes,
    );
  const label = () =>
    props.actualSeconds > 0
      ? `${formatDuration(props.actualSeconds)} · completed`
      : "completed";
  return (
    <span class="task-done" title={label()}>
      <svg class="estimate-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle
          cx="32"
          cy="32"
          r="30.5"
          pathLength={ESTIMATE.max}
          class="estimate-ring-track"
        />
        <circle
          cx="32"
          cy="32"
          r="30.5"
          pathLength={ESTIMATE.max}
          class="estimate-ring-progress"
          stroke-dasharray={`${minutes()} ${ESTIMATE.max}`}
        />
      </svg>
      <span class="task-done-check" aria-hidden="true">
        {"✓"}
      </span>
      <span class="visually-hidden">{label()}</span>
    </span>
  );
}
