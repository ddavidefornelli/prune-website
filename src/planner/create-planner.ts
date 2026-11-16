import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { onWake } from "../shared/on-wake.ts";
import type { PlanningClient } from "./api";
import type { Dashboard } from "./types";
import { PLANNER_LIMITS, POLLING, type PlannerView } from "./constants.ts";
import { errorMessage } from "./errors.ts";
import { isDayComplete } from "./task-model.ts";

/** Reactive UI state. The client alone owns persistence, queueing, and transport. */
export function createPlanner(client: PlanningClient) {
  const [state, setState] = createStore<{ data: Dashboard | null }>({
    data: null,
  });
  const [view, setView] = createSignal<PlannerView>("today");
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
  const [accountAction, setAccountAction] = createSignal<
    "signOut" | "delete" | null
  >(null);
  let signature = "";
  let refreshing = false;
  let disposed = false;
  let initialLoad = true;

  const todayComplete = createMemo(() =>
    isDayComplete(state.data?.todayTasks ?? []),
  );
  const focusLocked = createMemo(
    () => state.data?.activeTask?.startedAt != null,
  );
  const completionLevel = createMemo(() =>
    Math.max(
      0,
      Math.min(
        PLANNER_LIMITS.tasksPerDay,
        state.data?.completions.find((day) => day.day === state.data?.today)
          ?.count ?? 0,
      ),
    ),
  );
  const now = createMemo(() => Math.floor((clock() + clockOffset()) / 1000));
  const currentView = createMemo(() =>
    focusLocked()
      ? "focus"
      : todayComplete() && view() === "focus"
        ? "today"
        : view(),
  );

  // Scratchpad is deliberately memory-only and belongs to one active task.
  createEffect(
    on(
      () => state.data?.activeTask?.id,
      () => setNotes(""),
    ),
  );

  function applyDashboard(next: Dashboard): void {
    if (disposed) return;
    const nextSignature = JSON.stringify({ ...next, serverNow: 0 });
    batch(() => {
      setClockOffset(next.serverNow * 1000 - Date.now());
      if (nextSignature !== signature) {
        signature = nextSignature;
        // Preserve task identities and focused controls across background syncs.
        setState("data", reconcile(next));
      }
    });
  }

  async function refresh(): Promise<void> {
    if (disposed || refreshing || busy()) return;
    refreshing = true;
    try {
      const next = await client.dashboard();
      if (disposed) return;
      batch(() => {
        applyDashboard(next);
        if (initialLoad && next.activeTask) setView("focus");
        initialLoad = false;
        setError("");
      });
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause));
    } finally {
      refreshing = false;
    }
  }

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (busy() || disposed) return false;
    batch(() => {
      setBusy(true);
      setError("");
    });
    let success = false;
    let pointToSyncBar = false;
    try {
      await action();
      success = true;
    } catch (cause) {
      // While a rejected change waits to be discarded, the sync bar explains
      // why nothing new saves; point to it instead of a second error.
      if (!disposed && client.syncBlocked) {
        setSyncBlocked(true);
        setSyncBlockedReason(client.syncBlockedReason);
        pointToSyncBar = true;
      } else if (!disposed) setError(errorMessage(cause));
    } finally {
      if (!disposed) {
        try {
          applyDashboard(await client.dashboard());
        } catch (cause) {
          if (!disposed) setError(errorMessage(cause));
          success = false;
        }
        if (!disposed) setBusy(false);
        if (!disposed && pointToSyncBar) {
          const discard =
            document.querySelector<HTMLButtonElement>(".sync-bar button");
          discard?.scrollIntoView({ block: "center", behavior: "smooth" });
          discard?.focus({ preventScroll: true });
        }
      }
    }
    return success && !disposed;
  }

  async function endSession(action: "signOut" | "delete"): Promise<void> {
    if (busy()) return;
    const confirmation =
      action === "delete"
        ? "Delete your account? You will lose access immediately. Your account and data will be marked for deletion and kept for 30 days before manual removal. Unsynced changes will not be uploaded. This cannot be undone in the app."
        : client.pendingCount
          ? "Some changes have not synced. They will stay on this device for this account, but will not sync while signed out. Sign out anyway?"
          : null;
    if (confirmation && !window.confirm(confirmation)) return;
    setAccountAction(action);
    await mutate(async () => {
      if (action === "delete") await client.deleteAccount();
      else await client.signOut();
      window.location.reload();
    });
    if (!disposed) setAccountAction(null);
  }

  async function discardPending(): Promise<void> {
    if (
      !window.confirm(
        "Discard ALL pending changes on this device, including changes depending on the rejected action? Synced changes will be kept.",
      )
    )
      return;
    await mutate(() => client.discardPending());
  }

  onWake(() => {
    setClock(Date.now());
    void refresh();
    void client.sync();
  });
  onMount(() => {
    const queueChanged = () => {
      setSyncBlocked(client.syncBlocked);
      setSyncBlockedReason(client.syncBlockedReason);
      const next = client.cachedDashboard();
      if (next && !busy()) applyDashboard(next);
    };
    client.onQueueChange = queueChanged;
    const timers = [
      window.setInterval(() => setClock(Date.now()), POLLING.clock),
      window.setInterval(() => {
        void refresh();
      }, POLLING.dashboard),
    ];
    onCleanup(() => {
      disposed = true;
      timers.forEach(window.clearInterval);
      if (client.onQueueChange === queueChanged)
        client.onQueueChange = () => {};
    });
    queueChanged();
    void refresh();
  });

  return {
    data: () => state.data,
    view: currentView,
    // currentView enforces the running-timer lock, including during mutations.
    visit: (next: PlannerView) => {
      setView(next);
    },
    busy,
    error,
    now,
    clock,
    todayComplete,
    focusLocked,
    completionLevel,
    syncBlocked,
    syncBlockedReason,
    pauseReasonOpen,
    setPauseReasonOpen,
    notes,
    setNotes,
    accountAction,
    refresh,
    mutate,
    signOut: () => endSession("signOut"),
    deleteAccount: () => endSession("delete"),
    discardPending,
  };
}

export type PlannerState = ReturnType<typeof createPlanner>;
