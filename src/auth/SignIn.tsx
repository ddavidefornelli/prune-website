import { batch, createSignal, untrack } from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import type { PlanningClient } from "../planner/api";
import { errorMessage } from "../planner/errors";
import {
  hasPrivacyAcknowledgement,
  requirePrivacyAcknowledgement,
} from "../planner/privacy-state";

interface SignInProps {
  client: PlanningClient;
  initialError: string;
  configurationError: string;
}

/**
 * The home page for signed-out visitors: Google is the only way in.
 * No SDK or account access before durable notice acceptance.
 */
export function SignIn(props: SignInProps) {
  const [acknowledged, setAcknowledged] = createSignal(
    hasPrivacyAcknowledgement(localStorage),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(untrack(() => props.initialError));

  async function continueWithGoogle(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy() || props.configurationError) return;
    batch(() => {
      setBusy(true);
      setError("");
    });
    try {
      requirePrivacyAcknowledgement(localStorage);
      setAcknowledged(true);
      await props.client.signInWithGoogle();
      // The browser is on its way to Google; stay busy until it leaves.
    } catch (cause) {
      batch(() => {
        setError(errorMessage(cause));
        setBusy(false);
      });
    }
  }

  return (
    <section class="auth-panel" aria-labelledby="signup-title">
      <h1 id="signup-title">
        DO LESS.
        <br />
        ACHIEVE MORE.
      </h1>
      <p class="auth-description">
        Focus on just 3 tasks and understand what's holding you back with the
        free weekly analysis
      </p>
      <form
        class="signup-form"
        aria-busy={busy()}
        onSubmit={(event) => void continueWithGoogle(event)}
      >
        <label class="privacy-acknowledgement" hidden={acknowledged()}>
          <input
            type="checkbox"
            name="privacy"
            required={!acknowledged()}
            disabled={busy()}
          />
          <span>
            I accept the <PrivacyPolicyButton />.
          </span>
        </label>
        <button
          type="submit"
          class="google-signin"
          disabled={busy() || !!props.configurationError}
        >
          <GoogleMark />
          {busy() ? "Opening Google…" : "Continue with Google"}
        </button>
      </form>
      <p class="error" role="alert">
        {props.configurationError || error()}
      </p>
      <button
        type="button"
        class="privacy-policy-button auth-cookie-settings"
        onClick={() =>
          window.dispatchEvent(new Event("prune:preferences:open"))
        }
      >
        Cookie settings
      </button>
    </section>
  );
}

/** Google's multicolour mark, required next to "Continue with Google". */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
