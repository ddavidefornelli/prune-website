import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store";
import { analytics } from "../analytics.ts";
import { onWake } from "../shared/on-wake.ts";
import { TIME } from "../shared/time-constants.ts";
import type { PlanningClient } from "./api.ts";
import { CloudError } from "./cloud-error.ts";
import { PLANNER_LIMITS, POLLING, type PlannerView } from "./constants.ts";
import { DayPlan } from "./day-plan.ts";
import { MESSAGES } from "./messages.ts";
import type { Dashboard } from "./types.ts";

type AccountAction = "signOut" | "delete";

/** The button that discards a rejected change. */
const DISCARD_BUTTON = ".sync-bar button";

/**
 * One session's reactive planner UI state. The client alone owns persistence,
 * queueing and transport. Create it inside a Solid owner: its timers and
 * listeners end with that owner.
 */
export class PlannerState {
  readonly data: Accessor<Dashboard | null>;
  /** The view on screen; a running timer keeps it on Focus. */
  readonly view: Accessor<PlannerView>;
  readonly busy: Accessor<boolean>;
  readonly error: Accessor<string>;
  /** Server-aligned epoch seconds, ticking every second. */
  readonly now: Accessor<number>;
  /** The device clock in milliseconds, ticking every second. */
  readonly clock: Accessor<number>;
  readonly todayComplete: Accessor<boolean>;
  readonly focusLocked: Accessor<boolean>;
  /** Tasks finished today, 0 to five. */
  readonly completionLevel: Accessor<number>;
  readonly syncBlocked: Accessor<boolean>;
  readonly syncBlockedReason: Accessor<string | null>;
  readonly pauseReasonOpen: Accessor<boolean>;
  readonly setPauseReasonOpen: Setter<boolean>;
  /** The focus scratchpad: memory-only, reset when the active task changes. */
  readonly notes: Accessor<string>;
  readonly setNotes: Setter<string>;
  readonly accountAction: Accessor<AccountAction | null>;

  private readonly client: PlanningClient;
  private readonly setData: SetStoreFunction<{ data: Dashboard | null }>;
  private readonly setView: Setter<PlannerView>;
  private readonly setBusy: Setter<boolean>;
  private readonly setError: Setter<string>;
  private readonly setSyncBlocked: Setter<boolean>;
  private readonly setSyncBlockedReason: Setter<string | null>;
  private readonly setClock: Setter<number>;
  private readonly setClockOffset: Setter<number>;
  private readonly setAccountAction: Setter<AccountAction | null>;
  /** The last applied dashboard without its clock, to skip unchanged refreshes. */
  private signature = "";
  private refreshing = false;
  private disposed = false;
  private initialLoad = true;

  constructor(client: PlanningClient) {
    this.client = client;
    const [state, setState] = createStore<{ data: Dashboard | null }>({
      data: null,
    });
    this.setData = setState;
    this.data = createMemo(() => state.data);
    const [view, setView] = createSignal<PlannerView>("today");
    this.setView = setView;
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal("");
    const [syncBlocked, setSyncBlocked] = createSignal(client.syncBlocked);
    const [syncBlockedReason, setSyncBlockedReason] = createSignal(
      client.syncBlockedReason,
    );
    const [pauseReasonOpen, setPauseReasonOpen] = createSignal(false);
    const [clock, setClock] = createSignal(Date.now());
    const [clockOffset, setClockOffset] = createSignal(0);
    const [notes, setNotes] = createSignal("");
    const [accountAction, setAccountAction] =
      createSignal<AccountAction | null>(null);
    this.busy = busy;
    this.setBusy = setBusy;
    this.error = error;
    this.setError = setError;
    this.syncBlocked = syncBlocked;
    this.setSyncBlocked = setSyncBlocked;
    this.syncBlockedReason = syncBlockedReason;
    this.setSyncBlockedReason = setSyncBlockedReason;
    this.pauseReasonOpen = pauseReasonOpen;
    this.setPauseReasonOpen = setPauseReasonOpen;
    this.clock = clock;
    this.setClock = setClock;
    this.setClockOffset = setClockOffset;
    this.notes = notes;
    this.setNotes = setNotes;
    this.accountAction = accountAction;
    this.setAccountAction = setAccountAction;

    this.todayComplete = createMemo(
      () => new DayPlan(state.data?.todayTasks ?? []).isComplete,
    );
    this.focusLocked = createMemo(
      () => state.data?.activeTask?.startedAt != null,
    );
    this.completionLevel = createMemo(() =>
      Math.max(
        0,
        Math.min(
          PLANNER_LIMITS.tasksPerDay,
          state.data?.completions.find((day) => day.day === state.data?.today)
            ?.count ?? 0,
        ),
      ),
    );
    this.now = createMemo(() =>
      Math.floor((this.clock() + clockOffset()) / TIME.msPerSecond),
    );
    // currentView enforces the running-timer lock, including during mutations.
    this.view = createMemo(() =>
      this.focusLocked()
        ? "focus"
        : this.todayComplete() && view() === "focus"
          ? "today"
          : view(),
    );

    // Scratchpad is deliberately memory-only and belongs to one active task.
    createEffect(
      on(
        () => state.data?.activeTask?.id,
        () => this.setNotes(""),
      ),
    );
    onWake(() => {
      this.setClock(Date.now());
      void this.refresh();
      void client.sync();
    });
    onMount(() => this.start());
  }

  visit(next: PlannerView): void {
    this.setView(next);
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshing || this.busy()) return;
    this.refreshing = true;
    try {
      const next = await this.client.dashboard();
      if (this.disposed) return;
      batch(() => {
        this.apply(next);
        if (this.initialLoad && next.activeTask) this.setView("focus");
        this.initialLoad = false;
        this.setError("");
      });
    } catch (cause) {
      if (!this.disposed) this.setError(CloudError.messageOf(cause));
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Runs one change at a time and then reloads the dashboard. Resolves to
   * whether it succeeded, so a control can roll back.
   */
  async mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (this.busy() || this.disposed) return false;
    batch(() => {
      this.setBusy(true);
      this.setError("");
    });
    let success = false;
    let pointToSyncBar = false;
    try {
      await action();
      success = true;
    } catch (cause) {
      // While a rejected change waits to be discarded, the sync bar explains
      // why nothing new saves; point to it instead of a second error.
      if (!this.disposed && this.client.syncBlocked) {
        this.setSyncBlocked(true);
        this.setSyncBlockedReason(this.client.syncBlockedReason);
        pointToSyncBar = true;
      } else if (!this.disposed) this.setError(CloudError.messageOf(cause));
    } finally {
      if (!this.disposed) {
        try {
          this.apply(await this.client.dashboard());
        } catch (cause) {
          if (!this.disposed) this.setError(CloudError.messageOf(cause));
          success = false;
        }
        if (!this.disposed) this.setBusy(false);
        if (!this.disposed && pointToSyncBar) PlannerState.focusDiscardButton();
      }
    }
    return success && !this.disposed;
  }

  signOut(): Promise<void> {
    return this.endSession("signOut");
  }

  deleteAccount(): Promise<void> {
    return this.endSession("delete");
  }

  async discardPending(): Promise<void> {
    if (!window.confirm(MESSAGES.confirmDiscard)) return;
    await this.mutate(() => this.client.discardPending());
  }

  /** Starts the clock, polling and outbox subscription; all end with the owner. */
  private start(): void {
    const queueChanged = () => {
      this.setSyncBlocked(this.client.syncBlocked);
      this.setSyncBlockedReason(this.client.syncBlockedReason);
      const next = this.client.cachedDashboard();
      if (next && !this.busy()) this.apply(next);
    };
    this.client.onQueueChange = queueChanged;
    const timers = [
      window.setInterval(() => this.setClock(Date.now()), POLLING.clock),
      window.setInterval(() => void this.refresh(), POLLING.dashboard),
    ];
    onCleanup(() => {
      this.disposed = true;
      timers.forEach(window.clearInterval);
      if (this.client.onQueueChange === queueChanged)
        this.client.onQueueChange = () => {};
    });
    queueChanged();
    void this.refresh();
  }

  /**
   * Reconciles a dashboard into the store. A time-only change moves the clock
   * offset without touching the store, which keeps task identities, drafts
   * and focused controls in place during background syncs.
   */
  private apply(next: Dashboard): void {
    if (this.disposed) return;
    const signature = JSON.stringify({ ...next, serverNow: 0 });
    batch(() => {
      this.setClockOffset(next.serverNow * TIME.msPerSecond - Date.now());
      if (signature !== this.signature) {
        this.signature = signature;
        this.setData("data", reconcile(next));
      }
    });
  }

  private async endSession(action: AccountAction): Promise<void> {
    if (this.busy()) return;
    const confirmation =
      action === "delete"
        ? MESSAGES.confirmDelete
        : this.client.pendingCount
          ? MESSAGES.confirmSignOutPending
          : null;
    if (confirmation && !window.confirm(confirmation)) return;
    this.setAccountAction(action);
    await this.mutate(async () => {
      if (action === "delete") await this.client.deleteAccount();
      else await this.client.signOut();
      analytics.forgetAccount();
      window.location.reload();
    });
    if (!this.disposed) this.setAccountAction(null);
  }

  private static focusDiscardButton(): void {
    const discard = document.querySelector<HTMLButtonElement>(DISCARD_BUTTON);
    discard?.scrollIntoView({ block: "center", behavior: "smooth" });
    discard?.focus({ preventScroll: true });
  }
}
