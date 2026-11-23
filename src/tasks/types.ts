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
  /**
   * When the task is planned on the calendar (the start of its hour), or null.
   * Lists saved before the calendar have no such field: they read as null.
   */
  startAt: number | null;
  /** A description; links in it open. Empty when there is none. */
  notes: string;
  /** How long the task takes on the calendar, in minutes (60 unless changed). */
  minutes: number;
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

/**
 * A space: Personal (one per account, its id is the user id) or a group space
 * made by sharing Personal or joined through a link (see planner_list).
 */
export interface Space {
  id: string;
  kind: "personal" | "group";
  /** Empty for Personal. */
  name: string;
  /** Everyone in it, the caller included. */
  people: number;
  /** The caller made it: they delete it rather than leave it. */
  owner: boolean;
}

/** One sync's worth of changes, and the change times it carries. */
export interface ListBatch {
  save: Task[];
  remove: string[];
  sent: Record<string, number>;
}

/** Someone in a space, as its Share sheet lists them (see planner_list 'people'). */
export interface Person {
  /** From the sign-in provider (Google gives one); null otherwise. */
  name: string | null;
  email: string | null;
  /** Made the space. */
  owner: boolean;
  /** The person looking. */
  you: boolean;
}
