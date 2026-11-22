import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { AccountClient } from "../cloud/account";
import { ListChannel } from "../cloud/realtime";
import { AddTask } from "./components/AddTask";
import { DoneTasks } from "./components/DoneTasks";
import { HelperSheet } from "./components/HelperSheet";
import { MenuSheet } from "./components/MenuSheet";
import { ShareSheet } from "./components/ShareSheet";
import { SpaceList, SpaceSheet, SpacesHeading } from "./components/SpaceList";
import { TaskItem } from "./components/TaskItem";
import { UndoBar } from "./components/UndoBar";
import { HelperState } from "./helper-state";
import { ListState } from "./list-state";
import { ShareState } from "./share-state";
import { SpaceState } from "./space-state";
import { browserStorage } from "./task-storage";

/** Personal's key for the keyed view below (a group space's is its id). */
const PERSONAL = "personal";

/**
 * prune: a list, open at once, nothing to sign up for. Signed in, it has
 * spaces, the way tldraw has files: Personal, and the shared ones.
 */
export function TaskApp() {
  const storage = browserStorage();
  const client = new AccountClient({ storage });
  onCleanup(() => void client.dispose());
  const spaces = new SpaceState(client, storage);
  const [list, setList] = createSignal<ListState | null>(null);
  const share = new ShareState(client, spaces, list);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  const people = () => spaces.open()?.people ?? 1;

  // Spaces with other people: their changes arrive the moment they are saved.
  const live = createMemo(() => spaces.live() && !!list()?.account());
  createEffect(() => {
    if (!live()) return;
    const channel = new ListChannel(
      () => client.realtimeAccess(),
      () => untrack(list)?.refresh(),
    );
    onCleanup(() => channel.close());
  });

  return (
    <div class="app has-spaces">
      <aside class="space-sidebar">
        <span class="wordmark">prune</span>
        <SpacesHeading onCreate={() => void share.startCreate()} />
        <SpaceList spaces={spaces} />
      </aside>
      <header class="app-header">
        <button
          type="button"
          class="space-button"
          aria-haspopup="dialog"
          onClick={() => setSwitcherOpen(true)}
        >
          <span>{SpaceState.label(spaces.open())}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
        {/* Sharing is the point: always in sight, never behind the menu. */}
        <button
          type="button"
          class="share-button"
          aria-label={people() > 1 ? `Shared · ${people()}` : "Share"}
          aria-haspopup="dialog"
          onClick={() => void share.open()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.5v11M8 7.5l4-4 4 4" />
            <path d="M8.5 10.5H7a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 007 20.5h10a1.5 1.5 0 001.5-1.5v-7a1.5 1.5 0 00-1.5-1.5h-1.5" />
          </svg>
          <Show when={people() > 1}>
            <span class="share-count" aria-hidden="true">
              {people()}
            </span>
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
      {/* One list per space: switching spaces starts that space's list afresh. */}
      <Show keyed when={spaces.current() ?? PERSONAL}>
        {(key) => (
          <SpaceView
            client={client}
            storage={storage}
            space={key === PERSONAL ? null : key}
            spaces={spaces}
            onList={(state) => setList(() => state)}
            onRelease={(state) =>
              setList((current) => (current === state ? null : current))
            }
          />
        )}
      </Show>
      <ShareSheet share={share} spaces={spaces} />
      <Show when={switcherOpen()}>
        <SpaceSheet
          spaces={spaces}
          onCreate={() => void share.startCreate()}
          onClose={() => setSwitcherOpen(false)}
        />
      </Show>
      <Show when={menuOpen() && list()}>
        {(state) => (
          <MenuSheet state={state()} onClose={() => setMenuOpen(false)} />
        )}
      </Show>
    </div>
  );
}

/** One space's list, with its own sync and "Do it for me". */
function SpaceView(props: {
  client: AccountClient;
  storage: Storage | null;
  space: string | null;
  spaces: SpaceState;
  onList: (state: ListState) => void;
  onRelease: (state: ListState) => void;
}) {
  // Fixed for the view's life: another space mounts another view.
  const { client, storage, space, spaces, onList, onRelease } = untrack(() => ({
    ...props,
  }));
  const state = new ListState(client, storage, {
    space,
    onSpaces: (list) => spaces.receive(list),
    onMissing: () => space && spaces.lost(space),
  });
  const helper = new HelperState(client, state, storage);
  onList(state);
  onCleanup(() => onRelease(state));

  return (
    <>
      <main class="list">
        <h1 class="visually-hidden">{SpaceState.label(props.spaces.open())}</h1>
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
    </>
  );
}
