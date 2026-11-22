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

/**
 * Copies the device's list to the cloud and brings other devices' changes
 * back: soon after each edit, when the page is shown or back online, and every
 * half minute while it is visible. One sync at a time. The list on the device
 * is the one that counts: a sync that fails is retried later, quietly, and
 * never loses or blocks anything.
 */
export class ListSync {
  private readonly options: ListSyncOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private retryMs: number = LIST_SYNC.initialRetryMs;
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
    window.addEventListener("online", soon);
    document.addEventListener("visibilitychange", shown);
    this.cleanups.push(() => {
      window.removeEventListener("online", soon);
      document.removeEventListener("visibilitychange", shown);
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

  private async run(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.cycle();
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
    const batch = list.batch();
    try {
      const response = await send(batch);
      // Changes made while the request was out are on the stored copy.
      const next = storage.read().confirm(batch, response);
      storage.write(next);
      this.retryMs = LIST_SYNC.initialRetryMs;
      onUpdate(next, response.rejected.length);
      if (next.hasPending) this.request(0);
    } catch (error) {
      if (
        CloudError.codeOf(error) === "validation" &&
        Object.keys(batch.sent).length
      ) {
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
