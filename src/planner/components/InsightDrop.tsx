import type { Insight } from "../insights";

/** What a finished task is answered with on Today: a message, or a fact about the owner's habits. */
export function InsightDrop(props: {
  insight: Insight;
  onDismiss: () => void;
}) {
  return (
    <aside
      class="insight-drop"
      role="status"
      aria-label={props.insight.eyebrow ?? "About you"}
    >
      <p class="insight-eyebrow" aria-hidden="true">
        {props.insight.eyebrow ?? "About you"}
      </p>
      <p class="insight-figure" aria-hidden="true">
        {props.insight.figure}
      </p>
      <p class="insight-text">{props.insight.text}</p>
      <button
        type="button"
        class="insight-dismiss"
        aria-label="Dismiss"
        onClick={() => props.onDismiss()}
      >
        ×
      </button>
    </aside>
  );
}
