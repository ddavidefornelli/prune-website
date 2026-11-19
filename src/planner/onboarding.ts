import { DONE_FLAG, STORAGE_KEYS } from "../shared/storage-keys.ts";
import type { Dashboard } from "./types.ts";

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The first-run steps for one account on this device: the tour, then the
 * first-plan prompt. Remembered per account and device, not on the server.
 * Only a new, empty planner gets them: an account with any task or history
 * already knows its way around.
 */
export class FirstRun {
  private readonly storage: FlagStorage;
  private readonly accountKey: string;

  constructor(storage: FlagStorage, accountKey: string) {
    this.storage = storage;
    this.accountKey = accountKey;
  }

  /** No task, no running timer and no finished task, ever. */
  static isEmptyPlanner(data: Dashboard): boolean {
    return (
      !data.activeTask &&
      data.todayTasks.length === 0 &&
      data.tomorrowTasks.length === 0 &&
      !data.completions.some((day) => day.count > 0)
    );
  }

  /** The first-plan prompt. Without storage it still shows, since it helps. */
  offersOnboarding(data: Dashboard): boolean {
    return (
      this.read(STORAGE_KEYS.onboarding(this.accountKey), false) === false &&
      FirstRun.isEmptyPlanner(data)
    );
  }

  /** The tour. Without storage it would reappear on every load, so it is skipped. */
  offersTour(data: Dashboard): boolean {
    return (
      FirstRun.isEmptyPlanner(data) &&
      this.read(STORAGE_KEYS.tour(this.accountKey), true) === false
    );
  }

  finishOnboarding(): void {
    this.write(STORAGE_KEYS.onboarding(this.accountKey));
  }

  finishTour(): void {
    this.write(STORAGE_KEYS.tour(this.accountKey));
  }

  /** Whether `key` is set, or `fallback` when storage cannot be read. */
  private read(key: string, fallback: boolean): boolean {
    try {
      return !!this.storage.getItem(key);
    } catch {
      return fallback;
    }
  }

  /** Best effort: the step is simply offered again on the next load. */
  private write(key: string): void {
    try {
      this.storage.setItem(key, DONE_FLAG);
    } catch {
      /* Not remembered on this device. */
    }
  }
}
