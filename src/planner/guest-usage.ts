import { SUPABASE_ROUTES } from "../shared/api-routes.ts";
import { PRODUCTION_ORIGINS } from "../shared/site.ts";
import { apiFetch } from "./api-fetch.ts";
import type { QueuedAction } from "./commands.ts";
import { webConfig } from "./config.ts";
import { localDay } from "./time.ts";
import type { Task } from "./types.ts";

/** Onboarding-survey funnel, per experiment variant. Never answers. */
export const FUNNEL_METRICS = [
  "funnel_control_shown",
  "funnel_control_signed_up",
  "funnel_survey_shown",
  "funnel_survey_started",
  "funnel_survey_finished",
  "funnel_survey_plan_shown",
  "funnel_survey_google_clicked",
  "funnel_survey_signed_up",
  // Each question screen after the first ("started" covers the name step).
  "funnel_survey_reached_goal",
  "funnel_survey_reached_role",
  "funnel_survey_reached_window",
  "funnel_survey_reached_length",
  "funnel_survey_reached_fact",
  "funnel_survey_reached_derailer",
  "funnel_survey_reached_target",
  "funnel_survey_reached_outcome",
] as const;
export type FunnelMetric = (typeof FUNNEL_METRICS)[number];
export type GuestMetric =
  | "new_guests"
  | "active_guests"
  | "returning_guests"
  | "tasks_created"
  | "tasks_started"
  | "tasks_completed"
  | "focus_minutes"
  | FunnelMetric;
export type GuestUsage = Partial<Record<GuestMetric, number>>;

/**
 * What one guest command adds to the anonymous daily totals. Derived from the
 * existing journal, so no extra device identifier is stored or sent.
 */
export function guestUsage(
  previous: readonly QueuedAction[],
  command: QueuedAction,
  task: Task,
): GuestUsage {
  const usage: GuestUsage = {};
  if (!previous.length) usage.new_guests = 1;
  const today = localDay(command.at, command.timezone);
  if (!previous.some((item) => localDay(item.at, item.timezone) === today)) {
    usage.active_guests = 1;
    if (previous.length) usage.returning_guests = 1;
  }
  if (command.action === "create_task") usage.tasks_created = 1;
  if (command.action === "start_task") usage.tasks_started = 1;
  if (command.action === "complete_task") {
    usage.tasks_completed = 1;
    const minutes = Math.min(1440, Math.round(task.actualSeconds / 60));
    if (minutes > 0) usage.focus_minutes = minutes;
  }
  return usage;
}

/** Production only and best-effort: counting never delays or fails planning. */
export function reportGuestUsage(usage: GuestUsage): void {
  try {
    if (
      !Object.keys(usage).length ||
      !import.meta.env.PROD ||
      !PRODUCTION_ORIGINS.includes(location.origin)
    )
      return;
    const { url, publicKey } = webConfig();
    void apiFetch(`${url}${SUPABASE_ROUTES.guestUsage}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publicKey,
        // Publishable keys are not JWTs; legacy anon keys also act as the bearer.
        ...(publicKey.startsWith("sb_")
          ? {}
          : { Authorization: `Bearer ${publicKey}` }),
      },
      body: JSON.stringify({ p_metrics: usage }),
    }).catch(() => {});
  } catch {
    /* Unconfigured builds simply do not count. */
  }
}
