import {
  createEffect,
  createMemo,
  onCleanup,
  createSignal,
  createUniqueId,
  Show,
  untrack,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import type { PlanningClient } from "../api";
import { PLANNER_LIMITS } from "../constants";
import type { PlannerState } from "../create-planner";
import type { Hints } from "../hints";
import { trackedSeconds } from "../task-model";
import { formatDuration } from "../time";
import { TaskTitle } from "./TaskTitle";

const RING_RADIUS = 54;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function FocusView(props: {
  planner: PlannerState;
  client: PlanningClient;
  hints: Hints;
}) {
  const planner = untrack(() => props.planner);
  const task = () => planner.data()?.activeTask;
  const [reason, setReason] = createSignal("");
  const reasonId = createUniqueId();
  const notesId = createUniqueId();
  const paused = () => task()?.startedAt === null;
  const remaining = createMemo(() => {
    const active = task();
    return active
      ? Math.max(
          0,
          active.estimatedMinutes * 60 - trackedSeconds(active, planner.now()),
        )
      : 0;
  });
  const displayTime = () => formatDuration(remaining());

  // A live tab title keeps the session visible from any other tab.
  const baseTitle = document.title;
  onCleanup(() => (document.title = baseTitle));
  createEffect(() => {
    const active = task();
    document.title = active
      ? `${paused() ? "Paused" : displayTime()} · ${active.outcome}`
      : baseTitle;
  });

  async function toggleTimer(): Promise<void> {
    const active = task();
    if (!active) return;
    if (paused()) await planner.mutate(() => props.client.resume(active.id));
    else {
      const success = await planner.mutate(() =>
        props.client.stopTimer(active.id),
      );
      if (success) planner.setPauseReasonOpen(true);
    }
  }

  return (
    <Show
      when={task()}
      fallback={<p class="muted">Choose a task from Today to begin.</p>}
    >
      {(active) => (
        <>
          <div class="focus-layout">
            <div class="focus-details">
              <TaskTitle
                task={active()}
                heading="h1"
                editable
                disabled={planner.busy()}
                onRename={(outcome) =>
                  planner.mutate(() =>
                    props.client.rename(active().id, outcome),
                  )
                }
              />
              <div class="focus-notes">
                <label for={notesId}>Notes</label>
                <textarea
                  id={notesId}
                  rows={5}
                  value={planner.notes()}
                  onInput={(event) =>
                    planner.setNotes(event.currentTarget.value)
                  }
                />
              </div>
              <div class="focus-actions">
                <button
                  type="button"
                  disabled={planner.busy()}
                  onClick={() => {
                    void planner.mutate(async () => {
                      await props.client.complete(active().id);
                      planner.setPauseReasonOpen(false);
                      planner.visit("today");
                    });
                  }}
                >
                  Complete task
                </button>
              </div>
            </div>
            <button
              type="button"
              class="timer"
              id="focus-timer"
              classList={{
                "is-paused": paused(),
                "is-overdue": remaining() === 0,
              }}
              disabled={planner.busy() || planner.pauseReasonOpen()}
              aria-label={`${displayTime()} remaining. ${paused() ? "Paused. Click to resume" : "Click to pause"}.`}
              onClick={() => {
                void toggleTimer();
              }}
            >
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r={RING_RADIUS} class="timer-track" />
                <circle
                  cx="60"
                  cy="60"
                  r={RING_RADIUS}
                  class="timer-progress"
                  stroke-dasharray={String(RING_CIRCUMFERENCE)}
                  stroke-dashoffset={String(
                    RING_CIRCUMFERENCE *
                      (1 - remaining() / (active().estimatedMinutes * 60)),
                  )}
                />
              </svg>
              <span class="timer-face">
                <span class="timer-value" id="focus-time">
                  {displayTime()}
                </span>
                <span class="timer-caption">
                  {paused()
                    ? "Paused · Tap to resume"
                    : remaining() === 0
                      ? "Time is up · Tap to pause"
                      : "remaining · Tap to pause"}
                </span>
              </span>
            </button>
          </div>
          <Show when={planner.pauseReasonOpen() && paused()}>
            <Dialog
              class="pause-dialog"
              aria-labelledby={reasonId}
              preventCancel
              onDismiss={() => {}}
              initialFocus={(dialog) =>
                dialog.querySelector("textarea")?.focus()
              }
            >
              <form
                class="pause-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.querySelector("textarea")!;
                  input.setCustomValidity(
                    reason().trim()
                      ? ""
                      : "Please write a reason for stopping.",
                  );
                  if (!event.currentTarget.reportValidity()) return;
                  void planner.mutate(async () => {
                    await props.client.savePauseReason(active().id, reason());
                    props.hints.dismiss("pause");
                    setReason("");
                    planner.setPauseReasonOpen(false);
                  });
                }}
              >
                <label id={reasonId}>
                  Why are you stopping?
                  <textarea
                    required
                    // No native "Please fill out this field." hover tooltip.
                    title=""
                    maxLength={PLANNER_LIMITS.stopReasonLength}
                    rows={3}
                    placeholder="e.g. Taking a break or handling an interruption"
                    value={reason()}
                    disabled={planner.busy()}
                    onInput={(event) => {
                      event.currentTarget.setCustomValidity("");
                      setReason(event.currentTarget.value);
                    }}
                  />
                </label>
                <div class="pause-actions">
                  <button type="submit" disabled={planner.busy()}>
                    Save reason
                  </button>
                  <button
                    type="button"
                    disabled={planner.busy()}
                    onClick={() => {
                      void planner.mutate(async () => {
                        await props.client.resume(active().id);
                        setReason("");
                        planner.setPauseReasonOpen(false);
                      });
                    }}
                  >
                    Resume focusing
                  </button>
                </div>
              </form>
            </Dialog>
          </Show>
        </>
      )}
    </Show>
  );
}
