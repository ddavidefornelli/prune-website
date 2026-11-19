import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { analytics } from "../analytics.ts";
import { PRODUCTION_ORIGINS } from "../shared/site";
import { APP_EVENTS, STORAGE_KEYS } from "../shared/storage-keys";
import { TIME } from "../shared/time-constants";
import { PrivacyPolicyButton } from "./PrivacyPolicyButton";
import "../styles/preferences.css";

type Choice = "accepted" | "rejected";
const CHOICES: readonly unknown[] = ["accepted", "rejected"];

/** The visitor's optional-analytics choice on this browser, asked again after six months. */
class CookieConsent {
  private static readonly maxAgeMs = 180 * TIME.dayMs;

  /** The saved choice, if it is still current. Unavailable storage means no consent. */
  static saved(): Choice | undefined {
    try {
      const value = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.cookieChoice) ?? "null",
      );
      if (
        CHOICES.includes(value?.choice) &&
        typeof value.at === "number" &&
        value.at <= Date.now() &&
        Date.now() - value.at < CookieConsent.maxAgeMs
      )
        return value.choice;
    } catch {
      /* No consent. */
    }
    return undefined;
  }

  /** Throws when the browser cannot save it. */
  static save(choice: Choice): void {
    localStorage.setItem(
      STORAGE_KEYS.cookieChoice,
      JSON.stringify({ choice, at: Date.now() }),
    );
  }

  static isChange(event: StorageEvent): boolean {
    return event.key === STORAGE_KEYS.cookieChoice || event.key === null;
  }
}

export function PrivacyPreferences() {
  const [choice, setChoice] = createSignal<Choice>();
  const [open, setOpen] = createSignal(true);
  const [error, setError] = createSignal("");
  let started = false;

  function startTracking() {
    if (
      started ||
      !import.meta.env.PROD ||
      !PRODUCTION_ORIGINS.includes(location.origin)
    )
      return;
    started = analytics.start();
  }

  function choose(next: Choice) {
    try {
      CookieConsent.save(next);
    } catch {
      setError(
        "Your browser could not save this choice. Optional analytics stays off unless you previously enabled it. Allow site storage and try again to change a saved preference.",
      );
      return;
    }
    setChoice(next);
    setOpen(false);
    setError("");
    // A reload tears down the running recorder, including pending script loads.
    // Never clear planner or authentication storage when withdrawing consent.
    if (next === "rejected" && started) {
      analytics.stop();
      location.reload();
    } else if (next === "accepted") startTracking();
  }

  onMount(() => {
    const saved = CookieConsent.saved();
    setChoice(saved);
    setOpen(!saved);
    if (saved === "accepted") startTracking();
    const changed = (event: StorageEvent) => {
      if (CookieConsent.isChange(event)) {
        if (started && CookieConsent.saved() !== "accepted") {
          analytics.stop();
          location.reload();
        } else {
          const next = CookieConsent.saved();
          setChoice(next);
          setOpen(!next);
          if (next === "accepted") startTracking();
        }
      }
    };
    const reopen = () => setOpen(true);
    window.addEventListener("storage", changed);
    window.addEventListener(APP_EVENTS.openPrivacyPreferences, reopen);
    onCleanup(() => {
      window.removeEventListener("storage", changed);
      window.removeEventListener(APP_EVENTS.openPrivacyPreferences, reopen);
    });
  });

  return (
    <Show when={open()}>
      <section class="cookie-banner" aria-label="Cookie preferences">
        <div class="cookie-copy">
          <p>
            Optional cookies for product analytics, heatmaps and masked session
            recordings (PostHog, EU) stay off unless you accept. Change this
            anytime in Cookie settings.
          </p>
          <PrivacyPolicyButton label="Read our privacy policy" />
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </div>
        <div class="cookie-actions">
          <button type="button" onClick={() => choose("rejected")}>
            Reject optional
          </button>
          <button type="button" onClick={() => choose("accepted")}>
            Accept optional
          </button>
          <Show when={choice()}>
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </Show>
        </div>
      </section>
    </Show>
  );
}
