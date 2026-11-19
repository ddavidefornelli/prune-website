import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import type { SuggestionTarget, TaskSuggestion } from "./types.ts";

interface Entry {
  key: string;
  result: Promise<TaskSuggestion[]>;
}

/**
 * The last proposals per target, in memory and on this device. Each request
 * spends the account's paid daily allowance, so a reload or a re-render with
 * the same day and source plan reuses the answer instead.
 */
export class SuggestionCache {
  private readonly entries = new Map<SuggestionTarget, Entry>();
  private readonly accountKey: () => string | null;

  constructor(accountKey: () => string | null) {
    this.accountKey = accountKey;
  }

  /** The cached answer for `key`, from memory or storage. */
  find(
    target: SuggestionTarget,
    key: string,
  ): Promise<TaskSuggestion[]> | null {
    const cached = this.entries.get(target);
    if (cached?.key === key) return cached.result;
    try {
      const stored = JSON.parse(
        localStorage.getItem(this.storageKey(target)) ?? "null",
      );
      if (stored?.key === key && Array.isArray(stored.suggestions)) {
        const result = Promise.resolve(stored.suggestions as TaskSuggestion[]);
        this.entries.set(target, { key, result });
        return result;
      }
    } catch {
      /* Without storage, fall back to one request per page. */
    }
    return null;
  }

  /** Remembers a request in flight, so concurrent callers share it. */
  remember(
    target: SuggestionTarget,
    key: string,
    result: Promise<TaskSuggestion[]>,
  ): Promise<TaskSuggestion[]> {
    this.entries.set(target, { key, result });
    return result;
  }

  /** Keeps a settled answer for the next page load. Best effort. */
  store(
    target: SuggestionTarget,
    key: string,
    suggestions: TaskSuggestion[],
  ): void {
    try {
      localStorage.setItem(
        this.storageKey(target),
        JSON.stringify({ key, suggestions }),
      );
    } catch {
      /* Caching is best-effort. */
    }
  }

  private storageKey(target: SuggestionTarget): string {
    return STORAGE_KEYS.suggestions(String(this.accountKey()), target);
  }
}
