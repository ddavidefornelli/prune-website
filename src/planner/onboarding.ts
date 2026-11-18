import type { Dashboard } from "./types";

export const onboardingKey = (accountKey: string) =>
  `prune:onboarding:v1:${accountKey}`;

/** Remembered per account/device, not a new server-side account preference. */
export function shouldOfferOnboarding(
  data: Dashboard,
  accountKey: string,
  storage: Pick<Storage, "getItem">,
): boolean {
  try {
    if (storage.getItem(onboardingKey(accountKey))) return false;
  } catch {
    /* The flow remains usable without persistence. */
  }
  return (
    !data.activeTask &&
    data.todayTasks.length === 0 &&
    data.tomorrowTasks.length === 0 &&
    !data.completions.some((day) => day.count > 0)
  );
}

export const tourKey = (accountKey: string) => `prune:tour:v1:${accountKey}`;

/**
 * Only a new, empty planner gets the (one-step) tour, once per device. An
 * account with any task or history already knows its way around.
 */
export function shouldOfferTour(
  data: Dashboard,
  accountKey: string,
  storage: Pick<Storage, "getItem">,
): boolean {
  if (
    data.activeTask ||
    data.todayTasks.length ||
    data.tomorrowTasks.length ||
    data.completions.some((day) => day.count > 0)
  )
    return false;
  try {
    return !storage.getItem(tourKey(accountKey));
  } catch {
    // Without storage it would reappear on every load; skip it instead.
    return false;
  }
}
