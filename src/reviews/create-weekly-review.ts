import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { capture } from "../analytics.ts";
import type { PlanningClient } from "../planner/api";
import { onWake } from "../shared/on-wake.ts";
import { POLLING } from "../planner/constants.ts";
import type { CheckInPlan, WeeklyOverview } from "../planner/types";

/** AI requests never lock tasks or timers; preference writes invalidate older reads. */
export function createWeeklyReview(
  client: PlanningClient,
  visible: () => boolean,
) {
  const [data, setData] = createSignal<WeeklyOverview | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let loading = false;
  let version = 0;
  let disposed = false;

  function apply(next: WeeklyOverview): void {
    setData((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }

  async function refresh(): Promise<void> {
    if (loading || saving() || disposed) return;
    loading = true;
    const startedVersion = version;
    try {
      const next = await client.weeklyOverview();
      if (disposed || startedVersion !== version) return;
      apply(next);
      setError("");
    } catch {
      if (!disposed && startedVersion === version)
        setError(
          "Could not load your weekly review. Tasks and timers still work normally.",
        );
    } finally {
      loading = false;
    }
  }

  /** Also keeps progress current for Today's meter, so it shows from the start. */
  async function checkDue(): Promise<void> {
    if (disposed) return;
    const startedVersion = version;
    const next = await client.generateIfDue().catch(() => {
      /* Server quotas enforce backoff. */
      return null;
    });
    if (disposed) return;
    if (next && startedVersion === version && !saving()) {
      apply(next);
      setError("");
    } else if (visible() || !data()) await refresh();
  }

  /** A preference write: it invalidates any read still in flight. */
  async function save(
    write: () => Promise<WeeklyOverview>,
    failure: string,
  ): Promise<boolean> {
    if (saving() || disposed) return false;
    version++;
    setSaving(true);
    setError("");
    try {
      const next = await write();
      if (!disposed) apply(next);
      return true;
    } catch {
      if (!disposed) setError(failure);
      return false;
    } finally {
      if (!disposed) setSaving(false);
    }
  }

  async function enable(): Promise<void> {
    const saved = await save(
      () => client.enableWeeklyAi(),
      "Could not save AI settings. Please try again.",
    );
    if (saved) capture("weekly_ai_enabled");
    if (saved && !disposed && data()?.settings.enabled) await checkDue();
  }

  async function decide(plan: CheckInPlan): Promise<void> {
    const saved = await save(
      () => client.setCheckInPlan(plan),
      "Could not save your plan. Please try again.",
    );
    if (saved)
      capture("check_in_plan_decided", {
        daily_target: plan.dailyTarget,
        estimate_factor: plan.estimateFactor,
      });
  }

  createEffect(
    on(visible, (isVisible) => {
      if (isVisible) void refresh();
    }),
  );
  createEffect(() => {
    const pending =
      data()?.status === "pending" || data()?.status === "running";
    if (!visible() || !pending) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLLING.pendingReview);
    onCleanup(() => window.clearInterval(timer));
  });
  onWake(() => void checkDue());
  onMount(() => {
    const timer = window.setInterval(() => {
      void checkDue();
    }, POLLING.weeklyReview);
    void checkDue();
    onCleanup(() => {
      disposed = true;
      version++;
      window.clearInterval(timer);
    });
  });

  return { data, saving, error, refresh, enable, checkDue, decide };
}

export type WeeklyReviewState = ReturnType<typeof createWeeklyReview>;
