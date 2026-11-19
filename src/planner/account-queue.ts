import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { CloudError } from "./cloud-error.ts";
import type { CloudTransport, QueuedAction } from "./commands.ts";
import { QUEUE } from "./constants.ts";
import { LocalQueue } from "./local-queue.ts";
import { MESSAGES } from "./messages.ts";
import type { Dashboard, Task } from "./types.ts";

/**
 * One account's outbox in this browser: Web Locks, account-scoped storage,
 * online/storage listeners and queue-protocol negotiation. The outbox itself
 * (`LocalQueue`) only persists and sends.
 */
export class AccountQueue {
  readonly queue: LocalQueue;
  private ready: Promise<void> | null = null;
  private readonly storageKey: string;
  private readonly accountKey: string;
  private readonly timezone: string;
  private readonly request: CloudTransport["execute"];

  constructor(
    accountKey: string,
    timezone: string,
    request: CloudTransport["execute"],
    onChange: () => void,
  ) {
    if (!navigator.locks) throw new Error(MESSAGES.webLocksRequired);
    this.accountKey = accountKey;
    this.timezone = timezone;
    this.request = request;
    this.storageKey = STORAGE_KEYS.plannerQueue(
      QUEUE.storageVersion,
      accountKey,
    );
    this.queue = new LocalQueue({
      key: this.storageKey,
      storage: localStorage,
      lock: async (name, work) => navigator.locks.request(name, work),
      send: (command) => this.send(command),
      fetchDashboard: () => this.call<Dashboard>("dashboard"),
    });
    this.queue.onChange = onChange;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("storage", this.onStorage);
  }

  dispose(): void {
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("storage", this.onStorage);
  }

  private readonly onOnline = () => void this.queue.sync();

  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === this.storageKey) void this.queue.refreshFromStorage();
  };

  private call<T>(
    action: string,
    args: Record<string, unknown> = {},
    timezone = this.timezone,
  ): Promise<T> {
    return this.request<T>("planner_call", {
      action,
      args: { ...args, _accountKey: this.accountKey },
      timezone,
    });
  }

  /** Never send retryable writes to a server that ignores idempotency keys. */
  private negotiate(): Promise<void> {
    this.ready ??= this.request<{ version: number }>("planner_call", {
      action: "queue_protocol",
      args: {},
      timezone: this.timezone,
    })
      .then((protocol) => {
        if (protocol?.version !== QUEUE.protocolVersion)
          throw new CloudError("configuration", MESSAGES.unsupportedProtocol);
      })
      .catch((error: unknown) => {
        this.ready = null;
        // Older dispatchers reject queue_protocol. This is not a rejected write:
        // the outbox must remain retryable, never discardable.
        if (CloudError.codeOf(error) === "validation")
          throw new CloudError("configuration", MESSAGES.unsupportedProtocol);
        throw error;
      });
    return this.ready;
  }

  private async send(command: QueuedAction): Promise<Task> {
    await this.negotiate();
    return this.call<Task>(
      command.action,
      {
        ...command.args,
        _requestId: command.requestId,
        _at: command.at,
        _revision: command.revision,
      },
      command.timezone,
    );
  }
}
