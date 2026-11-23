import { TASK_LIMITS } from "./constants.ts";
import type { ListBatch, ListResponse, SavedList, Task } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The database refuses control characters. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const SPACES = /\s+/g;
const SURROGATES = { first: 0xd800, last: 0xdfff } as const;
/** Characters, not halves of one: an unpaired surrogate cannot be saved either. */
const isWhole = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return code < SURROGATES.first || code > SURROGATES.last;
};

const newestFirst = (a: Task, b: Task) =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);
const lastDoneFirst = (a: Task, b: Task) =>
  (b.doneAt ?? 0) - (a.doneAt ?? 0) || newestFirst(a, b);
const sameTask = (a: Task, b: Task) =>
  a.id === b.id &&
  a.title === b.title &&
  a.done === b.done &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.doneAt === b.doneAt &&
  a.startAt === b.startAt &&
  a.notes === b.notes &&
  a.minutes === b.minutes;

/**
 * One account's list on this device: its tasks and the changes the cloud has
 * not confirmed yet. Immutable: every change returns a new list, so a saved
 * copy can always be compared with, or replaced by, the one in storage.
 */
export class TaskList {
  readonly saved: SavedList;
  private readonly byId: Map<string, Task>;

  constructor(saved: SavedList) {
    this.saved = saved;
    this.byId = new Map(saved.tasks.map((task) => [task.id, task]));
  }

  static empty(): TaskList {
    return new TaskList({ tasks: [], pending: {}, owner: null });
  }

  /** Reads stored JSON, keeping only well-formed tasks and changes. */
  static parse(value: unknown): TaskList {
    if (typeof value !== "object" || value === null) return TaskList.empty();
    const raw = value as Partial<Record<keyof SavedList, unknown>>;
    const tasks = new Map<string, Task>();
    if (Array.isArray(raw.tasks))
      for (const value of raw.tasks) {
        const task = TaskList.read(value);
        if (task) tasks.set(task.id, task);
      }
    const pending: Record<string, number> = {};
    if (typeof raw.pending === "object" && raw.pending !== null)
      for (const [id, at] of Object.entries(raw.pending))
        if (UUID.test(id) && typeof at === "number" && Number.isFinite(at))
          pending[id] = at;
    const owner = typeof raw.owner === "string" ? raw.owner : null;
    return new TaskList({ tasks: [...tasks.values()], pending, owner });
  }

  static isTask(value: unknown): value is Task {
    if (typeof value !== "object" || value === null) return false;
    const task = value as Record<string, unknown>;
    return (
      typeof task.id === "string" &&
      UUID.test(task.id) &&
      typeof task.title === "string" &&
      task.title.length > 0 &&
      typeof task.done === "boolean" &&
      Number.isFinite(task.createdAt) &&
      Number.isFinite(task.updatedAt) &&
      (task.done ? Number.isFinite(task.doneAt) : task.doneAt === null) &&
      (task.startAt === null || Number.isFinite(task.startAt)) &&
      typeof task.notes === "string" &&
      task.notes.length <= TASK_LIMITS.notesLength &&
      Number.isInteger(task.minutes) &&
      (task.minutes as number) >= TASK_LIMITS.minMinutes &&
      (task.minutes as number) <= TASK_LIMITS.maxMinutes
    );
  }

  /**
   * A task from storage or the cloud, or null when it is not one. A task
   * saved before the calendar (or sent by an older backend) has no start,
   * no description and the usual hour.
   */
  static read(value: unknown): Task | null {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    const task = {
      ...raw,
      startAt: raw.startAt ?? null,
      notes: raw.notes ?? "",
      minutes: raw.minutes ?? TASK_LIMITS.defaultMinutes,
    };
    return TaskList.isTask(task) ? task : null;
  }

  /**
   * The cloud's copy of a task, keeping this device's plan, length and
   * description where the answer leaves them out (a backend from before the
   * calendar): an older server never wipes them. A null start is sent, so
   * taking a task off the calendar elsewhere still comes through.
   */
  private static keepUnsent(
    value: unknown,
    task: Task,
    local: Task | undefined,
  ): Task {
    if (!local) return task;
    const raw = value as Record<string, unknown>;
    const kept = { ...task };
    if (!("startAt" in raw)) kept.startAt = local.startAt;
    if (!("minutes" in raw)) kept.minutes = local.minutes;
    if (!("notes" in raw)) kept.notes = local.notes;
    return kept;
  }

  /** A typed description as the list keeps it: line breaks stay, the ends are trimmed. */
  static cleanNotes(notes: string): string {
    const clean = Array.from(notes.replace(/\r\n?/g, "\n"))
      .filter(isWhole)
      .join("")
      // Tabs and line breaks stay; other control characters go.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
      .trim();
    return Array.from(clean).slice(0, TASK_LIMITS.notesLength).join("").trim();
  }

  /** A duration on the 15-minute grid, within the limits. */
  static cleanMinutes(minutes: number): number {
    if (!Number.isFinite(minutes)) return TASK_LIMITS.defaultMinutes;
    const step = TASK_LIMITS.stepMinutes;
    return Math.min(
      TASK_LIMITS.maxMinutes,
      Math.max(TASK_LIMITS.minMinutes, Math.round(minutes / step) * step),
    );
  }

  /** A typed title as the list keeps it; empty means there is nothing to save. */
  static cleanTitle(title: string): string {
    const clean = Array.from(title)
      .filter(isWhole)
      .join("")
      .replace(CONTROL, " ")
      .replace(SPACES, " ")
      .trim();
    // Cut whole characters, never half an emoji.
    return Array.from(clean).slice(0, TASK_LIMITS.titleLength).join("").trim();
  }

  get tasks(): readonly Task[] {
    return this.saved.tasks;
  }

  /** Not done, newest first. */
  get open(): Task[] {
    return this.view().open;
  }

  /** Done, most recently finished first. */
  get done(): Task[] {
    return this.view().done;
  }

  /** Both halves of the list; tasks in `stillOpen` show as open a moment longer. */
  view(stillOpen: ReadonlySet<string> = new Set()): {
    open: Task[];
    done: Task[];
  } {
    const open: Task[] = [];
    const done: Task[] = [];
    for (const task of this.saved.tasks)
      (task.done && !stillOpen.has(task.id) ? done : open).push(task);
    return { open: open.sort(newestFirst), done: done.sort(lastDoneFirst) };
  }

  get hasPending(): boolean {
    return Object.keys(this.saved.pending).length > 0;
  }

  get owner(): string | null {
    return this.saved.owner;
  }

  /**
   * The same list for another account (a new guest, or the account already
   * signed in here): every task becomes a change to upload, so nothing is
   * lost to a cloud copy that has never seen it.
   */
  adopt(owner: string): TaskList {
    if (owner === this.saved.owner) return this;
    const pending: Record<string, number> = {};
    for (const task of this.saved.tasks) pending[task.id] = task.updatedAt;
    return new TaskList({ tasks: this.saved.tasks, pending, owner });
  }

  find(id: string): Task | undefined {
    return this.byId.get(id);
  }

  add(title: string, now: number, id: string = crypto.randomUUID()): TaskList {
    const clean = TaskList.cleanTitle(title);
    if (!clean || this.byId.has(id)) return this;
    // Newest on top, even when two tasks land in the same millisecond.
    const newest = this.saved.tasks.reduce(
      (latest, task) => Math.max(latest, task.createdAt),
      0,
    );
    const at = this.stamp(id, Math.max(now, newest + 1));
    const task: Task = {
      id,
      title: clean,
      done: false,
      createdAt: at,
      updatedAt: at,
      doneAt: null,
      startAt: null,
      notes: "",
      minutes: TASK_LIMITS.defaultMinutes,
    };
    return this.with([...this.saved.tasks, task], {
      ...this.saved.pending,
      [id]: at,
    });
  }

  rename(id: string, title: string, now: number): TaskList {
    const task = this.byId.get(id);
    const clean = TaskList.cleanTitle(title);
    if (!task || !clean || clean === task.title) return this;
    return this.replace({ ...task, title: clean }, this.stamp(id, now));
  }

  setDone(id: string, done: boolean, now: number): TaskList {
    const task = this.byId.get(id);
    if (!task || task.done === done) return this;
    const at = this.stamp(id, now);
    return this.replace({ ...task, done, doneAt: done ? at : null }, at);
  }

  /** Plans the task for `startAt` on the calendar; null takes it off. */
  schedule(id: string, startAt: number | null, now: number): TaskList {
    const task = this.byId.get(id);
    const start = startAt === null ? null : Math.floor(startAt);
    if (!task || task.startAt === start) return this;
    if (start !== null && !Number.isFinite(start)) return this;
    return this.replace({ ...task, startAt: start }, this.stamp(id, now));
  }

  setNotes(id: string, notes: string, now: number): TaskList {
    const task = this.byId.get(id);
    const clean = TaskList.cleanNotes(notes);
    if (!task || clean === task.notes) return this;
    return this.replace({ ...task, notes: clean }, this.stamp(id, now));
  }

  setMinutes(id: string, minutes: number, now: number): TaskList {
    const task = this.byId.get(id);
    const clean = TaskList.cleanMinutes(minutes);
    if (!task || clean === task.minutes) return this;
    return this.replace({ ...task, minutes: clean }, this.stamp(id, now));
  }

  remove(ids: readonly string[], now: number): TaskList {
    const gone = new Set(ids.filter((id) => this.byId.has(id)));
    if (!gone.size) return this;
    const pending = { ...this.saved.pending };
    for (const id of gone) pending[id] = this.stamp(id, now);
    return this.with(
      this.saved.tasks.filter((task) => !gone.has(task.id)),
      pending,
    );
  }

  /** Puts deleted tasks back, as they were (Undo). */
  restore(tasks: readonly Task[], now: number): TaskList {
    const back = tasks.filter((task) => !this.byId.has(task.id));
    if (!back.length) return this;
    const pending = { ...this.saved.pending };
    const restored = back.map((task) => {
      const at = this.stamp(task.id, now);
      pending[task.id] = at;
      return { ...task, updatedAt: at };
    });
    return this.with([...this.saved.tasks, ...restored], pending);
  }

  /** The changes to send next, oldest first, within one sync's limits (and `most`, if set). */
  batch(most: number = Infinity): ListBatch {
    const batch: ListBatch = { save: [], remove: [], sent: {} };
    const changes = Object.entries(this.saved.pending).sort(
      (a, b) => a[1] - b[1],
    );
    for (const [id, at] of changes) {
      if (Object.keys(batch.sent).length >= most) break;
      const task = this.byId.get(id);
      if (task) {
        if (batch.save.length >= TASK_LIMITS.savesPerSync) continue;
        batch.save.push(task);
      } else {
        if (batch.remove.length >= TASK_LIMITS.removesPerSync) continue;
        batch.remove.push(id);
      }
      batch.sent[id] = at;
    }
    return batch;
  }

  /**
   * The cloud's list after it applied `batch`, with every change made here
   * since the batch left kept on top. Tasks missing from the cloud's list and
   * not changed here were deleted elsewhere.
   */
  confirm(batch: ListBatch, response: ListResponse): TaskList {
    const pending = { ...this.saved.pending };
    for (const [id, at] of Object.entries(batch.sent))
      if (pending[id] === at) delete pending[id];
    // The list was full: the cloud refused these new tasks.
    for (const id of response.rejected) delete pending[id];
    const merged = new Map<string, Task>();
    for (const value of response.tasks) {
      const task = TaskList.read(value);
      if (task)
        merged.set(
          task.id,
          TaskList.keepUnsent(value, task, this.byId.get(task.id)),
        );
    }
    for (const id of Object.keys(pending)) {
      const local = this.byId.get(id);
      if (local) merged.set(id, local);
      else merged.delete(id);
    }
    return this.with([...merged.values()], pending);
  }

  /** Forgets the batch's changes, so the cloud's copy comes back on the next sync. */
  discard(batch: ListBatch): TaskList {
    const pending = { ...this.saved.pending };
    for (const [id, at] of Object.entries(batch.sent))
      if (pending[id] === at) delete pending[id];
    return this.with(this.saved.tasks, pending);
  }

  /**
   * The same list, reusing `previous`'s objects for tasks that did not change,
   * so rows on screen keep their identity (and an open edit) across syncs.
   */
  reuse(previous: TaskList): TaskList {
    let changed = false;
    const tasks = this.saved.tasks.map((task) => {
      const old = previous.byId.get(task.id);
      if (old && old !== task && sameTask(old, task)) {
        changed = true;
        return old;
      }
      return task;
    });
    return changed ? this.with(tasks, this.saved.pending) : this;
  }

  /** Every change to a task gets a later time than the one before it. */
  private stamp(id: string, now: number): number {
    return Math.max(
      Math.floor(now),
      (this.byId.get(id)?.updatedAt ?? 0) + 1,
      (this.saved.pending[id] ?? 0) + 1,
    );
  }

  private replace(task: Task, at: number): TaskList {
    const updated = { ...task, updatedAt: at };
    return this.with(
      this.saved.tasks.map((old) => (old.id === task.id ? updated : old)),
      { ...this.saved.pending, [task.id]: at },
    );
  }

  private with(tasks: Task[], pending: Record<string, number>): TaskList {
    return new TaskList({ tasks, pending, owner: this.saved.owner });
  }
}
