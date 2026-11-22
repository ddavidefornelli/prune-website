/**
 * The list's records. They stay plain JSON: they are saved in browser storage,
 * sent to planner_list and held in Solid signals. TaskList reads and changes them.
 */

/** One task, as the device and the cloud keep it. Times are epoch milliseconds. */
export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  /** The last edit, on the editing device's clock: the newest edit wins. */
  updatedAt: number;
  doneAt: number | null;
}

/** This browser's list. */
export interface SavedList {
  tasks: Task[];
  /**
   * Tasks changed on this device and not yet saved to the cloud, with the
   * time of the change. A pending id that is not in `tasks` was deleted.
   */
  pending: Record<string, number>;
  /** The account (project and user id) the list last synced with; null before the first sync. */
  owner: string | null;
}

/** What planner_list('sync') answers. */
export interface ListResponse {
  tasks: Task[];
  /** New tasks refused because the list is full. */
  rejected: string[];
}

/** One sync's worth of changes, and the change times it carries. */
export interface ListBatch {
  save: Task[];
  remove: string[];
  sent: Record<string, number>;
}
