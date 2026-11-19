import { Duration } from "../../shared/duration";
import { ESTIMATE } from "../constants";

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
        ? Math.max(1, Math.round(new Duration(props.actualSeconds).minutes))
        : props.estimatedMinutes,
    );
  const label = () =>
    props.actualSeconds > 0
      ? `${new Duration(props.actualSeconds).clock()} · completed`
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
