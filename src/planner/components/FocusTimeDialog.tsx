import {
  createResource,
  createSignal,
  createUniqueId,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import type { PlanningClient } from "../api";
import { errorMessage } from "../errors";
import {
  calendarFile,
  FOCUS_PRESETS,
  formatMinute,
  googleCalendarUrl,
  parseMinute,
} from "../focus-time";
import { needsHomeScreen, pushState, subscribePush } from "../push";
import type { ScheduleState } from "../types";

interface FocusTimeDialogProps {
  client: PlanningClient;
  schedule: ScheduleState | null;
  /** During onboarding: its step count, which these two screens finish. */
  onboardingSteps?: number;
  /** Present right after the first task: starting now is still an option. */
  onStartNow?: () => Promise<void>;
  onSaved: (state: ScheduleState) => void;
  onClose: () => void;
}

/**
 * Two screens. First the question (one tap picks the daily focus time), then
 * what that gets you: the email, a notification on this device and a
 * repeating calendar block, each turned on explicitly.
 */
export function FocusTimeDialog(props: FocusTimeDialogProps) {
  const client = untrack(() => props.client);
  const headingId = createUniqueId();
  const current = untrack(() => props.schedule?.focusMinute ?? null);
  const [other, setOther] = createSignal(
    current !== null && !FOCUS_PRESETS.some((p) => p.minute === current),
  );
  const [value, setValue] = createSignal(formatMinute(current ?? 8 * 60 + 30));
  const [saved, setSaved] = createSignal<ScheduleState | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [push, { mutate: setPush }] = createResource(() => pushState());
  const site = () => `${window.location.origin}/`;

  async function choose(minute: number): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const state = await client.setFocusTime(
        minute,
        props.schedule?.weekdaysOnly ?? false,
      );
      props.onSaved(state);
      setSaved(state);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function enablePush(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      // Asked from this click: browsers only prompt from a gesture.
      const subscription = await subscribePush();
      if (subscription) {
        const state = await client.savePushSubscription(subscription);
        props.onSaved(state);
      }
      setPush(await pushState());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startNow(): Promise<void> {
    if (busy() || !props.onStartNow) return;
    setBusy(true);
    try {
      await props.onStartNow();
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  function downloadCalendar(state: ScheduleState): void {
    const blob = new Blob(
      [calendarFile(state.focusMinute!, state.weekdaysOnly, site())],
      { type: "text/calendar" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "prune-focus-time.ics";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const footer = (done: boolean) => (
    <div class="focus-time-footer">
      <Show when={props.onStartNow}>
        <button
          type="button"
          class="text-button"
          disabled={busy()}
          onClick={() => void startNow()}
        >
          {done ? "Start now" : "Start now instead"}
        </button>
      </Show>
      <button
        type="button"
        class="text-button"
        disabled={busy()}
        onClick={() => props.onClose()}
      >
        {done ? "Done" : "Not now"}
      </button>
    </div>
  );

  return (
    <Dialog
      class="pause-dialog focus-time-dialog"
      aria-labelledby={headingId}
      onDismiss={() => {
        if (!busy()) props.onClose();
      }}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLElement>(".focus-preset")?.focus()
      }
    >
      <Show
        when={saved()?.focusMinute != null ? saved() : null}
        keyed
        fallback={
          <form
            class="pause-form"
            onSubmit={(event) => {
              event.preventDefault();
              const minute = parseMinute(value());
              if (minute === null) setError("Pick a time of day.");
              else void choose(minute);
            }}
          >
            <div class="pause-heading">
              <Show when={props.onboardingSteps}>
                {(total) => (
                  <span class="tour-step">
                    {total() - 1} / {total()}
                  </span>
                )}
              </Show>
              <h2 id={headingId}>When do you want to focus each day?</h2>
              <p class="muted">
                prune will remind you then, so you start at a moment that suits
                you.
              </p>
            </div>
            <div class="focus-presets" role="group" aria-label="Focus time">
              <For each={FOCUS_PRESETS}>
                {(preset) => (
                  <button
                    type="button"
                    class="focus-preset"
                    aria-pressed={current === preset.minute}
                    disabled={busy()}
                    onClick={() => void choose(preset.minute)}
                  >
                    <span class="focus-preset-label">{preset.label}</span>
                    <span class="focus-preset-time">
                      {formatMinute(preset.minute)}
                    </span>
                  </button>
                )}
              </For>
              <button
                type="button"
                class="focus-preset is-other"
                aria-expanded={other()}
                disabled={busy()}
                onClick={() => setOther(!other())}
              >
                <span class="focus-preset-label">Other</span>
                <span class="focus-preset-time">--:--</span>
              </button>
            </div>
            <Show when={other()}>
              <div class="focus-other">
                <input
                  type="time"
                  aria-label="Your focus time"
                  value={value()}
                  onInput={(event) => setValue(event.currentTarget.value)}
                />
                <button type="submit" class="primary-button" disabled={busy()}>
                  Save
                </button>
              </div>
            </Show>
            <p class="error" role="alert" hidden={!error()}>
              {error()}
            </p>
            {footer(false)}
          </form>
        }
      >
        {(state) => (
          <div class="pause-form focus-time-set">
            <div class="pause-heading">
              <Show when={props.onboardingSteps}>
                {(total) => (
                  <span class="tour-step">
                    {total()} / {total()}
                  </span>
                )}
              </Show>
              <h2 id={headingId}>
                {state.weekdaysOnly ? "Weekdays" : "Every day"} at{" "}
                {formatMinute(state.focusMinute!)}.
              </h2>
              <p class="muted">
                We’ll email you then with today’s tasks. Make it hard to miss:
              </p>
            </div>
            <ul class="focus-ways">
              <li>
                <span class="focus-way-text">
                  <strong>Notification</strong>
                  <span>
                    <Switch fallback="Not available in this browser.">
                      <Match when={push() === "on"}>On for this device.</Match>
                      <Match when={push() === "off"}>On this device.</Match>
                      <Match when={push() === "denied"}>
                        Blocked in this browser’s settings.
                      </Match>
                      <Match when={needsHomeScreen()}>
                        On iPhone, add prune to your Home Screen first (Share →
                        Add to Home Screen).
                      </Match>
                    </Switch>
                  </span>
                </span>
                <Switch>
                  <Match when={push() === "off"}>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={busy()}
                      onClick={() => void enablePush()}
                    >
                      Turn on
                    </button>
                  </Match>
                  <Match when={push() === "on"}>
                    <span class="focus-way-done" aria-hidden="true">
                      ✓
                    </span>
                  </Match>
                </Switch>
              </li>
              <li>
                <span class="focus-way-text">
                  <strong>Calendar</strong>
                  <span>A 30-minute block that repeats.</span>
                </span>
                <span class="focus-way-actions">
                  <a
                    class="focus-way-link"
                    href={googleCalendarUrl(
                      state.focusMinute!,
                      state.weekdaysOnly,
                      site(),
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Google
                  </a>
                  <button
                    type="button"
                    class="focus-way-link"
                    onClick={() => downloadCalendar(state)}
                  >
                    Apple / Outlook
                  </button>
                </span>
              </li>
            </ul>
            <p class="error" role="alert" hidden={!error()}>
              {error()}
            </p>
            {footer(true)}
          </div>
        )}
      </Show>
    </Dialog>
  );
}
