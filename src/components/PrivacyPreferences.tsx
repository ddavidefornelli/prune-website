import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { injectContentsquareScript } from "@contentsquare/tag-sdk";
import { PRODUCTION_ORIGINS } from "../shared/site";
import { PrivacyPolicyButton } from "./PrivacyPolicyButton";
import "../styles/preferences.css";

const STORAGE_KEY = "prune:cookies:v1";
const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
type Choice = "accepted" | "rejected";

function savedChoice(): Choice | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      (value?.choice === "accepted" || value?.choice === "rejected") &&
      typeof value.at === "number" &&
      value.at <= Date.now() &&
      Date.now() - value.at < MAX_AGE
    )
      return value.choice;
  } catch {
    /* Unavailable storage means no tracking consent. */
  }
  return undefined;
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
    started = true;
    injectContentsquareScript({ clientId: "10d7eccb828d8" });
  }

  function choose(next: Choice) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ choice: next, at: Date.now() }),
      );
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
    if (next === "rejected" && started) location.reload();
    else if (next === "accepted") startTracking();
  }

  onMount(() => {
    const saved = savedChoice();
    setChoice(saved);
    setOpen(!saved);
    if (saved === "accepted") startTracking();
    const changed = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        if (started && savedChoice() !== "accepted") location.reload();
        else {
          const next = savedChoice();
          setChoice(next);
          setOpen(!next);
          if (next === "accepted") startTracking();
        }
      }
    };
    const reopen = () => setOpen(true);
    window.addEventListener("storage", changed);
    window.addEventListener("prune:preferences:open", reopen);
    onCleanup(() => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("prune:preferences:open", reopen);
    });
  });

  return (
    <Show when={open()}>
      <section class="cookie-banner" aria-label="Cookie preferences">
        <div class="cookie-copy">
          <p>
            Optional cookies for heatmaps and session recordings (Hotjar /
            Contentsquare) stay off unless you accept. Change this anytime in
            Cookie settings.
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
