import { createSignal, For, onCleanup, Show } from "solid-js";
import { AccountClient } from "../cloud/account";
import { AddTask } from "./components/AddTask";
import { DoneTasks } from "./components/DoneTasks";
import { HelperSheet } from "./components/HelperSheet";
import { MenuSheet } from "./components/MenuSheet";
import { ShareSheet } from "./components/ShareSheet";
import { TaskItem } from "./components/TaskItem";
import { UndoBar } from "./components/UndoBar";
import { HelperState } from "./helper-state";
import { ListState } from "./list-state";
import { ShareState } from "./share-state";
import { browserStorage } from "./task-storage";

/** prune: one list, open at once. Nothing to sign up for. */
export function TaskApp() {
  const storage = browserStorage();
  const client = new AccountClient({ storage });
  onCleanup(() => void client.dispose());
  const state = new ListState(client, storage);
  const helper = new HelperState(client, state, storage);
  const share = new ShareState(client, state);
  const [menuOpen, setMenuOpen] = createSignal(false);

  return (
    <div class="app">
      <header class="app-header">
        <span class="wordmark">prune</span>
        {/* Sharing is the point: always in sight, never behind the menu. */}
        <button
          type="button"
          class="share-button"
          aria-label={
            state.sharing() ? `Shared · ${state.sharing()!.people}` : "Share"
          }
          aria-haspopup="dialog"
          onClick={() => void share.open()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.5v11M8 7.5l4-4 4 4" />
            <path d="M8.5 10.5H7a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 007 20.5h10a1.5 1.5 0 001.5-1.5v-7a1.5 1.5 0 00-1.5-1.5h-1.5" />
          </svg>
          <Show when={state.sharing()}>
            {(shared) => (
              <span class="share-count" aria-hidden="true">
                {shared().people}
              </span>
            )}
          </Show>
        </button>
        <button
          type="button"
          class="menu-button"
          aria-label="Menu"
          aria-haspopup="dialog"
          onClick={() => setMenuOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="19" cy="12" r="1.75" />
          </svg>
        </button>
      </header>
      <main class="list">
        <h1 class="visually-hidden">Tasks</h1>
        <AddTask onAdd={(title) => state.add(title)} />
        <Show when={state.notice()}>
          <p class="notice" role="alert">
            {state.notice()}
          </p>
        </Show>
        <ul class="tasks" aria-label="To do">
          <For each={state.openIds()}>
            {(id) => <TaskItem id={id} state={state} helper={helper} />}
          </For>
        </ul>
        <DoneTasks state={state} />
      </main>
      <UndoBar state={state} />
      <HelperSheet helper={helper} list={state} />
      <ShareSheet share={share} list={state} />
      <Show when={menuOpen()}>
        <MenuSheet state={state} onClose={() => setMenuOpen(false)} />
      </Show>
    </div>
  );
}
