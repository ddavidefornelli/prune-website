import {
  RETIRED_STORAGE_PREFIXES,
  SPACE_LIST_PREFIX,
  STORAGE_KEYS,
} from "../shared/storage-keys.ts";
import { TaskList } from "./task-list.ts";

type ListStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This browser's localStorage, or null where it is blocked. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * This browser's list in storage, shared by every tab: each change is made on
 * the copy in storage, so tabs never overwrite each other's edits. When
 * storage is unavailable or full, the list lives in memory for the visit.
 */
export class TaskStorage {
  private readonly storage: ListStorage | null;
  private readonly key: string;
  private memory = TaskList.empty();
  /** The last text read or written, so an unchanged copy is not parsed again. */
  private raw: string | null = null;
  private usable = true;

  /** `space`: a group space's id; null for Personal. */
  constructor(storage: ListStorage | null, space: string | null = null) {
    this.storage = storage;
    this.key = space ? STORAGE_KEYS.spaceList(space) : STORAGE_KEYS.list;
  }

  /** Forgets every group space's list on this device (Delete everything, another account). */
  static clearSpaces(storage: Storage | null): void {
    TaskStorage.clearPrefixes(storage, [SPACE_LIST_PREFIX]);
  }

  /** Removes what earlier versions kept, which nothing reads any more. */
  static clearRetired(storage: Storage | null): void {
    TaskStorage.clearPrefixes(storage, RETIRED_STORAGE_PREFIXES);
  }

  private static clearPrefixes(
    storage: Storage | null,
    prefixes: readonly string[],
  ): void {
    try {
      if (!storage) return;
      // Collect first: removing reorders the keys a browser lists by index.
      const found: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && prefixes.some((p) => key.startsWith(p))) found.push(key);
      }
      for (const key of found) storage.removeItem(key);
    } catch {
      /* Storage is unavailable: there is nothing to clear. */
    }
  }

  read(): TaskList {
    if (!this.storage || !this.usable) return this.memory;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return this.memory;
    }
    if (raw === null || raw === this.raw) return this.memory;
    try {
      this.memory = TaskList.parse(JSON.parse(raw)).reuse(this.memory);
    } catch {
      // Unreadable: start from the cloud's copy rather than fail.
      this.memory = TaskList.empty();
    }
    this.raw = raw;
    return this.memory;
  }

  write(list: TaskList): void {
    this.memory = list;
    if (!this.storage || !this.usable) return;
    const raw = JSON.stringify(list.saved);
    try {
      this.storage.setItem(this.key, raw);
      this.raw = raw;
    } catch {
      // Full or blocked: keep working from memory instead of losing edits.
      this.usable = false;
    }
  }

  /** Forgets the list on this device (after Delete everything). */
  clear(): void {
    this.memory = TaskList.empty();
    this.raw = null;
    try {
      this.storage?.removeItem(this.key);
    } catch {
      /* Nothing more can be done. */
    }
  }

  /** Calls `changed` when another tab saves this list. */
  watch(changed: () => void): () => void {
    const listener = (event: StorageEvent) => {
      if (event.key === this.key || event.key === null) changed();
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }
}
