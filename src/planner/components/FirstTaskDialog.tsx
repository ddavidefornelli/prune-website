import { createSignal, createUniqueId, For } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { ESTIMATE, MOBILE_QUERY, PLANNER_LIMITS } from "../constants";

const ESTIMATES = [15, 30, 45, 60] as const;
const label = (minutes: number) =>
  minutes === 60 ? "1 hour" : `${minutes} min`;

/**
 * Onboarding's first task, on the same card as the focus-time steps that
 * follow: one question, a box, a tap for the estimate. "Later" goes on
 * without a task, so nobody types a placeholder just to get in.
 */
export function FirstTaskDialog(props: {
  step: number;
  total: number;
  /** Resolves true once the task is saved (or queued offline). */
  onAdd: (outcome: string, minutes: number) => Promise<boolean>;
  onLater: () => void;
}) {
  const headingId = createUniqueId();
  const [outcome, setOutcome] = createSignal("");
  const [minutes, setMinutes] = createSignal<number>(ESTIMATE.defaultMinutes);
  const [busy, setBusy] = createSignal(false);
  const ready = () => outcome().trim().length > 0;

  async function add(): Promise<void> {
    if (busy() || !ready()) return;
    setBusy(true);
    // On failure the planner shows its own error; the card stays to retry.
    if (!(await props.onAdd(outcome().trim(), minutes()))) setBusy(false);
  }

  return (
    <Dialog
      class="pause-dialog focus-time-dialog first-task-dialog"
      aria-labelledby={headingId}
      preventCancel
      onDismiss={() => {}}
      initialFocus={(dialog) => {
        // On a phone, the keyboard would cover the estimate and the button.
        if (!window.matchMedia(MOBILE_QUERY).matches)
          dialog.querySelector<HTMLInputElement>("input")?.focus();
        else dialog.querySelector<HTMLElement>("h2")?.focus();
      }}
    >
      <form
        class="pause-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div class="pause-heading">
          <span class="tour-step">
            {props.step} / {props.total}
          </span>
          <h2 id={headingId} tabIndex={-1}>
            What’s the one thing you want done today?
          </h2>
          <p class="muted">Just one. You can add up to five a day later.</p>
        </div>
        <input
          class="first-task-input"
          type="text"
          aria-label="Your first task"
          placeholder="e.g. Finish the slides"
          maxLength={PLANNER_LIMITS.outcomeLength}
          autocomplete="off"
          enterkeyhint="done"
          value={outcome()}
          disabled={busy()}
          onInput={(event) => setOutcome(event.currentTarget.value)}
        />
        <fieldset class="first-task-estimate">
          <legend>How long will it take?</legend>
          <div class="first-task-chips">
            <For each={ESTIMATES}>
              {(value) => (
                <button
                  type="button"
                  class="first-task-chip"
                  aria-pressed={minutes() === value}
                  disabled={busy()}
                  onClick={() => setMinutes(value)}
                >
                  {label(value)}
                </button>
              )}
            </For>
          </div>
        </fieldset>
        <button
          type="submit"
          class="primary-button first-task-add"
          disabled={busy() || !ready()}
        >
          Add task
        </button>
        <div class="focus-time-footer">
          <button
            type="button"
            class="text-button"
            disabled={busy()}
            onClick={() => props.onLater()}
          >
            Later
          </button>
        </div>
      </form>
    </Dialog>
  );
}
