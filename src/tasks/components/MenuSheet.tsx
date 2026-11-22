import { Show } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { PrivacyPolicyButton } from "../../components/PrivacyPolicyButton";
import { APP_EVENTS } from "../../shared/storage-keys";
import type { ListState } from "../list-state";

/** The few things beside the list: the terms, cookies, and deleting everything. Share sits in the header. */
export function MenuSheet(props: { state: ListState; onClose: () => void }) {
  // The banner sits behind this sheet's backdrop, so the sheet closes first.
  function openCookieSettings(): void {
    props.onClose();
    window.dispatchEvent(new Event(APP_EVENTS.openPrivacyPreferences));
  }

  return (
    <Dialog
      class="sheet"
      aria-label="Menu"
      onDismiss={() => props.onClose()}
      onClick={(event) => {
        // A tap on the backdrop (the dialog itself, outside its content) closes it.
        if (event.target === event.currentTarget) props.onClose();
      }}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus()
      }
    >
      <div class="sheet-body">
        <header class="sheet-header">
          {/* Accounts from before guests show whose list this is. */}
          <Show when={props.state.account()?.email}>
            {(email) => <p class="sheet-email">{email()}</p>}
          </Show>
          <button
            type="button"
            class="sheet-close"
            aria-label="Close"
            onClick={() => props.onClose()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </header>
        <div class="sheet-rows">
          <PrivacyPolicyButton label="Terms & Privacy" />
          <button type="button" class="sheet-row" onClick={openCookieSettings}>
            Cookie settings
          </button>
          <button
            type="button"
            class="sheet-row is-danger"
            disabled={props.state.erasing()}
            onClick={() => void props.state.eraseEverything()}
          >
            {props.state.erasing() ? "Deleting…" : "Delete everything"}
          </button>
        </div>
        <p class="error" role="alert">
          {props.state.eraseError()}
        </p>
      </div>
    </Dialog>
  );
}
