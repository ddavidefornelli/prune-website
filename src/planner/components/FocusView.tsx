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
import type { Task } from "../types";
import { trackedSeconds } from "../task-model";
import { formatDuration } from "../time";
import { TaskTitle } from "./TaskTitle";

const RING_RADIUS = 54;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function FocusView(props: {
  planner: PlannerState;
  client: PlanningClient;
  hints: Hints;
  /** A task was finished here, on this device, and the plan is up to date. */
  onCompleted?: (task: Task) => void;
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
  /** The face drops the hours while there are none: 29:53, not 00:29:53. */
  const clockTime = () =>
    remaining() >= 3600 ? displayTime() : displayTime().slice(3);

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
                    let done: Task | undefined;
                    void planner
                      .mutate(async () => {
                        done = await props.client.complete(active().id);
                        planner.setPauseReasonOpen(false);
                        planner.visit("today");
                      })
                      .then((success) => {
                        if (success && done) props.onCompleted?.(done);
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
                <span class="timer-label">
                  {paused()
                    ? "Paused"
                    : remaining() === 0
                      ? "Time is up"
                      : "Remaining"}
                </span>
                <span class="timer-value" id="focus-time">
                  {clockTime()}
                </span>
                <span class="timer-caption" aria-hidden="true">
                  <svg viewBox="0 0 12 12" class="timer-icon">
                    <Show
                      when={paused()}
                      fallback={
                        <>
                          <rect x="2" y="1.5" width="2.6" height="9" rx="1" />
                          <rect x="7.4" y="1.5" width="2.6" height="9" rx="1" />
                        </>
                      }
                    >
                      <path d="M3 1.8v8.4a.8.8 0 0 0 1.2.7l7-4.2a.8.8 0 0 0 0-1.4l-7-4.2A.8.8 0 0 0 3 1.8Z" />
                    </Show>
                  </svg>
                  {paused() ? "Resume" : "Pause"}
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
