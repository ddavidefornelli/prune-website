import { batch, createSignal, For, Show, untrack } from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import type { PlanningClient } from "../planner/api";
import { errorMessage } from "../planner/errors";
import { requirePrivacyAcknowledgement } from "../planner/privacy-state";
import { isAccount, type Account } from "../planner/types";

const EMAIL_MAX_LENGTH = 254;
const CODE_LENGTH = 8;

interface LoginProps {
  client: PlanningClient;
  initialError: string;
  configurationError: string;
  onAuthenticated: (account: Account) => void;
  onBack: (event: MouseEvent) => void;
}

/**
 * The way in: Google, or a code sent by email. Choosing either is the
 * acceptance: the notice is stored before any SDK or account access, and a
 * storage failure stops sign-in.
 */
export function Login(props: LoginProps) {
  const [pending, setPending] = createSignal<"google" | "email">();
  const [error, setError] = createSignal(untrack(() => props.initialError));
  const [email, setEmail] = createSignal("");
  const [sentTo, setSentTo] = createSignal("");
  const [code, setCode] = createSignal("");
  const [activeDigit, setActiveDigit] = createSignal(0);
  let emailInput: HTMLInputElement | undefined;
  let codeInput: HTMLInputElement | undefined;

  const busy = () => pending() !== undefined;
  const unavailable = () => busy() || !!props.configurationError;

  function begin(method: "google" | "email"): void {
    batch(() => {
      setPending(method);
      setError("");
    });
  }

  function fail(cause: unknown): void {
    setError(errorMessage(cause));
  }

  async function continueWithGoogle(): Promise<void> {
    if (unavailable()) return;
    begin("google");
    try {
      requirePrivacyAcknowledgement(localStorage);
      await props.client.signInWithGoogle();
      // The browser is on its way to Google; stay busy until it leaves.
    } catch (cause) {
      batch(() => {
        fail(cause);
        setPending(undefined);
      });
    }
  }

  async function submitEmail(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (unavailable()) return;
    begin("email");
    try {
      requirePrivacyAcknowledgement(localStorage);
      const address = email().trim();
      await props.client.sendCode(address);
      setSentTo(address);
    } catch (cause) {
      fail(cause);
    } finally {
      setPending(undefined);
      codeInput?.focus();
    }
  }

  async function submitCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (unavailable()) return;
    begin("email");
    try {
      const account = await props.client.verifyCode(sentTo(), code().trim());
      if (!isAccount(account))
        throw new Error("Sign-in did not return an account. Please try again.");
      props.onAuthenticated(account);
    } catch (cause) {
      fail(cause);
      setPending(undefined);
      codeInput?.focus();
    }
  }

  function useDifferentEmail(): void {
    batch(() => {
      setSentTo("");
      setCode("");
      setActiveDigit(0);
      setError("");
    });
    emailInput?.focus();
  }

  const updateSelection = () =>
    setActiveDigit(
      Math.min(codeInput?.selectionStart ?? code().length, CODE_LENGTH - 1),
    );

  return (
    <div class="login">
      <a class="login-back" href="/" onClick={(event) => props.onBack(event)}>
        ← Back
      </a>
      <section class="auth-panel" aria-labelledby="login-title">
        <h1 id="login-title">SIGN IN</h1>
        <Show
          when={sentTo()}
          fallback={
            <>
              <form
                class="signup-form"
                aria-busy={busy()}
                onSubmit={(event) => void submitEmail(event)}
              >
                <label>
                  Email address
                  <input
                    ref={(element) => (emailInput = element)}
                    name="email"
                    type="email"
                    autocomplete="email"
                    inputmode="email"
                    autocapitalize="none"
                    spellcheck={false}
                    required
                    maxLength={EMAIL_MAX_LENGTH}
                    placeholder="you@example.com"
                    value={email()}
                    disabled={busy()}
                    onInput={(event) => setEmail(event.currentTarget.value)}
                  />
                </label>
                <button
                  class="auth-submit"
                  type="submit"
                  disabled={unavailable()}
                >
                  {pending() === "email" ? "Sending…" : "Email me a code"}
                </button>
              </form>
              <p class="login-divider">or</p>
              <button
                type="button"
                class="google-signin"
                disabled={unavailable()}
                onClick={() => void continueWithGoogle()}
              >
                <GoogleMark />
                {pending() === "google"
                  ? "Opening Google…"
                  : "Continue with Google"}
              </button>
            </>
          }
        >
          <form
            class="signup-form"
            aria-busy={busy()}
            onSubmit={(event) => void submitCode(event)}
          >
            <p class="login-sent">
              Enter the {CODE_LENGTH}-digit code we sent to{" "}
              <strong>{sentTo()}</strong>.
            </p>
            <div class="email-code-boxes">
              <input
                ref={(element) => (codeInput = element)}
                class="otp-input"
                aria-label="Email code"
                name="code"
                type="text"
                autocomplete="one-time-code"
                inputmode="numeric"
                pattern={`[0-9]{${CODE_LENGTH}}`}
                minLength={CODE_LENGTH}
                maxLength={CODE_LENGTH}
                required
                disabled={busy()}
                value={code()}
                onInput={(event) => {
                  const value = event.currentTarget.value
                    .replace(/\D/g, "")
                    .slice(0, CODE_LENGTH);
                  event.currentTarget.value = value;
                  setCode(value);
                  updateSelection();
                }}
                onFocus={updateSelection}
                onClick={updateSelection}
                onKeyUp={updateSelection}
                onSelect={updateSelection}
              />
              <For
                each={Array.from({ length: CODE_LENGTH }, (_, index) => index)}
              >
                {(index) => (
                  <span
                    class="email-code-digit"
                    classList={{ "is-active": index === activeDigit() }}
                    aria-hidden="true"
                  >
                    {code()[index] ?? ""}
                  </span>
                )}
              </For>
            </div>
            <button class="auth-submit" type="submit" disabled={unavailable()}>
              {busy() ? "Verifying…" : "Verify code"}
            </button>
            <button type="button" disabled={busy()} onClick={useDifferentEmail}>
              Use a different email
            </button>
          </form>
        </Show>
        <p class="signup-terms">
          By signing up, you agree to our{" "}
          <PrivacyPolicyButton label="Terms of Service" /> and{" "}
          <PrivacyPolicyButton label="Privacy Policy" />.
        </p>
        <p class="error" role="alert">
          {props.configurationError || error()}
        </p>
      </section>
      <footer class="landing-footer">
        <button
          type="button"
          class="privacy-policy-button"
          onClick={() =>
            window.dispatchEvent(new Event("prune:preferences:open"))
          }
        >
          Cookie settings
        </button>
      </footer>
    </div>
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
