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
 * Every account gets the page tour once per device, right after sign-in,
 * whether or not it has tasks. Never over a running timer: views are locked.
 */
export function shouldOfferTour(
  data: Dashboard,
  accountKey: string,
  storage: Pick<Storage, "getItem">,
): boolean {
  if (data.activeTask) return false;
  try {
    return !storage.getItem(tourKey(accountKey));
  } catch {
    // Without storage it would reappear on every load; skip it instead.
    return false;
  }
}
