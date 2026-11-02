import { batch, createSignal, For, Show } from "solid-js";
import { PrivacyPolicyButton } from "../components/PrivacyPolicyButton";
import type { PlanningClient } from "../planner/api";
import { errorMessage } from "../planner/errors";
import {
  hasPrivacyAcknowledgement,
  requirePrivacyAcknowledgement,
} from "../planner/privacy-state";
import { isAccount, type Account } from "../planner/types";

const EMAIL_MAX_LENGTH = 254;
const CODE_LENGTH = 8;

interface SignInProps {
  client: PlanningClient;
  initialError: string;
  configurationError: string;
  onAuthenticated: (account: Account) => void;
}

/** No SDK or account access before durable notice acceptance. */
export function SignIn(props: SignInProps) {
  const [acknowledged, setAcknowledged] = createSignal(
    hasPrivacyAcknowledgement(localStorage),
  );
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [activeDigit, setActiveDigit] = createSignal(0);
  const [sentTo, setSentTo] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(props.initialError);
  let emailInput!: HTMLInputElement;
  let codeInput!: HTMLInputElement;

  function acceptNotice(): void {
    if (acknowledged()) return;
    requirePrivacyAcknowledgement(localStorage);
    setAcknowledged(true);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy() || props.configurationError) return;
    batch(() => {
      setBusy(true);
      setError("");
    });
    try {
      acceptNotice();
      if (!sentTo()) {
        const address = email().trim();
        await props.client.sendCode(address);
        setSentTo(address);
      } else {
        const account = await props.client.verifyCode(sentTo(), code().trim());
        if (!isAccount(account))
          throw new Error(
            "Sign-in did not return an account. Please try again.",
          );
        setCode("");
        props.onAuthenticated(account);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      if (sentTo() && codeInput.isConnected) codeInput.focus();
    }
  }

  const updateSelection = () =>
    setActiveDigit(
      Math.min(codeInput.selectionStart ?? code().length, CODE_LENGTH - 1),
    );

  return (
    <section class="auth-panel" aria-labelledby="signup-title">
      <h1 id="signup-title" hidden={!!sentTo()}>
        DO LESS.
        <br />
        ACHIEVE MORE.
      </h1>
      <p class="auth-description" hidden={!!sentTo()}>
        Focus on just 3 tasks and understand what's holding you back with the
        free weekly analysis
      </p>
      <form
        class="signup-form"
        aria-busy={busy()}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          <span class="email-label-spacer">Email address</span>
          <input
            ref={(element) => (emailInput = element)}
            aria-label="Email address"
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
            readOnly={!!sentTo()}
            disabled={busy()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
        <p hidden={!sentTo()} class="muted">
          Check your inbox for your sign-in code. Enter it below to sign in and
          save your tasks.
        </p>
        <label hidden={!sentTo()}>
          Email code
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
              required={!!sentTo()}
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
        </label>
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
          class="auth-submit"
          type="submit"
          aria-label={sentTo() ? "Verify code" : "Email me a sign-in code"}
          disabled={busy() || !!props.configurationError}
        >
          {sentTo() ? "Verify code" : "Email me a sign-in code"}
        </button>
        <Show when={sentTo()}>
          <button
            type="button"
            disabled={busy()}
            onClick={() => {
              batch(() => {
                setSentTo("");
                setCode("");
                setActiveDigit(0);
                setError("");
              });
              emailInput.focus();
            }}
          >
            Use a different email
          </button>
        </Show>
      </form>
      <p class="error" role="alert">
        {props.configurationError || error()}
      </p>
    </section>
  );
}
