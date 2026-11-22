import { createSignal, Show } from "solid-js";

/**
 * Signing in: Google, or a six-digit code sent by email. Used by "Do it for
 * me" (after a guest's free answers) and by Share.
 */
export function SignInForm(props: {
  busy: boolean;
  onGoogle: () => void;
  /** False when the code was not sent (the caller shows why). */
  onSendCode: (email: string) => Promise<boolean>;
  onVerify: (email: string, code: string) => void;
}) {
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [sent, setSent] = createSignal(false);

  return (
    <>
      <button
        type="button"
        class="primary-button is-wide"
        data-autofocus=""
        disabled={props.busy}
        onClick={() => props.onGoogle()}
      >
        Continue with Google
      </button>
      <p class="helper-or">or</p>
      <Show
        when={sent()}
        fallback={
          <form
            class="helper-field"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await props.onSendCode(email())) setSent(true);
            }}
          >
            <input
              type="email"
              autocomplete="email"
              inputmode="email"
              aria-label="Email"
              placeholder="Email"
              enterkeyhint="send"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
            <button
              type="submit"
              class="secondary-button"
              disabled={!email().trim() || props.busy}
            >
              Send code
            </button>
          </form>
        }
      >
        <p class="helper-note">We sent a code to {email().trim()}.</p>
        <form
          class="helper-field"
          onSubmit={(event) => {
            event.preventDefault();
            props.onVerify(email(), code());
          }}
        >
          <input
            ref={(element) => queueMicrotask(() => element.focus())}
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            aria-label="Code"
            placeholder="Code"
            maxLength={10}
            enterkeyhint="go"
            value={code()}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
          <button
            type="submit"
            class="secondary-button"
            disabled={code().replace(/\D/g, "").length < 6 || props.busy}
          >
            Sign in
          </button>
        </form>
        <button
          type="button"
          class="text-button"
          onClick={() => setSent(false)}
        >
          Use another email
        </button>
      </Show>
    </>
  );
}
