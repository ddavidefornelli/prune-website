import { createSignal, For, onCleanup, Show } from "solid-js";
import { AccountClient } from "../cloud/account";
import { AddTask } from "./components/AddTask";
import { DoneTasks } from "./components/DoneTasks";
import { MenuSheet } from "./components/MenuSheet";
import { TaskItem } from "./components/TaskItem";
import { UndoBar } from "./components/UndoBar";
import { ListState } from "./list-state";
import { browserStorage } from "./task-storage";

/** prune: one list, open at once. Nothing to sign up for. */
export function TaskApp() {
  const storage = browserStorage();
  const client = new AccountClient({ storage });
  onCleanup(() => void client.dispose());
  const state = new ListState(client, storage);
  const [menuOpen, setMenuOpen] = createSignal(false);

  return (
    <div class="app">
      <header class="app-header">
        <span class="wordmark">prune</span>
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
            {(id) => <TaskItem id={id} state={state} />}
          </For>
        </ul>
        <DoneTasks state={state} />
      </main>
      <UndoBar state={state} />
      <Show when={menuOpen()}>
        <MenuSheet state={state} onClose={() => setMenuOpen(false)} />
      </Show>
    </div>
  );
}
