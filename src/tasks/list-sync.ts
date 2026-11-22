import { CloudError } from "../cloud/cloud-error.ts";
import { LIST_SYNC } from "./constants.ts";
import type { TaskList } from "./task-list.ts";
import type { TaskStorage } from "./task-storage.ts";
import type { ListBatch, ListResponse } from "./types.ts";

interface ListSyncOptions {
  /**
   * Whose list this is (the account key). `create`: make a guest if there is
   * no account yet. Null when there is none (and none was made); throws while
   * the terms are not accepted.
   */
  identify: (create: boolean) => Promise<string | null>;
  send: (batch: ListBatch) => Promise<ListResponse>;
  storage: TaskStorage;
  /** A new list from the cloud; `refused` counts new tasks the full list refused. */
  onUpdate: (list: TaskList, refused: number) => void;
}

/** One sync at a time across this browser's tabs, so no answer undoes another tab's. */
const SYNC_LOCK = "prune:list-sync";

/**
 * Copies the device's list to the cloud and brings other devices' changes
 * back: soon after each edit, at once when the page is hidden or closed, when
 * it is shown or back online, and every half minute while it is visible. One
 * sync at a time. The list on the device is the one that counts: a sync that
 * fails is retried later, quietly, and never loses or blocks anything.
 */
export class ListSync {
  private readonly options: ListSyncOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private retryMs: number = LIST_SYNC.initialRetryMs;
  /** After a refused batch: send one change at a time, so only the bad one is dropped. */
  private oneByOne = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(options: ListSyncOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const soon = () => this.request(0);
    const shown = () => {
      if (document.visibilityState === "visible") soon();
    };
    // Leaving the page (another app, a closed tab): send what is waiting now,
    // not after the pause, which a hidden page may never get.
    const leaving = () => {
      if (document.visibilityState === "hidden") this.now();
    };
    const closing = () => this.now();
    window.addEventListener("online", soon);
    window.addEventListener("pagehide", closing);
    document.addEventListener("visibilitychange", shown);
    document.addEventListener("visibilitychange", leaving);
    this.cleanups.push(() => {
      window.removeEventListener("online", soon);
      window.removeEventListener("pagehide", closing);
      document.removeEventListener("visibilitychange", shown);
      document.removeEventListener("visibilitychange", leaving);
    });
    this.poll = setInterval(shown, LIST_SYNC.pollMs);
    soon();
  }

  /** Stops syncing and waits for a sync in flight to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    await this.running;
  }

  /** Syncs after `delay`, or sooner if one was already due. */
  request(delay: number = LIST_SYNC.debounceMs): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  /** Syncs straight away, without waiting for a timer. */
  private now(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = SyncLock.hold(() => this.cycle());
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    if (this.again) {
      this.again = false;
      this.request(0);
    }
  }

  private async cycle(): Promise<void> {
    const { storage, identify, send, onUpdate } = this.options;
    let owner: string | null;
    try {
      // A new guest only when there is something to keep.
      const local = storage.read();
      owner = await identify(local.tasks.length > 0 || local.hasPending);
    } catch (error) {
      // Not accepted yet: the first task asks again. Otherwise (offline,
      // guests switched off on the server…) try again later, patiently.
      if (CloudError.codeOf(error) !== "privacy")
        this.retry(LIST_SYNC.maxIdentityRetryMs);
      return;
    }
    if (!owner) return;
    let list = storage.read();
    if (list.owner !== owner) {
      list = list.adopt(owner);
      storage.write(list);
      onUpdate(list, 0);
    }
    const batch = list.batch(this.oneByOne ? 1 : undefined);
    try {
      const response = await send(batch);
      // Changes made while the request was out are on the stored copy.
      const next = storage.read().confirm(batch, response);
      storage.write(next);
      this.retryMs = LIST_SYNC.initialRetryMs;
      if (!next.hasPending) this.oneByOne = false;
      onUpdate(next, response.rejected.length);
      if (next.hasPending) this.request(0);
    } catch (error) {
      const changes = Object.keys(batch.sent).length;
      if (CloudError.codeOf(error) === "validation" && changes > 1) {
        // One change spoils the whole batch: find it without losing the rest.
        this.oneByOne = true;
        this.request(0);
        return;
      }
      if (CloudError.codeOf(error) === "validation" && changes) {
        // Sending it again would be refused again: let the cloud's copy win.
        const next = storage.read().discard(batch);
        storage.write(next);
        onUpdate(next, 0);
        this.request(0);
        return;
      }
      this.retry(LIST_SYNC.maxRetryMs);
    }
  }

  private retry(cap: number): void {
    this.request(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, cap);
  }
}

/** A Web Lock where the browser has them; elsewhere the work simply runs. */
class SyncLock {
  static hold(work: () => Promise<void>): Promise<void> {
    const locks = globalThis.navigator?.locks;
    if (!locks) return work();
    return locks.request(SYNC_LOCK, work) as Promise<unknown> as Promise<void>;
  }
}
