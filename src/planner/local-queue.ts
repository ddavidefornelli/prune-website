import { CloudError } from "./cloud-error.ts";
import type { QueuedAction, TaskAction, TaskArguments } from "./commands.ts";
import { QUEUE } from "./constants.ts";
import { MESSAGES } from "./messages.ts";
import { PlannerSnapshot } from "./planner-snapshot.ts";
import type { Dashboard, Task, TaskStatus } from "./types.ts";

interface SavedState {
  version: typeof QUEUE.storageVersion;
  base: Dashboard | null;
  savedAt: number;
  pending: QueuedAction[];
  blocked: string | null;
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Lock = <T>(name: string, work: () => Promise<T>) => Promise<T>;

export interface LocalQueueOptions {
  key: string;
  storage: QueueStorage;
  lock: Lock;
  send: (command: QueuedAction) => Promise<Task>;
  fetchDashboard: () => Promise<Dashboard>;
}

const TASK_STATUSES: readonly TaskStatus[] = ["planned", "active", "completed"];

/** One atomic storage value contains the acknowledged snapshot AND its ordered outbox. No tokens. */
export class LocalQueue {
  private state: SavedState = LocalQueue.emptyState();
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number = QUEUE.initialRetryMs;
  private stopped = false;
  private lastError = "";
  onChange: () => void = () => {};
  private readonly key: string;
  private readonly storage: QueueStorage;
  private readonly lock: Lock;
  private readonly send: (command: QueuedAction) => Promise<Task>;
  private readonly fetchDashboard: () => Promise<Dashboard>;

  constructor(options: LocalQueueOptions) {
    this.key = options.key;
    this.storage = options.storage;
    this.lock = options.lock;
    this.send = options.send;
    this.fetchDashboard = options.fetchDashboard;
    this.load();
  }

  private static emptyState(): SavedState {
    return {
      version: QUEUE.storageVersion,
      base: null,
      savedAt: 0,
      pending: [],
      blocked: null,
    };
  }

  private static message(error: unknown): string {
    return CloudError.messageOf(error, MESSAGES.syncFailed);
  }

  /**
   * A successful HTTP status alone is not an acknowledgement. Keep the same
   * request identity so an ambiguous or broken response can be retried safely.
   */
  private static validateAcknowledgement(
    command: QueuedAction,
    task: Task,
  ): void {
    const expectedId =
      command.action === "create_task" ? command.requestId : command.args.id;
    const valid =
      !!task &&
      typeof task === "object" &&
      task.id === expectedId &&
      typeof task.outcome === "string" &&
      typeof task.plannedFor === "string" &&
      Number.isSafeInteger(task.estimatedMinutes) &&
      Number.isSafeInteger(task.actualSeconds) &&
      task.actualSeconds >= 0 &&
      Number.isSafeInteger(task.createdAt) &&
      TASK_STATUSES.includes(task.status) &&
      (task.startedAt === null || Number.isSafeInteger(task.startedAt)) &&
      (task.completedOn === null || typeof task.completedOn === "string") &&
      (task.serverRevision === undefined ||
        task.serverRevision === command.revision + 1);
    if (!valid) throw new Error(MESSAGES.incompleteAcknowledgement);
  }

  private get stateLock(): string {
    return `${this.key}:state`;
  }

  private get senderLock(): string {
    return `${this.key}:sender`;
  }

  private load(): void {
    const raw = this.storage.getItem(this.key);
    if (!raw) {
      this.state = LocalQueue.emptyState();
      return;
    }
    const saved = JSON.parse(raw) as SavedState;
    if (saved.version !== QUEUE.storageVersion || !Array.isArray(saved.pending))
      throw new Error(MESSAGES.queueUnreadable);
    this.state = saved;
  }

  private async update(work: () => void): Promise<void> {
    await this.lock(this.stateLock, async () => {
      this.load();
      const previous = structuredClone(this.state);
      try {
        work();
        this.storage.setItem(this.key, JSON.stringify(this.state));
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.onChange();
  }

  /** Storage events must read, not write, or two browser tabs create a sync loop. */
  async refreshFromStorage(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.lock(this.stateLock, async () => {
        this.load();
      });
      this.onChange();
      if (this.pendingCount && !this.blocked) await this.sync();
    } catch (error) {
      this.lastError = LocalQueue.message(error);
      this.onChange();
    }
  }

  get pendingCount(): number {
    return this.state.pending.length;
  }

  get status(): string {
    if (this.state.blocked) return MESSAGES.syncStopped(this.state.blocked);
    if (this.lastError)
      return MESSAGES.waitingToSync(this.lastError, this.pendingCount);
    return this.pendingCount
      ? MESSAGES.syncing(this.pendingCount)
      : MESSAGES.allSynced;
  }

  get blocked(): boolean {
    return !!this.state.blocked;
  }

  /** The server's reason for rejecting the first pending change, if any. */
  get blockedReason(): string | null {
    return this.state.blocked;
  }

  /** The acknowledged snapshot with every pending command replayed, as of now. */
  snapshot(): Dashboard | null {
    if (!this.state.base) return null;
    const snapshot = PlannerSnapshot.copy(this.state.base);
    for (const command of this.state.pending) snapshot.apply(command);
    const data = snapshot.data;
    data.serverNow += Math.max(0, Date.now() / 1000 - this.state.savedAt);
    return snapshot.alignTo(
      data.serverNow,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ).data;
  }

  async enqueue<Action extends TaskAction>(
    action: Action,
    args: TaskArguments[Action],
    timezone: string,
  ): Promise<Task> {
    let result!: Task;
    await this.update(() => {
      if (this.stopped) throw new Error(MESSAGES.queueClosed);
      if (this.state.blocked) throw new Error(MESSAGES.queueBlocked);
      const current = this.snapshot();
      if (!current) throw new Error(MESSAGES.queueNeedsSnapshot);
      const command: QueuedAction = {
        requestId: crypto.randomUUID(),
        action,
        args: structuredClone(args),
        timezone,
        at: Math.floor(current.serverNow),
        revision: current.revision ?? 0,
      };
      // Completing an older active task removes it from the dashboard's day
      // lists. Return the mutated task itself, not a lookup in the filtered view.
      result = PlannerSnapshot.own(current).apply(command);
      this.state.pending.push(command);
    });
    void this.sync();
    return structuredClone(result);
  }

  private scheduleRetry(delay: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.clearRetry();
    this.running = this.lock(this.senderLock, () => this.drain())
      .catch((error) => {
        this.lastError = LocalQueue.message(error);
        this.scheduleRetry(QUEUE.maxRetryMs);
      })
      .finally(() => {
        this.running = null;
        this.onChange();
        // An action can be enqueued during the final snapshot request.
        if (
          !this.stopped &&
          !this.retryTimer &&
          !this.state.blocked &&
          this.state.pending.length
        )
          void this.sync();
      });
    return this.running;
  }

  /** Sends pending commands in order, then refreshes the acknowledged snapshot. */
  private async drain(): Promise<void> {
    this.load();
    if (this.state.blocked || this.stopped) return;
    try {
      while (!this.stopped) {
        this.load();
        const command = this.state.pending[0];
        if (!command) break;
        const result = await this.send(command);
        LocalQueue.validateAcknowledgement(command, result);
        await this.update(() => {
          if (this.state.pending[0]?.requestId !== command.requestId)
            throw new Error(MESSAGES.queueChanged);
          this.state.base = PlannerSnapshot.project(
            this.state.base!,
            command,
            result,
          );
          this.state.pending.shift();
        });
      }
      if (this.stopped) return;
      const dashboard = await this.fetchDashboard();
      await this.update(() => {
        // An enqueue during this read may refer to a task from the previous day.
        // Keep its source snapshot until those actions have been acknowledged.
        if (!this.state.pending.length) {
          this.state.base = dashboard;
          this.state.savedAt = Date.now() / 1000;
        }
      });
      this.lastError = "";
      this.retryDelay = QUEUE.initialRetryMs;
    } catch (error) {
      if (
        CloudError.codeOf(error) === "validation" &&
        this.state.pending.length
      ) {
        await this.update(() => {
          this.state.blocked = LocalQueue.message(error);
        });
      } else {
        this.lastError = LocalQueue.message(error);
        this.scheduleRetry(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, QUEUE.maxRetryMs);
      }
    }
  }

  async discardPending(): Promise<void> {
    // Never discard an ambiguously committed request. Only a definitive rejection allows discarding.
    if (!this.blocked) throw new Error(MESSAGES.queueDiscardRefused);
    await this.lock(this.senderLock, () =>
      this.update(() => {
        // Another window may have resolved the rejection and enqueued new work.
        // Authorize discarding against the freshly loaded state, under both locks.
        if (!this.state.blocked) throw new Error(MESSAGES.queueDiscardRefused);
        this.state.pending = [];
        this.state.blocked = null;
      }),
    );
    this.lastError = "";
    void this.sync();
  }

  resume(): void {
    this.stopped = false;
    void this.sync();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    await this.running;
  }
}
