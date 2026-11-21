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
import { analytics } from "../../analytics.ts";
import { Dialog } from "../../components/Dialog";
import type { PlanningClient } from "../api";
import { CloudError } from "../cloud-error";
import { FocusTime } from "../focus-time";
import {
  PushNotifications,
  pushNotifications,
  type SavedSubscription,
} from "../push";
import type { ScheduleState } from "../types";
import { NudgeScene, ONBOARDING, OnboardingScreen } from "./PlannerTour";

interface FocusTimeDialogProps {
  client: PlanningClient;
  schedule: ScheduleState | null;
  /** During onboarding: full-screen, as its last two steps. */
  onboarding?: boolean;
  /** Onboarding's first task, shown in the reminder on the last screen. */
  firstTask?: { outcome: string; minutes: number };
  /** That first task is tomorrow's, so is its first reminder. */
  firstTaskTomorrow?: boolean;
  /** Present right after the first task: starting now is still an option. */
  onStartNow?: () => Promise<void>;
  onSaved: (state: ScheduleState) => void;
  onClose: () => void;
}

/**
 * Two screens. First the question (one tap picks the daily focus time), then
 * what that gets you: the email, a notification on this device and a
 * repeating calendar block. During onboarding both are full screens drawn
 * like the pitch, and finishing asks for notifications, so only the
 * calendar is offered; from Overview, one card with a button for each.
 */
export function FocusTimeDialog(props: FocusTimeDialogProps) {
  const client = untrack(() => props.client);
  const headingId = createUniqueId();
  const current = untrack(() => props.schedule?.focusMinute ?? null);
  const [other, setOther] = createSignal(
    current !== null &&
      !FocusTime.PRESETS.some((preset) => preset.time.minute === current),
  );
  const [value, setValue] = createSignal(
    (current === null
      ? FocusTime.SUGGESTED_OTHER
      : new FocusTime(current)
    ).label(),
  );
  const [saved, setSaved] = createSignal<ScheduleState | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [push, { mutate: setPush }] = createResource(() =>
    pushNotifications.state(),
  );
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
      analytics.capture("focus_time_changed", {
        focus_minute: minute,
        weekdays_only: state.weekdaysOnly,
      });
      setSaved(state);
    } catch (cause) {
      setError(CloudError.messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function savePush(subscription: SavedSubscription | null) {
    try {
      if (subscription) {
        props.onSaved(await client.savePushSubscription(subscription));
        analytics.capture("push_notifications_changed", { enabled: true });
      }
    } catch (cause) {
      setError(CloudError.messageOf(cause));
    }
    setPush(await pushNotifications.state());
  }

  async function enablePush(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError("");
    // Asked from this click: browsers only prompt from a gesture.
    await savePush(await pushNotifications.subscribe().catch(() => null));
    setBusy(false);
  }

  /**
   * Onboarding's last tap turns notifications on: the browser's own prompt
   * must open from this tap, before anything is awaited.
   */
  async function finish(then: "start" | "close"): Promise<void> {
    if (busy()) return;
    if (push() === "off") {
      setBusy(true);
      await savePush(await pushNotifications.subscribe().catch(() => null));
      setBusy(false);
    }
    if (then === "start") await startNow();
    else props.onClose();
  }

  async function startNow(): Promise<void> {
    if (busy() || !props.onStartNow) return;
    setBusy(true);
    try {
      await props.onStartNow();
      props.onClose();
    } catch (cause) {
      setError(CloudError.messageOf(cause));
      setBusy(false);
    }
  }

  const errorLine = () => (
    <p class="error" role="alert" hidden={!error()}>
      {error()}
    </p>
  );

  const presets = () => (
    <div class="focus-presets" role="group" aria-label="Focus time">
      <For each={FocusTime.PRESETS}>
        {(preset, i) => (
          <button
            type="button"
            class={`focus-preset is-${preset.id}`}
            aria-pressed={current === preset.time.minute}
            disabled={busy()}
            onClick={() => void choose(preset.time.minute)}
          >
            <Show when={props.onboarding}>
              <PresetIcon index={i()} />
            </Show>
            <span class="focus-preset-label">{preset.label}</span>
            <span class="focus-preset-time">{preset.time.label()}</span>
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
        <Show when={props.onboarding}>
          <PresetIcon index={3} />
        </Show>
        <span class="focus-preset-label">Other</span>
        <span class="focus-preset-time">--:--</span>
      </button>
    </div>
  );

  const otherTime = () => (
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
  );

  const submitOther = (event: SubmitEvent) => {
    event.preventDefault();
    const time = FocusTime.parse(value());
    if (time === null) setError("Pick a time of day.");
    else void choose(time.minute);
  };

  const ways = (state: ScheduleState) => (
    <ul class="focus-ways">
      {/* Onboarding asks on its last tap: only the calendar is offered. */}
      <Show when={!props.onboarding}>
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
                <Match when={PushNotifications.needsHomeScreen()}>
                  On iPhone, add prune to your Home Screen first (Share → Add to
                  Home Screen).
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
      </Show>
      <li>
        <span class="focus-way-text">
          <strong>Calendar</strong>
          <span>A 30-minute block that repeats.</span>
        </span>
        <span class="focus-way-actions">
          <a
            class="focus-way-link"
            href={new FocusTime(state.focusMinute!).googleCalendarUrl(
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
            onClick={() =>
              new FocusTime(state.focusMinute!).downloadCalendarFile(
                state.weekdaysOnly,
                site(),
              )
            }
          >
            Apple / Outlook
          </button>
        </span>
      </li>
    </ul>
  );

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

  const savedState = () => (saved()?.focusMinute != null ? saved() : null);
  const when = (state: ScheduleState) =>
    `${state.weekdaysOnly ? "Weekdays" : "Every day"} at ${new FocusTime(state.focusMinute!).label()}.`;

  const fullScreen = () => (
    <Dialog
      class="onboarding-dialog focus-time-dialog"
      aria-labelledby={headingId}
      onDismiss={() => {
        if (!busy()) props.onClose();
      }}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLElement>(".focus-preset")?.focus()
      }
    >
      <Show
        when={savedState()}
        keyed
        fallback={
          <form onSubmit={submitOther}>
            <OnboardingScreen
              step={ONBOARDING.focus}
              headingId={headingId}
              eyebrow="Your focus time"
              title="When do you lock in?"
              text="Pick a time and prune nudges you every day, with your plan ready to go."
              actions={footer(false)}
            >
              <div class="focus-pick">
                {presets()}
                {otherTime()}
                {errorLine()}
              </div>
            </OnboardingScreen>
          </form>
        }
      >
        {(state) => (
          <div class="focus-time-set">
            <OnboardingScreen
              step={ONBOARDING.total}
              headingId={headingId}
              eyebrow="You’re all set"
              title={when(state)}
              text="We’ll email you then with today’s plan. Put it in your calendar too:"
              glow="var(--pearl-deep)"
              visual={
                <NudgeScene
                  minute={state.focusMinute!}
                  task={props.firstTask}
                  tomorrow={props.firstTaskTomorrow}
                />
              }
              actions={
                <>
                  <button
                    type="button"
                    class="tour-primary"
                    disabled={busy()}
                    onClick={() =>
                      void finish(props.onStartNow ? "start" : "close")
                    }
                  >
                    {props.onStartNow ? "Start now" : "Done"}
                    <span aria-hidden="true" class="tour-arrow">
                      →
                    </span>
                  </button>
                  <Show when={props.onStartNow}>
                    <button
                      type="button"
                      class="tour-later"
                      disabled={busy()}
                      onClick={() => void finish("close")}
                    >
                      Done
                    </button>
                  </Show>
                </>
              }
            >
              <div class="focus-pick">
                {ways(state)}
                {errorLine()}
              </div>
            </OnboardingScreen>
          </div>
        )}
      </Show>
    </Dialog>
  );

  const card = () => (
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
        when={savedState()}
        keyed
        fallback={
          <form class="pause-form" onSubmit={submitOther}>
            <div class="pause-heading">
              <h2 id={headingId}>When do you want to focus each day?</h2>
              <p class="muted">
                prune will remind you then, so you start at a moment that suits
                you.
              </p>
            </div>
            {presets()}
            {otherTime()}
            {errorLine()}
            {footer(false)}
          </form>
        }
      >
        {(state) => (
          <div class="pause-form focus-time-set">
            <div class="pause-heading">
              <h2 id={headingId}>{when(state)}</h2>
              <p class="muted">
                We’ll email you then with today’s tasks. Make it hard to miss:
              </p>
            </div>
            {ways(state)}
            {errorLine()}
            {footer(true)}
          </div>
        )}
      </Show>
    </Dialog>
  );

  return (
    <Show when={props.onboarding} fallback={card()}>
      {fullScreen()}
    </Show>
  );
}

/** Sunrise, midday sun, moon, a clock: the time of day at a glance. */
function PresetIcon(props: { index: number }) {
  return (
    <svg
      class="focus-preset-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <Switch>
        <Match when={props.index === 0}>
          <path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 6v3M5.6 10.6 7 12M18.4 10.6 17 12" />
        </Match>
        <Match when={props.index === 1}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </Match>
        <Match when={props.index === 2}>
          <path
            d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"
            fill="currentColor"
          />
        </Match>
        <Match when={props.index === 3}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </Match>
      </Switch>
    </svg>
  );
}
