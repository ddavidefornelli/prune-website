import { createSignal, Match, Show, Switch } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { PrivacyPolicyButton } from "../../components/PrivacyPolicyButton";
import { SHARE, SPACES } from "../constants";
import { SpaceState } from "../space-state";
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
export function ShareSheet(props: { share: ShareState; spaces: SpaceState }) {
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
              <Match when={flow().step === "start"}>
                <Start share={props.share} />
              </Match>
              <Match when={flow().step === "link" && flow()}>
                {(step) => (
                  <Link
                    share={props.share}
                    spaces={props.spaces}
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
          ? "Someone shared a list with you. Sign in to open it. Your own tasks stay in Personal."
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

/** Sharing Personal: what is in it becomes a new shared space, under this name. */
function Start(props: { share: ShareState }) {
  const [name, setName] = createSignal("");
  return (
    <form
      class="helper-sign-in"
      onSubmit={(event) => {
        event.preventDefault();
        void props.share.create(name());
      }}
    >
      <Illustration />
      <h2>Share this list</h2>
      <p class="helper-note">
        Your tasks move to a new shared space. Personal starts fresh, just for
        you.
      </p>
      <div class="helper-field">
        <input
          data-autofocus=""
          aria-label="Name"
          placeholder={SPACES.groupName}
          maxLength={SPACES.nameLength}
          enterkeyhint="go"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <button
          type="submit"
          class="primary-button"
          disabled={props.share.busy()}
        >
          Create link
        </button>
      </div>
    </form>
  );
}

function Link(props: {
  share: ShareState;
  spaces: SpaceState;
  joined: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  const space = () => props.spaces.open();

  async function copy(): Promise<void> {
    if (!(await props.share.copy())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), SHARE.copiedMs);
  }

  return (
    <div class="helper-sign-in">
      <Illustration />
      <h2>{props.joined ? "You're in" : SpaceState.label(space())}</h2>
      <p class="helper-note">
        {props.joined
          ? `You joined ${SpaceState.label(space())}. What anyone adds or ticks shows up for everyone, right away.`
          : "Anyone with this link can sign in and edit this space with you."}
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
      <Show when={space()?.kind === "group" && space()}>
        {(group) => (
          <>
            <label class="share-name">
              <span>Name</span>
              <input
                value={group().name}
                placeholder={SPACES.groupName}
                maxLength={SPACES.nameLength}
                enterkeyhint="done"
                onChange={(event) =>
                  void props.share.rename(event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
            <div class="share-status">
              <p class="helper-note">
                {group().people === 1
                  ? "Only you so far"
                  : `${group().people} people`}
              </p>
              <button
                type="button"
                class="text-button is-danger"
                disabled={props.share.busy()}
                onClick={() => void props.share.leave()}
              >
                {group().owner ? "Delete space" : "Leave space"}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
