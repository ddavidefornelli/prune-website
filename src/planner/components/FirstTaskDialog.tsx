import { createSignal, createUniqueId, For } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { ESTIMATE, MEDIA_QUERIES, PLANNER_LIMITS } from "../constants";
import { OnboardingScreen } from "./PlannerTour";

const label = (minutes: number) =>
  minutes === 60 ? "1 hour" : `${minutes} min`;

/**
 * Onboarding's first task, drawn like the pitch before it: the task is the
 * hero card (the "kept" card from the first scene, now with your words), a
 * tap for the estimate, one big button. "Later" goes on without a task, so
 * nobody types a placeholder just to get in.
 */
export function FirstTaskDialog(props: {
  step: number;
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
    // On failure the planner shows its own error; the screen stays to retry.
    if (!(await props.onAdd(outcome().trim(), minutes()))) setBusy(false);
  }

  return (
    <Dialog
      class="onboarding-dialog first-task-dialog"
      aria-labelledby={headingId}
      preventCancel
      onDismiss={() => {}}
      initialFocus={(dialog) => {
        // On a phone, the keyboard would cover the estimate and the button.
        if (!window.matchMedia(MEDIA_QUERIES.mobile).matches)
          dialog.querySelector<HTMLInputElement>("input")?.focus();
        else dialog.querySelector<HTMLElement>("h2")?.focus();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <OnboardingScreen
          step={props.step}
          headingId={headingId}
          eyebrow="Your first win"
          title="What’s today’s win?"
          text="The one thing you’ll finish today. Nail it and your streak lights up for the first time."
          glow="var(--pearl-deep)"
          actions={
            <>
              <button
                type="submit"
                class="tour-primary"
                disabled={busy() || !ready()}
              >
                Commit to it
                <span aria-hidden="true" class="tour-arrow">
                  →
                </span>
              </button>
              <button
                type="button"
                class="tour-later"
                disabled={busy()}
                onClick={() => props.onLater()}
              >
                Later
              </button>
            </>
          }
        >
          <div class="win-controls">
            <label class="win-card" classList={{ "is-set": ready() }}>
              <span class="win-check" aria-hidden="true">
                ✓
              </span>
              <input
                class="win-input"
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
              <span class="win-minutes" aria-hidden="true">
                {minutes()}m
              </span>
            </label>
            <fieldset class="win-estimate">
              <legend>How long will it take?</legend>
              <div class="win-chips">
                <For each={ESTIMATE.quickPicks}>
                  {(value) => (
                    <button
                      type="button"
                      class="win-chip"
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
          </div>
        </OnboardingScreen>
      </form>
    </Dialog>
  );
}
