import type { Dashboard, Task } from "./types.ts";
import type { QueuedAction, TaskAction, TaskArguments } from "./commands.ts";
import { alignDashboardDate } from "./dashboard.ts";
import { errorCode, errorMessage } from "./errors.ts";
import { applyCommand, project } from "./task-projection.ts";

export const QUEUE_STORAGE_VERSION = 1;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

interface SavedState {
  version: typeof QUEUE_STORAGE_VERSION;
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
const empty = (): SavedState => ({
  version: QUEUE_STORAGE_VERSION,
  base: null,
  savedAt: 0,
  pending: [],
  blocked: null,
});
const message = (error: unknown): string =>
  errorMessage(error, "Could not sync. Your changes remain on this device.");
function validateAcknowledgement(command: QueuedAction, task: Task): void {
  const expectedId =
    command.action === "create_task" ? command.requestId : command.args.id;
  if (
    !task ||
    typeof task !== "object" ||
    task.id !== expectedId ||
    typeof task.outcome !== "string" ||
    typeof task.plannedFor !== "string" ||
    typeof task.isPriority !== "boolean" ||
    !Number.isSafeInteger(task.estimatedMinutes) ||
    !Number.isSafeInteger(task.actualSeconds) ||
    task.actualSeconds < 0 ||
    !Number.isSafeInteger(task.createdAt) ||
    !["planned", "active", "completed"].includes(task.status) ||
    !(task.startedAt === null || Number.isSafeInteger(task.startedAt)) ||
    !(task.completedOn === null || typeof task.completedOn === "string") ||
    !Array.isArray(task.resources) ||
    task.resources.some(
      (resource) =>
        !resource ||
        typeof resource.id !== "string" ||
        typeof resource.label !== "string" ||
        typeof resource.target !== "string" ||
        !["file", "link"].includes(resource.kind),
    ) ||
    (task.serverRevision !== undefined &&
      task.serverRevision !== command.revision + 1)
  ) {
    // A successful HTTP status alone is not an acknowledgement. Keep the same
    // request identity so an ambiguous/broken response can be retried safely.
    throw new Error(
      "The server returned an incomplete acknowledgement. Your changes remain on this device; retry syncing.",
    );
  }
}

/** One atomic storage value contains the acknowledged snapshot AND its ordered outbox. No tokens. */
export class LocalQueue {
  private state: SavedState = empty();
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_MS;
  private stopped = false;
  private lastError = "";
  onChange: () => void = () => {};
  private readonly key: string;
  private readonly storage: QueueStorage;
  private readonly lock: Lock;
  private readonly send: (command: QueuedAction) => Promise<Task>;
  private readonly fetchDashboard: () => Promise<Dashboard>;
  constructor(
    key: string,
    storage: QueueStorage,
    lock: Lock,
    send: (command: QueuedAction) => Promise<Task>,
    fetchDashboard: () => Promise<Dashboard>,
  ) {
    this.key = key;
    this.storage = storage;
    this.lock = lock;
    this.send = send;
    this.fetchDashboard = fetchDashboard;
    this.load();
  }

  private load(): void {
    const raw = this.storage.getItem(this.key);
    if (!raw) {
      this.state = empty();
      return;
    }
    const saved = JSON.parse(raw) as SavedState;
    if (
      saved.version !== QUEUE_STORAGE_VERSION ||
      !Array.isArray(saved.pending)
    )
      throw new Error(
        "The local queue cannot be read. Do not clear app data; recover your pending changes first.",
      );
    this.state = saved;
  }
  private async update(work: () => void): Promise<void> {
    await this.lock(`${this.key}:state`, async () => {
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
      await this.lock(`${this.key}:state`, async () => {
        this.load();
      });
      this.onChange();
      if (this.pendingCount && !this.blocked) await this.sync();
    } catch (error) {
      this.lastError = message(error);
      this.onChange();
    }
  }
  get pendingCount(): number {
    return this.state.pending.length;
  }
  get status(): string {
    if (this.state.blocked)
      return `Sync stopped: ${this.state.blocked} Pending changes are kept on this device.`;
    if (this.lastError)
      return `${this.lastError} ${this.pendingCount} change(s) waiting to sync.`;
    return this.pendingCount
      ? `${this.pendingCount} change(s) saved on this device · syncing…`
      : "All changes synced";
  }
  get blocked(): boolean {
    return !!this.state.blocked;
  }
  /** The server's reason for rejecting the first pending change, if any. */
  get blockedReason(): string | null {
    return this.state.blocked;
  }
  snapshot(): Dashboard | null {
    if (!this.state.base) return null;
    const data = structuredClone(this.state.base);
    for (const command of this.state.pending) applyCommand(data, command);
    data.serverNow += Math.max(0, Date.now() / 1000 - this.state.savedAt);
    return alignDashboardDate(
      data,
      data.serverNow,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }
  async enqueue<Action extends TaskAction>(
    action: Action,
    args: TaskArguments[Action],
    timezone: string,
  ): Promise<Task> {
    let result!: Task;
    await this.update(() => {
      if (this.stopped) throw new Error("The local queue is closed.");
      if (this.state.blocked)
        throw new Error(
          "Resolve the sync conflict before making more changes.",
        );
      const current = this.snapshot();
      if (!current)
        throw new Error(
          "Connect once to load your planner before saving local changes.",
        );
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
      result = applyCommand(current, command);
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

  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.running = this.lock(`${this.key}:sender`, async () => {
      this.load();
      if (this.state.blocked || this.stopped) return;
      try {
        while (!this.stopped) {
          this.load();
          const command = this.state.pending[0];
          if (!command) break;
          const result = await this.send(command);
          validateAcknowledgement(command, result);
          await this.update(() => {
            if (this.state.pending[0]?.requestId !== command.requestId)
              throw new Error("Local queue changed during sync.");
            this.state.base = project(this.state.base!, command, result);
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
        this.retryDelay = INITIAL_RETRY_MS;
      } catch (error) {
        if (errorCode(error) === "validation" && this.state.pending.length) {
          await this.update(() => {
            this.state.blocked = message(error);
          });
        } else {
          this.lastError = message(error);
          this.scheduleRetry(this.retryDelay);
          this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
        }
      }
    })
      .catch((error) => {
        this.lastError = message(error);
        this.scheduleRetry(MAX_RETRY_MS);
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
  async discardPending(): Promise<void> {
    // Never discard an ambiguously committed request. Only a definitive rejection allows discarding.
    if (!this.blocked)
      throw new Error(
        "Only rejected changes can be discarded. Retry syncing first.",
      );
    await this.lock(`${this.key}:sender`, () =>
      this.update(() => {
        // Another window may have resolved the rejection and enqueued new work.
        // Authorize discarding against the freshly loaded state, under both locks.
        if (!this.state.blocked)
          throw new Error(
            "Only rejected changes can be discarded. Retry syncing first.",
          );
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.running;
  }
}
