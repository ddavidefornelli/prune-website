import { createSignal, type Accessor, type Setter } from "solid-js";
import { DONE_FLAG, STORAGE_KEYS } from "../shared/storage-keys.ts";

export type HintId = "start" | "progress" | "shortcuts" | `evening:${string}`;

/** One-time, just-in-time teaching remembered per account on this device. */
export class HintBook {
  /** This page load's number among the account's visits on this device. */
  readonly visits: number;
  private readonly accountKey: string;
  private readonly dismissed: Accessor<ReadonlySet<HintId>>;
  private readonly setDismissed: Setter<ReadonlySet<HintId>>;

  constructor(accountKey: string) {
    this.accountKey = accountKey;
    const [dismissed, setDismissed] = createSignal<ReadonlySet<HintId>>(
      new Set(),
    );
    this.dismissed = dismissed;
    this.setDismissed = setDismissed;
    this.visits = HintBook.countVisit(accountKey);
  }

  private static countVisit(accountKey: string): number {
    const key = STORAGE_KEYS.visits(accountKey);
    let visits = 0;
    try {
      visits = Number(localStorage.getItem(key) ?? 0) + 1;
      localStorage.setItem(key, String(visits));
    } catch {
      /* Hints remain usable without persistence. */
    }
    return visits;
  }

  seen(id: HintId): boolean {
    if (this.dismissed().has(id)) return true;
    try {
      return (
        localStorage.getItem(STORAGE_KEYS.hint(this.accountKey, id)) !== null
      );
    } catch {
      return false;
    }
  }

  dismiss(id: HintId): void {
    if (this.seen(id)) return;
    this.setDismissed((current) => new Set(current).add(id));
    try {
      localStorage.setItem(STORAGE_KEYS.hint(this.accountKey, id), DONE_FLAG);
    } catch {
      /* Dismissal still lasts for this page. */
    }
  }
}
