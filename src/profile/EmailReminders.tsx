import { createResource, createSignal, For, Show, untrack } from "solid-js";
import type { PlanningClient } from "../planner/api";
import type { EmailPreferences } from "../planner/types";

const OPTIONS: readonly {
  key: keyof EmailPreferences;
  label: string;
  hint: string;
}[] = [
  {
    key: "daily",
    label: "Daily reminder",
    hint: "One email in the morning when today’s tasks are waiting.",
  },
  {
    key: "comeback",
    label: "Come-back reminder",
    hint: "At most one email a week after 7 days away.",
  },
];

/** Hidden entirely when the preferences cannot be loaded (offline, old backend). */
export function EmailReminders(props: { client: PlanningClient }) {
  const client = untrack(() => props.client);
  const [preferences, { mutate }] = createResource(() =>
    client.emailPreferences().catch(() => null),
  );
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const toggle = async (key: keyof EmailPreferences, enabled: boolean) => {
    const before = preferences();
    if (!before || saving()) return;
    setSaving(true);
    setFailed(false);
    mutate({ ...before, [key]: enabled });
    try {
      mutate(await client.setEmailPreferences({ ...before, [key]: enabled }));
    } catch {
      mutate(before);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show when={preferences()}>
      {(value) => (
        <section
          class="email-reminders"
          aria-labelledby="email-reminders-heading"
        >
          <h2 id="email-reminders-heading" class="profile-section-heading">
            Emails
          </h2>
          <For each={OPTIONS}>
            {(option) => (
              <label class="email-reminder">
                <input
                  type="checkbox"
                  checked={value()[option.key]}
                  disabled={saving()}
                  onChange={(event) =>
                    void toggle(option.key, event.currentTarget.checked)
                  }
                />
                <span>
                  <span class="email-reminder-label">{option.label}</span>
                  <span class="email-reminder-hint">{option.hint}</span>
                </span>
              </label>
            )}
          </For>
          <Show when={failed()}>
            <p class="error" role="alert">
              Could not save. Check your connection and try again.
            </p>
          </Show>
        </section>
      )}
    </Show>
  );
}
