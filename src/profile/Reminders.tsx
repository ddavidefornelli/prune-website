import { createResource, createSignal, For, Show, untrack } from "solid-js";
import type { PlanningClient } from "../planner/api";
import { formatMinute } from "../planner/focus-time";
import {
  forgetPush,
  needsHomeScreen,
  pushState,
  subscribePush,
} from "../planner/push";
import type { EmailPreferences } from "../planner/types";

// Every quarter hour from 05:00 to 23:00.
const TIMES = Array.from({ length: 73 }, (_, index) => 5 * 60 + index * 15);

/**
 * Everything about reminders in one place: the focus time, and the ways
 * prune reaches you then. Parts the backend cannot load stay hidden.
 */
export function Reminders(props: { client: PlanningClient }) {
  const client = untrack(() => props.client);
  const [schedule, { mutate: setSchedule }] = createResource(() =>
    client.schedule().catch(() => null),
  );
  const [emails, { mutate: setEmails }] = createResource(() =>
    client.emailPreferences().catch(() => null),
  );
  const [push, { mutate: setPush }] = createResource(() => pushState());
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const run = async (work: () => Promise<void>) => {
    if (saving()) return;
    setSaving(true);
    setFailed(false);
    try {
      await work();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const setFocus = (minute: number | null, weekdaysOnly: boolean) =>
    run(async () => {
      setSchedule(await client.setFocusTime(minute, weekdaysOnly));
    });

  const setEmail = (key: keyof EmailPreferences, enabled: boolean) => {
    const before = emails();
    if (!before) return;
    setEmails({ ...before, [key]: enabled });
    return run(async () => {
      try {
        setEmails(
          await client.setEmailPreferences({ ...before, [key]: enabled }),
        );
      } catch (error) {
        setEmails(before);
        throw error;
      }
    });
  };

  const togglePush = (on: boolean) =>
    run(async () => {
      if (on) {
        const subscription = await subscribePush();
        if (subscription)
          setSchedule(await client.savePushSubscription(subscription));
      } else
        await forgetPush(async (endpoint) =>
          setSchedule(await client.removePushSubscription(endpoint)),
        );
      setPush(await pushState());
    });

  return (
    <Show when={schedule() || emails()}>
      <section class="email-reminders" aria-labelledby="reminders-heading">
        <h2 id="reminders-heading" class="profile-section-heading">
          Reminders
        </h2>
        <Show when={schedule()}>
          {(value) => (
            <>
              <label class="email-reminder focus-time-setting">
                <span>
                  <span class="email-reminder-label">Focus time</span>
                  <span class="email-reminder-hint">
                    prune reminds you then, every day.
                  </span>
                </span>
                <select
                  disabled={saving()}
                  onChange={(event) =>
                    void setFocus(
                      event.currentTarget.value === ""
                        ? null
                        : Number(event.currentTarget.value),
                      value().weekdaysOnly,
                    )
                  }
                >
                  <option value="" selected={value().focusMinute === null}>
                    Not set
                  </option>
                  <Show
                    when={
                      value().focusMinute !== null &&
                      !TIMES.includes(value().focusMinute!)
                    }
                  >
                    <option value={value().focusMinute!} selected>
                      {formatMinute(value().focusMinute!)}
                    </option>
                  </Show>
                  <For each={TIMES}>
                    {(minute) => (
                      <option
                        value={minute}
                        selected={value().focusMinute === minute}
                      >
                        {formatMinute(minute)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="email-reminder">
                <input
                  type="checkbox"
                  checked={value().weekdaysOnly}
                  disabled={saving()}
                  onChange={(event) =>
                    void setFocus(
                      value().focusMinute,
                      event.currentTarget.checked,
                    )
                  }
                />
                <span>
                  <span class="email-reminder-label">Weekdays only</span>
                  <span class="email-reminder-hint">
                    No reminders on Saturday and Sunday.
                  </span>
                </span>
              </label>
            </>
          )}
        </Show>
        <Show when={emails()}>
          {(value) => (
            <>
              <label class="email-reminder">
                <input
                  type="checkbox"
                  checked={value().daily}
                  disabled={saving()}
                  onChange={(event) =>
                    void setEmail("daily", event.currentTarget.checked)
                  }
                />
                <span>
                  <span class="email-reminder-label">Email reminder</span>
                  <span class="email-reminder-hint">
                    At your focus time: today’s tasks, or a nudge to plan one.
                  </span>
                </span>
              </label>
              <label class="email-reminder">
                <input
                  type="checkbox"
                  checked={value().comeback}
                  disabled={saving()}
                  onChange={(event) =>
                    void setEmail("comeback", event.currentTarget.checked)
                  }
                />
                <span>
                  <span class="email-reminder-label">Come-back email</span>
                  <span class="email-reminder-hint">
                    At most once a week after 7 days away.
                  </span>
                </span>
              </label>
            </>
          )}
        </Show>
        <Show
          when={schedule() && push() && push() !== "unsupported"}
          fallback={
            <Show when={needsHomeScreen()}>
              <p class="muted">
                On iPhone, add prune to your Home Screen to get notifications.
              </p>
            </Show>
          }
        >
          <label class="email-reminder">
            <input
              type="checkbox"
              checked={push() === "on"}
              disabled={saving() || push() === "denied"}
              onChange={(event) => void togglePush(event.currentTarget.checked)}
            />
            <span>
              <span class="email-reminder-label">
                Notifications on this device
              </span>
              <span class="email-reminder-hint">
                {push() === "denied"
                  ? "Blocked in this browser’s settings."
                  : "The same reminder, as a notification."}
              </span>
            </span>
          </label>
        </Show>
        <Show when={failed()}>
          <p class="error" role="alert">
            Could not save. Check your connection and try again.
          </p>
        </Show>
      </section>
    </Show>
  );
}
