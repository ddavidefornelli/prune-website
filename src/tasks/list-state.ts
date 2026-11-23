import {
  batch,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type Setter,
} from "solid-js";
import { analytics } from "../analytics.ts";
import type { AccountClient } from "../cloud/account.ts";
import { CloudError } from "../cloud/cloud-error.ts";
import { MESSAGES } from "../cloud/messages.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import type { Account } from "../cloud/types.ts";
import { LIST_TIMING, OPEN_TASK_LIMIT } from "./constants.ts";
import { ListSync } from "./list-sync.ts";
import { TaskList } from "./task-list.ts";
import { browserStorage, TaskStorage } from "./task-storage.ts";
import type { ListResponse, Space, Task } from "./types.ts";

/** Which space a ListState is, and what it tells the space switcher. */
export interface ListOptions {
  /** A group space's id; Personal when left out. */
  space?: string | null;
  /** Every sync's answer lists the account's spaces. */
  onSpaces?: (spaces: Space[]) => void;
  /** The space is gone (deleted by its owner) or the caller left it elsewhere. */
  onMissing?: () => void;
}

/** Deleted tasks that one tap on Undo puts back. */
export interface UndoOffer {
  message: string;
  tasks: Task[];
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The list: what is on screen, what the person does to it, and its quiet
 * sync. The list on this device is the one that counts; it opens at once,
 * with or without a network or an account. Create it inside a Solid owner:
 * its sync, timers and listeners end with that owner.
 */
export class ListState {
  readonly list: Accessor<TaskList>;
  /** Not done, newest first; a task just ticked stays here for a moment. */
  readonly open: Accessor<Task[]>;
  /** Done, most recently finished first. */
  readonly done: Accessor<Task[]>;
  /** The same two halves as ids: rows keyed by id survive edits and syncs. */
  readonly openIds: Accessor<string[]>;
  readonly doneIds: Accessor<string[]>;
  readonly undo: Accessor<UndoOffer | null>;
  /** One short line about the list: only that it is full. */
  readonly notice: Accessor<string>;
  /** The account the list syncs with, once there is one. */
  readonly account: Accessor<Account | null>;
  readonly erasing: Accessor<boolean>;
  readonly eraseError: Accessor<string>;

  private readonly client: AccountClient;
  private readonly storage: TaskStorage;
  private readonly sync: ListSync;
  private readonly setList: Setter<TaskList>;
  private readonly setUndo: Setter<UndoOffer | null>;
  private readonly setNotice: Setter<string>;
  private readonly setErasing: Setter<boolean>;
  private readonly setEraseError: Setter<string>;
  private readonly setSettling: Setter<ReadonlySet<string>>;
  private readonly settleTimers = new Map<string, Timer>();
  private undoTimer: Timer | undefined;

  /** The space this list is (null: Personal). */
  readonly space: string | null;
  private readonly browser: Storage | null;

  constructor(
    client: AccountClient,
    storage: Storage | null = browserStorage(),
    options: ListOptions = {},
  ) {
    this.client = client;
    this.space = options.space ?? null;
    this.browser = storage;
    TaskStorage.clearRetired(storage);
    this.storage = new TaskStorage(storage, this.space);
    const [list, setList] = createSignal(this.storage.read());
    const [undo, setUndo] = createSignal<UndoOffer | null>(null);
    const [notice, setNotice] = createSignal("");
    const [account, setAccount] = createSignal<Account | null>(null);
    const [erasing, setErasing] = createSignal(false);
    const [eraseError, setEraseError] = createSignal("");
    const [settling, setSettling] = createSignal<ReadonlySet<string>>(
      new Set(),
    );
    this.list = list;
    this.setList = setList;
    this.undo = undo;
    this.setUndo = setUndo;
    this.notice = notice;
    this.setNotice = setNotice;
    this.account = account;
    this.erasing = erasing;
    this.setErasing = setErasing;
    this.eraseError = eraseError;
    this.setEraseError = setEraseError;
    this.setSettling = setSettling;
    const view = createMemo(() => list().view(settling()));
    this.open = createMemo(() => view().open);
    this.done = createMemo(() => view().done);
    const ids = (tasks: () => Task[]) =>
      createMemo(() => tasks().map((task) => task.id), [], {
        equals: (a, b) =>
          a.length === b.length && a.every((id, index) => id === b[index]),
      });
    this.openIds = ids(this.open);
    this.doneIds = ids(this.done);

    this.sync = new ListSync({
      identify: async (create) => {
        const current = await client.ensureAccount(create);
        if (!current) return null;
        setAccount(current);
        analytics.identify(current.accountKey, current.email);
        return current.accountKey;
      },
      send: async (changes) => {
        try {
          const body = await client.syncList(
            { save: changes.save, remove: changes.remove },
            this.space,
          );
          const response = ListState.response(body);
          const spaces = ListState.readSpaces(body);
          if (spaces) options.onSpaces?.(spaces);
          return response;
        } catch (error) {
          await this.recover(error);
          throw error;
        }
      },
      storage: this.storage,
      onUpdate: (next, refused) => {
        setList(next);
        if (refused) setNotice(MESSAGES.listFull);
      },
      carryOver: this.space === null,
      onMissing: () => {
        this.storage.clear();
        options.onMissing?.();
      },
    });
    const unwatch = this.storage.watch(() => setList(this.storage.read()));
    this.sync.start();
    onCleanup(() => {
      unwatch();
      void this.sync.stop();
      clearTimeout(this.undoTimer);
      this.settleTimers.forEach((timer) => clearTimeout(timer));
    });
  }

  /** The cloud's answer, checked before anything trusts its shape. */
  private static response(value: unknown): ListResponse {
    const body = value as Partial<ListResponse> | null;
    if (!Array.isArray(body?.tasks) || !Array.isArray(body?.rejected))
      throw new CloudError("server", MESSAGES.incompleteResponse);
    return {
      tasks: body.tasks,
      rejected: body.rejected.filter((id) => typeof id === "string"),
    };
  }

  /** The spaces in a sync's answer, or null when it has none (an older backend). */
  private static readSpaces(value: unknown): Space[] | null {
    const spaces = (value as { spaces?: unknown } | null)?.spaces;
    if (!Array.isArray(spaces)) return null;
    return spaces
      .filter(
        (space): space is Space =>
          typeof space?.id === "string" &&
          (space.kind === "personal" || space.kind === "group") &&
          typeof space.name === "string" &&
          typeof space.owner === "boolean",
      )
      .map((space) => ({ ...space, people: Number(space.people) || 1 }));
  }

  /** Syncs now: someone else changed this space. */
  refresh(): void {
    this.sync.request(0);
  }

  /** Syncs now and waits, so the cloud has everything this device has. */
  flush(): Promise<void> {
    return this.sync.flush();
  }

  task(id: string): Task | undefined {
    return this.list().find(id);
  }

  /**
   * False when there was nothing to add. The first task records the terms
   * acknowledgement, which lets the list sync.
   */
  add(title: string): boolean {
    if (!TaskList.cleanTitle(title)) return false;
    if (this.atOpenLimit()) return false;
    if (!this.change((list, now) => list.add(title, now))) return false;
    if (!this.client.accepted && this.client.accept()) this.sync.request(0);
    analytics.capture("task_created");
    return true;
  }

  /** An emptied title deletes the task (with Undo). */
  rename(id: string, title: string): void {
    if (!TaskList.cleanTitle(title)) {
      this.remove(id);
      return;
    }
    if (this.change((list, now) => list.rename(id, title, now)))
      analytics.capture("task_renamed");
  }

  toggle(id: string): void {
    const task = this.list().find(id);
    if (!task) return;
    const done = !task.done;
    if (!done && this.atOpenLimit()) return;
    if (!this.change((list, now) => list.setDone(id, done, now))) return;
    if (done) {
      this.settle(id);
      analytics.capture("task_completed");
    } else this.unsettle(id);
  }

  /** Plans the task for the hour starting at `startAt`; null takes it off the calendar. */
  schedule(id: string, startAt: number | null): boolean {
    if (!this.change((list, now) => list.schedule(id, startAt, now)))
      return false;
    analytics.capture(startAt === null ? "task_unscheduled" : "task_scheduled");
    return true;
  }

  /** The task's description; links in it open from the calendar. */
  describe(id: string, notes: string): void {
    if (this.change((list, now) => list.setNotes(id, notes, now)))
      analytics.capture("task_described");
  }

  /** How long the task takes on the calendar. */
  resize(id: string, minutes: number): void {
    if (this.change((list, now) => list.setMinutes(id, minutes, now)))
      analytics.capture("task_resized");
  }

  remove(id: string): void {
    const task = this.list().find(id);
    if (!task || !this.change((list, now) => list.remove([id], now))) return;
    this.unsettle(id);
    this.offerUndo("Task deleted", [task]);
    analytics.capture("task_deleted");
  }

  clearDone(): void {
    const done = this.done();
    if (!done.length) return;
    const ids = done.map((task) => task.id);
    if (!this.change((list, now) => list.remove(ids, now))) return;
    this.offerUndo(
      done.length === 1 ? "1 task cleared" : `${done.length} tasks cleared`,
      done,
    );
    analytics.capture("done_cleared", { count: done.length });
  }

  undoLast(): void {
    const offer = this.undo();
    if (!offer) return;
    this.dismissUndo();
    this.change((list, now) => list.restore(offer.tasks, now));
  }

  dismissUndo(): void {
    clearTimeout(this.undoTimer);
    this.setUndo(null);
  }

  /** Erases the list here and in the cloud, and starts again as a new guest. */
  async eraseEverything(): Promise<void> {
    if (this.erasing() || !window.confirm(MESSAGES.confirmErase)) return;
    batch(() => {
      this.setErasing(true);
      this.setEraseError("");
    });
    await this.sync.stop();
    try {
      await this.client.eraseEverything();
      this.storage.clear();
      TaskStorage.clearSpaces(this.browser);
      try {
        this.browser?.removeItem(STORAGE_KEYS.spaces);
      } catch {
        // Only the switcher's cache: the next account starts with Personal anyway.
      }
      analytics.capture("everything_erased");
      analytics.forgetAccount();
      window.location.reload();
    } catch {
      batch(() => {
        this.setEraseError(MESSAGES.eraseFailed);
        this.setErasing(false);
      });
      this.sync.start();
    }
  }

  /** Deleted elsewhere, or the session is gone: never keep showing that account's list. */
  private async recover(error: unknown): Promise<void> {
    const code = CloudError.codeOf(error);
    if (code === "account_deleted") {
      // Called from inside a sync, so not awaited: stopping waits for that sync.
      void this.sync.stop();
      this.storage.clear();
      await this.client.forget();
      window.location.reload();
    } else if (code === "unauthorized" || code === "account_changed")
      window.location.reload();
  }

  /** Applies a change to the stored list (other tabs' edits included) and saves it. */
  /** True (and says so) when the list already has its five open tasks. */
  private atOpenLimit(): boolean {
    const open = this.open().filter((task) => !task.done).length;
    if (open < OPEN_TASK_LIMIT) return false;
    this.setNotice(MESSAGES.openLimit);
    return true;
  }

  private change(apply: (list: TaskList, now: number) => TaskList): boolean {
    const before = this.storage.read();
    const next = apply(before, Date.now());
    if (next === before) {
      this.setList(before);
      return false;
    }
    this.storage.write(next);
    this.setList(next);
    this.setNotice("");
    this.sync.request();
    return true;
  }

  private offerUndo(message: string, tasks: Task[]): void {
    clearTimeout(this.undoTimer);
    this.setUndo({ message, tasks });
    this.undoTimer = setTimeout(() => this.setUndo(null), LIST_TIMING.undoMs);
  }

  private settle(id: string): void {
    clearTimeout(this.settleTimers.get(id));
    this.setSettling((ids) => new Set(ids).add(id));
    this.settleTimers.set(
      id,
      setTimeout(() => this.unsettle(id), LIST_TIMING.settleMs),
    );
  }

  private unsettle(id: string): void {
    clearTimeout(this.settleTimers.get(id));
    this.settleTimers.delete(id);
    this.setSettling((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }
}
