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
import type { Account } from "../cloud/types.ts";
import { LIST_TIMING } from "./constants.ts";
import { ListSync } from "./list-sync.ts";
import { TaskList } from "./task-list.ts";
import { browserStorage, TaskStorage } from "./task-storage.ts";
import type { ListResponse, Task } from "./types.ts";

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

  constructor(
    client: AccountClient,
    storage: Storage | null = browserStorage(),
  ) {
    this.client = client;
    TaskStorage.clearRetired(storage);
    this.storage = new TaskStorage(storage);
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
          return ListState.response(
            await client.syncList({
              save: changes.save,
              remove: changes.remove,
            }),
          );
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

  task(id: string): Task | undefined {
    return this.list().find(id);
  }

  /**
   * False when there was nothing to add. The first task records the terms
   * acknowledgement, which lets the list sync.
   */
  add(title: string): boolean {
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
    if (!this.change((list, now) => list.setDone(id, done, now))) return;
    if (done) {
      this.settle(id);
      analytics.capture("task_completed");
    } else this.unsettle(id);
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
