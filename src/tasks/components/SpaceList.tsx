import { For } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { SpaceState } from "../space-state";
import type { Space } from "../types";

const PersonalIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 19.5c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </svg>
);

const GroupIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="9" cy="8.5" r="3.25" />
    <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <path d="M16 5.6a3.25 3.25 0 010 5.8M17.5 14.3c1.6.6 2.7 2.2 3 4.7" />
  </svg>
);

/** Every space, Personal first: tap one to open it. The laptop sidebar and the phone sheet. */
export function SpaceList(props: {
  spaces: SpaceState;
  onSelect?: () => void;
}) {
  const isOpen = (space: Space) =>
    space.kind === "personal"
      ? props.spaces.current() === null
      : props.spaces.current() === space.id;

  return (
    <nav class="space-list" aria-label="Spaces">
      <For each={props.spaces.spaces()}>
        {(space) => (
          <button
            type="button"
            class="space-row"
            classList={{ "is-open": isOpen(space) }}
            aria-current={isOpen(space) ? "page" : undefined}
            onClick={() => {
              props.spaces.select(space.kind === "personal" ? null : space.id);
              props.onSelect?.();
            }}
          >
            {space.kind === "personal" ? <PersonalIcon /> : <GroupIcon />}
            <span class="space-row-name">{SpaceState.label(space)}</span>
            {space.kind === "group" && (
              <span class="space-row-people">{space.people}</span>
            )}
          </button>
        )}
      </For>
    </nav>
  );
}

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** "Spaces", and the + that makes a new one. */
export function SpacesHeading(props: { onCreate: () => void }) {
  return (
    <div class="spaces-heading">
      <h2 class="sheet-title">Spaces</h2>
      <button
        type="button"
        class="space-add"
        aria-label="New space"
        aria-haspopup="dialog"
        onClick={() => props.onCreate()}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/** The space list on phones, from the space name in the header. */
export function SpaceSheet(props: {
  spaces: SpaceState;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      class="sheet"
      aria-label="Spaces"
      onDismiss={() => props.onClose()}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
      initialFocus={(dialog) =>
        dialog.querySelector<HTMLButtonElement>(".space-row.is-open")?.focus()
      }
    >
      <div class="sheet-body">
        <header class="sheet-header">
          <SpacesHeading
            onCreate={() => {
              props.onClose();
              props.onCreate();
            }}
          />
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
        <SpaceList spaces={props.spaces} onSelect={() => props.onClose()} />
      </div>
    </Dialog>
  );
}
