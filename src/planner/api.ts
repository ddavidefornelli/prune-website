import { createAccountQueue } from "./account-queue.ts";
import { BrowserCloud } from "./browser.ts";
import type {
  CloudTransport,
  PlannerQueries,
  TaskAction,
  TaskArguments,
} from "./commands.ts";
import { WEEKLY_AI_VERSION } from "./constants.ts";
import { errorCode } from "./errors.ts";
import type { LocalQueue } from "./local-queue.ts";
import type {
  AuthStatus,
  Dashboard,
  EmailPreferences,
  MonthStats,
  Task,
  TaskSuggestion,
  WeeklyOverview,
} from "./types.ts";

type SuggestionTarget = "today" | "tomorrow";

interface PlanningClientOptions {
  cloud?: CloudTransport;
}

/** Coordinates account access. Stores and transports own their own persistence. */
export class PlanningClient {
  private readonly cloud: CloudTransport;
  private readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private readonly cleanups: (() => void)[] = [];
  private queue: LocalQueue | null = null;
  private accountKey: string | null = null;
  private disposed = false;
  private generatingReview = false;
  private readonly suggestions = new Map<
    SuggestionTarget,
    { key: string; result: Promise<TaskSuggestion[]> }
  >();
  onQueueChange: () => void = () => {};

  constructor({ cloud = new BrowserCloud() }: PlanningClientOptions = {}) {
    this.cloud = cloud;
    this.cloud.onAccountChange = () => {
      void this.queue?.stop();
      window.location.reload();
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.onQueueChange = () => {};
    this.cloud.onAccountChange = () => {};
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    await Promise.all([this.queue?.stop(), this.cloud.dispose()]);
  }

  get pendingCount(): number {
    return this.queue?.pendingCount ?? 0;
  }

  get syncBlocked(): boolean {
    return this.queue?.blocked ?? false;
  }

  cachedDashboard(): Dashboard | null {
    return this.queue?.snapshot() ?? null;
  }

  sync(): Promise<void> {
    return this.queue?.sync() ?? Promise.resolve();
  }

  discardPending(): Promise<void> {
    return this.queue?.discardPending() ?? Promise.resolve();
  }

  private prepareQueue(accountKey: string): void {
    if (this.queue) {
      if (accountKey !== this.accountKey)
        throw new Error(
          "The account changed. Reload before accessing planner data.",
        );
      return;
    }
    const { queue, dispose } = createAccountQueue(
      accountKey,
      this.timezone,
      (command, args) => this.request(command, args),
      () => this.onQueueChange(),
    );
    this.accountKey = accountKey;
    this.queue = queue;
    this.cleanups.push(dispose);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("The planner client is closed.");
  }

  private async request<T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    this.assertOpen();
    try {
      const result = await this.cloud.execute<T>(command, args);
      this.assertOpen();
      return result;
    } catch (error) {
      if (this.disposed) throw error;
      const code = errorCode(error);
      if (code === "account_deleted") {
        await this.cloud.execute("sign_out");
        window.location.reload();
      }
      if (
        this.accountKey &&
        ["unauthorized", "account_changed"].includes(code)
      ) {
        // Never keep old account data visible after credentials or identity change.
        window.location.reload();
      }
      throw error;
    }
  }

  private query<Action extends keyof PlannerQueries>(
    action: Action,
    args: Record<string, unknown> = {},
  ): Promise<PlannerQueries[Action]> {
    return this.request("planner_call", {
      action,
      args: {
        ...args,
        ...(this.accountKey ? { _accountKey: this.accountKey } : {}),
      },
      timezone: this.timezone,
    });
  }

  private async mutate<Action extends TaskAction>(
    action: Action,
    args: TaskArguments[Action],
  ): Promise<Task> {
    this.assertOpen();
    if (!this.queue)
      throw new Error("Sign in and load your planner before making changes.");
    return this.queue.enqueue(action, args, this.timezone);
  }

  private async loadAccount(status: AuthStatus): Promise<AuthStatus> {
    if (!status.accountKey) return status;
    // Only a verified identity may unlock its cached planner during a network outage.
    this.prepareQueue(status.accountKey);
    let account: { isDeleted: boolean };
    try {
      account = await this.query("account_status");
    } catch (error) {
      if (errorCode(error) === "network" && this.cachedDashboard())
        return status;
      throw error;
    }
    if (account.isDeleted) {
      await this.queue?.stop();
      await this.request("sign_out");
      throw new Error(
        "This account has been marked for deletion and can no longer be used.",
      );
    }
    return status;
  }

  async authStatus(): Promise<AuthStatus> {
    return this.loadAccount(await this.request<AuthStatus>("auth_status"));
  }

  /** Leaves the page for Google; authStatus() completes the return trip. */
  async sendCode(email: string): Promise<void> {
    await this.request("send_code", { email });
  }

  async verifyCode(email: string, code: string): Promise<AuthStatus> {
    return this.loadAccount(
      await this.request<AuthStatus>("verify_code", { email, code }),
    );
  }

  async signInWithGoogle(): Promise<void> {
    await this.request("sign_in_with_google");
  }

  /** Failed online account operations may resume the outbox; confirmed deletion may not. */
  private async withQueueStopped(work: () => Promise<void>): Promise<void> {
    await this.queue?.stop();
    try {
      await work();
    } catch (error) {
      if (!this.disposed) this.queue?.resume();
      throw error;
    }
  }

  async signOut(): Promise<void> {
    await this.withQueueStopped(() => this.request("sign_out"));
  }

  async deleteAccount(): Promise<void> {
    await this.withQueueStopped(async () => {
      const result = await this.query("delete_account");
      if (result?.isDeleted !== true)
        throw new Error(
          "Account deletion was not confirmed. Please try again.",
        );
    });
    // Do not resume the outbox if local sign-out fails after confirmed deletion.
    await this.request("sign_out");
  }

  async generateIfDue(): Promise<void> {
    if (this.generatingReview) return;
    this.generatingReview = true;
    try {
      const overview = await this.weeklyOverview();
      if (
        overview.settings.enabled &&
        overview.available &&
        ["pending", "failed"].includes(overview.status)
      )
        await this.retryWeeklyReview();
    } finally {
      this.generatingReview = false;
    }
  }

  async dashboard(): Promise<Dashboard> {
    this.assertOpen();
    if (!this.queue) return this.query("dashboard");
    let cached = this.queue.snapshot();
    if (!cached) {
      await this.queue.sync();
      cached = this.queue.snapshot();
    } else void this.queue.sync();
    if (!cached) throw new Error(this.queue.status);
    return cached;
  }

  /** `month` is YYYY-MM. Read-only and never queued: offline, the stats are simply absent. */
  async monthStats(month: string): Promise<MonthStats> {
    this.assertOpen();
    return this.query("month_stats", { month });
  }

  /** Never queued: a preference must not be replayed later over a newer choice. */
  async emailPreferences(): Promise<EmailPreferences> {
    this.assertOpen();
    return this.query("email_preferences");
  }

  async setEmailPreferences(
    preferences: EmailPreferences,
  ): Promise<EmailPreferences> {
    this.assertOpen();
    return this.query("set_email_preferences", { ...preferences });
  }

  async weeklyOverview(): Promise<WeeklyOverview> {
    this.assertOpen();
    return this.query("weekly_overview");
  }

  /** One-way: the server refuses to turn weekly reviews off. */
  async enableWeeklyAi(): Promise<WeeklyOverview> {
    this.assertOpen();
    return this.query("set_weekly_ai_enabled", {
      enabled: true,
      consentVersion: WEEKLY_AI_VERSION,
    });
  }

  /**
   * Proposals for `day` derived from the day before. One paid request per
   * target, day and source-plan version; failures fall back to no proposals.
   */
  suggestTasks(
    target: SuggestionTarget,
    day: string,
    sourceVersion = "",
  ): Promise<TaskSuggestion[]> {
    this.assertOpen();
    const key = `${day}:${sourceVersion}`;
    const cached = this.suggestions.get(target);
    if (cached?.key === key) return cached.result;
    // Reloads reuse the last answer so they never spend the daily allowance.
    const storageKey = `prune:suggestions:v1:${this.accountKey}:${target}`;
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (stored?.key === key && Array.isArray(stored.suggestions)) {
        const result = Promise.resolve(stored.suggestions as TaskSuggestion[]);
        this.suggestions.set(target, { key, result });
        return result;
      }
    } catch {
      /* Without storage, fall back to one request per page. */
    }
    const result = this.request<{ day: string; suggestions: TaskSuggestion[] }>(
      "suggest_tasks",
      { timezone: this.timezone, target },
    )
      .then((value) => {
        if (value.day !== day) return [];
        try {
          localStorage.setItem(
            storageKey,
            JSON.stringify({ key, suggestions: value.suggestions }),
          );
        } catch {
          /* Caching is best-effort. */
        }
        return value.suggestions;
      })
      .catch(() => []);
    this.suggestions.set(target, { key, result });
    return result;
  }

  private async retryWeeklyReview(): Promise<void> {
    await this.request("generate_weekly_review", { timezone: this.timezone });
  }

  create(
    outcome: string,
    day: string,
    estimatedMinutes: number,
  ): Promise<Task> {
    return this.mutate("create_task", { outcome, day, estimatedMinutes });
  }

  rename(id: string, outcome: string): Promise<Task> {
    return this.mutate("rename_task", { id, outcome });
  }

  changeEstimate(id: string, minutes: number): Promise<Task> {
    return this.mutate("change_estimate", { id, minutes });
  }

  start(id: string): Promise<Task> {
    return this.mutate("start_task", { id });
  }

  stopTimer(id: string): Promise<Task> {
    return this.mutate("stop_timer", { id });
  }

  async savePauseReason(id: string, reason: string): Promise<void> {
    await this.mutate("save_pause_reason", { id, reason });
  }

  resume(id: string): Promise<Task> {
    return this.mutate("resume_task", { id });
  }

  complete(id: string): Promise<Task> {
    return this.mutate("complete_task", { id });
  }
}
