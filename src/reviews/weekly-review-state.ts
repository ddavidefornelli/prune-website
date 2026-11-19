import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";
import { analytics } from "../analytics.ts";
import type { PlanningClient } from "../planner/api.ts";
import { POLLING } from "../planner/constants.ts";
import { MESSAGES } from "../planner/messages.ts";
import { onWake } from "../shared/on-wake.ts";
import type { CheckInPlan, WeeklyOverview } from "../planner/types.ts";

type ReviewClient = Pick<
  PlanningClient,
  "weeklyOverview" | "generateIfDue" | "enableWeeklyAi" | "setCheckInPlan"
>;

/** Review states that are still being produced. */
const IN_PROGRESS: readonly WeeklyOverview["status"][] = ["pending", "running"];

/**
 * The weekly check-in's state. AI requests never lock tasks or timers, and a
 * preference write invalidates any older read still in flight. Create it
 * inside a Solid owner: polling ends with that owner.
 */
export class WeeklyReviewState {
  readonly data: Accessor<WeeklyOverview | null>;
  readonly saving: Accessor<boolean>;
  readonly error: Accessor<string>;

  private readonly client: ReviewClient;
  private readonly visible: () => boolean;
  private readonly setData: Setter<WeeklyOverview | null>;
  private readonly setSaving: Setter<boolean>;
  private readonly setError: Setter<string>;
  private loading = false;
  /** Bumped by every write; a read started before it is discarded. */
  private version = 0;
  private disposed = false;

  constructor(client: ReviewClient, visible: () => boolean) {
    this.client = client;
    this.visible = visible;
    const [data, setData] = createSignal<WeeklyOverview | null>(null);
    const [saving, setSaving] = createSignal(false);
    const [error, setError] = createSignal("");
    this.data = data;
    this.setData = setData;
    this.saving = saving;
    this.setSaving = setSaving;
    this.error = error;
    this.setError = setError;

    createEffect(
      on(visible, (isVisible) => {
        if (isVisible) void this.refresh();
      }),
    );
    createEffect(() => {
      const status = this.data()?.status;
      if (!visible() || !status || !IN_PROGRESS.includes(status)) return;
      const timer = window.setInterval(
        () => void this.refresh(),
        POLLING.pendingReview,
      );
      onCleanup(() => window.clearInterval(timer));
    });
    onWake(() => void this.checkDue());
    onMount(() => {
      const timer = window.setInterval(
        () => void this.checkDue(),
        POLLING.weeklyReview,
      );
      void this.checkDue();
      onCleanup(() => {
        this.disposed = true;
        this.version++;
        window.clearInterval(timer);
      });
    });
  }

  async refresh(): Promise<void> {
    if (this.loading || this.saving() || this.disposed) return;
    this.loading = true;
    const startedVersion = this.version;
    try {
      const next = await this.client.weeklyOverview();
      if (this.disposed || startedVersion !== this.version) return;
      this.apply(next);
      this.setError("");
    } catch {
      if (!this.disposed && startedVersion === this.version)
        this.setError(MESSAGES.reviewLoadFailed);
    } finally {
      this.loading = false;
    }
  }

  /** Also keeps progress current for Today's meter, so it shows from the start. */
  async checkDue(): Promise<void> {
    if (this.disposed) return;
    const startedVersion = this.version;
    // Server quotas enforce backoff.
    const next = await this.client.generateIfDue().catch(() => null);
    if (this.disposed) return;
    if (next && startedVersion === this.version && !this.saving()) {
      this.apply(next);
      this.setError("");
    } else if (this.visible() || !this.data()) await this.refresh();
  }

  async enable(): Promise<void> {
    const saved = await this.save(
      () => this.client.enableWeeklyAi(),
      MESSAGES.aiSettingsNotSaved,
    );
    if (saved) analytics.capture("weekly_ai_enabled");
    if (saved && !this.disposed && this.data()?.settings.enabled)
      await this.checkDue();
  }

  async decide(plan: CheckInPlan): Promise<void> {
    const saved = await this.save(
      () => this.client.setCheckInPlan(plan),
      MESSAGES.checkInPlanNotSaved,
    );
    if (saved)
      analytics.capture("check_in_plan_decided", {
        daily_target: plan.dailyTarget,
        estimate_factor: plan.estimateFactor,
      });
  }

  /** Keeps the previous object when nothing changed, so readers are not notified. */
  private apply(next: WeeklyOverview): void {
    this.setData((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }

  /** A preference write: it invalidates any read still in flight. */
  private async save(
    write: () => Promise<WeeklyOverview>,
    failure: string,
  ): Promise<boolean> {
    if (this.saving() || this.disposed) return false;
    this.version++;
    this.setSaving(true);
    this.setError("");
    try {
      const next = await write();
      if (!this.disposed) this.apply(next);
      return true;
    } catch {
      if (!this.disposed) this.setError(failure);
      return false;
    } finally {
      if (!this.disposed) this.setSaving(false);
    }
  }
}
