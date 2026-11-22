import { createSignal, Match, Show, Switch } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { PrivacyPolicyButton } from "../../components/PrivacyPolicyButton";
import { SHARE } from "../constants";
import type { ListState } from "../list-state";
import type { ShareFlow, ShareState } from "../share-state";
import { SignInForm } from "./SignInForm";

/** Two list cards, one behind the other: a list more than one person keeps. */
const Illustration = () => (
  <svg class="helper-illustration" viewBox="0 0 160 112" aria-hidden="true">
    <rect x="44" y="8" width="88" height="76" rx="14" class="is-faint" />
    <rect x="28" y="26" width="88" height="78" rx="14" class="is-card" />
    <circle cx="50" cy="50" r="7" />
    <path d="M46.5 50.5l2.6 2.6 5-5.4" />
    <path d="M66 50h34" />
    <circle cx="50" cy="76" r="7" />
    <path d="M66 76h26" />
  </svg>
);

/** Share: sign in, copy the link. Also where a link brings the person it was sent to. */
export function ShareSheet(props: { share: ShareState; list: ListState }) {
  return (
    <Show when={props.share.flow()}>
      {(flow) => (
        <Dialog
          class="sheet"
          aria-label="Share list"
          onDismiss={() => props.share.close()}
          onClick={(event) => {
            if (event.target === event.currentTarget) props.share.close();
          }}
          initialFocus={(dialog) =>
            dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus() ??
            dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus()
          }
        >
          <div class="sheet-body">
            <header class="sheet-header">
              <button
                type="button"
                class="sheet-close"
                aria-label="Close"
                onClick={() => props.share.close()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 7l10 10M17 7L7 17" />
                </svg>
              </button>
            </header>
            <Switch>
              <Match when={flow().step === "loading"}>
                <p class="helper-status" role="status">
                  <span class="helper-spinner" aria-hidden="true" />
                  One moment…
                </p>
              </Match>
              <Match when={flow().step === "sign_in" && flow()}>
                {(step) => (
                  <SignIn
                    share={props.share}
                    joining={
                      (step() as Extract<ShareFlow, { step: "sign_in" }>)
                        .joining
                    }
                  />
                )}
              </Match>
              <Match when={flow().step === "link" && flow()}>
                {(step) => (
                  <Link
                    share={props.share}
                    list={props.list}
                    joined={
                      (step() as Extract<ShareFlow, { step: "link" }>).joined
                    }
                  />
                )}
              </Match>
            </Switch>
            <Show when={props.share.error()}>
              <p class="error" role="alert">
                {props.share.error()}
              </p>
            </Show>
          </div>
        </Dialog>
      )}
    </Show>
  );
}

function SignIn(props: { share: ShareState; joining: boolean }) {
  return (
    <div class="helper-sign-in">
      <Illustration />
      <h2>{props.joining ? "Join a shared list" : "Share this list"}</h2>
      <p class="helper-note">
        {props.joining
          ? "Someone shared their list with you. Sign in to open it. Your tasks join theirs."
          : "Sign in, then send the link. Whoever opens it and signs in edits this list with you."}
      </p>
      <SignInForm
        busy={props.share.busy()}
        onGoogle={() => void props.share.google()}
        onSendCode={(email) => props.share.sendCode(email)}
        onVerify={(email, code) => void props.share.verifyCode(email, code)}
      />
      <p class="share-terms">
        By continuing you accept the <PrivacyPolicyButton />.
      </p>
    </div>
  );
}

function Link(props: { share: ShareState; list: ListState; joined: boolean }) {
  const [copied, setCopied] = createSignal(false);
  const sharing = () => props.list.sharing();

  async function copy(): Promise<void> {
    if (!(await props.share.copy())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), SHARE.copiedMs);
  }

  return (
    <div class="helper-sign-in">
      <Illustration />
      <h2>{props.joined ? "You're in" : "Share this list"}</h2>
      <p class="helper-note">
        {props.joined
          ? "This list is shared now. What anyone adds or ticks shows up for everyone."
          : "Anyone with this link can sign in and edit this list."}
      </p>
      <div class="helper-field">
        <input
          readOnly
          aria-label="Link"
          value={props.share.link()}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          class="primary-button"
          data-autofocus=""
          onClick={() => void copy()}
        >
          {copied() ? "Copied" : "Copy link"}
        </button>
      </div>
      <Show when={sharing()}>
        {(shared) => (
          <div class="share-status">
            <p class="helper-note">{shared().people} people share this list</p>
            <button
              type="button"
              class="text-button is-danger"
              disabled={props.share.busy()}
              onClick={() => void props.share.leave()}
            >
              {shared().role === "owner" ? "Stop sharing" : "Leave this list"}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
