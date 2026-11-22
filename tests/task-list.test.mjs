import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskList } from "../src/tasks/task-list.ts";
import { TaskStorage } from "../src/tasks/task-storage.ts";
import { TASK_LIMITS } from "../src/tasks/constants.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = 1_800_000_000_000;
const titles = (tasks) => tasks.map((task) => task.title);

test("new tasks go on top, even when added in the same millisecond", () => {
  const list = TaskList.empty().add("First", T, id(1)).add("Second", T, id(2)).add("Third", T - 5, id(3));
  assert.deepEqual(titles(list.open), ["Third", "Second", "First"]);
  assert.deepEqual(list.saved.pending, { [id(1)]: T, [id(2)]: T + 1, [id(3)]: T + 2 });
  // Nothing to add, or an id already used: the same list comes back.
  assert.equal(list.add("   ", T), list);
  assert.equal(list.add("Again", T, id(1)), list);
});

test("titles keep what people typed, minus what cannot be saved", () => {
  assert.equal(TaskList.cleanTitle("  Buy\t\tmilk \n now "), "Buy milk now");
  assert.equal(TaskList.cleanTitle("a\u0000b\u007fc"), "a b c");
  assert.equal(TaskList.cleanTitle("lone \ud83d surrogate"), "lone surrogate");
  const long = "😀".repeat(TASK_LIMITS.titleLength + 5);
  const cut = TaskList.cleanTitle(long);
  assert.equal(Array.from(cut).length, TASK_LIMITS.titleLength);
  assert.ok(cut.isWellFormed(), "never half an emoji");
});

test("every change to a task is later than the one before it", () => {
  let list = TaskList.empty().add("Task", T, id(1));
  list = list.rename(id(1), "Renamed", T);
  list = list.setDone(id(1), true, T - 1000);
  const task = list.find(id(1));
  assert.equal(task.title, "Renamed");
  assert.ok(task.updatedAt > T + 1);
  assert.equal(task.doneAt, task.updatedAt);
  assert.equal(list.saved.pending[id(1)], task.updatedAt);
  assert.equal(list.setDone(id(1), true, T), list, "already done");
  assert.equal(list.rename(id(1), "Renamed", T), list, "same title");
  assert.equal(list.rename(id(1), "  ", T), list, "empty title");
});

test("done tasks leave the open list, last finished first, and can stay a moment longer", () => {
  let list = TaskList.empty().add("A", T, id(1)).add("B", T, id(2)).add("C", T, id(3));
  list = list.setDone(id(1), true, T + 10).setDone(id(3), true, T + 20);
  assert.deepEqual(titles(list.open), ["B"]);
  assert.deepEqual(titles(list.done), ["C", "A"]);
  const view = list.view(new Set([id(3)]));
  assert.deepEqual(titles(view.open), ["C", "B"]);
  assert.deepEqual(titles(view.done), ["A"]);
});

test("removed tasks are remembered as changes, and Undo brings them back", () => {
  let list = TaskList.empty().add("Keep", T, id(1)).add("Drop", T, id(2));
  const dropped = list.find(id(2));
  list = list.remove([id(2), id(9)], T + 50);
  assert.deepEqual(titles(list.open), ["Keep"]);
  assert.ok(id(2) in list.saved.pending);
  const batch = list.batch();
  assert.deepEqual(batch.remove, [id(2)]);
  list = list.restore([dropped], T + 60);
  assert.equal(list.find(id(2)).title, "Drop");
  assert.ok(list.find(id(2)).updatedAt > list.saved.pending[id(2)] - 1);
  assert.deepEqual(titles(list.open), ["Drop", "Keep"]);
});

test("a batch sends the oldest changes first, within one sync's limits", () => {
  let list = TaskList.empty();
  for (let n = 0; n < TASK_LIMITS.savesPerSync + 5; n++) list = list.add(`Task ${n}`, T + n, id(n + 1));
  const batch = list.batch();
  assert.equal(batch.save.length, TASK_LIMITS.savesPerSync);
  assert.equal(batch.save[0].title, "Task 0");
  assert.equal(Object.keys(batch.sent).length, TASK_LIMITS.savesPerSync);
  assert.deepEqual(TaskList.empty().batch(), { save: [], remove: [], sent: {} });
});

test("the cloud's answer replaces the list, except for changes made since the batch left", () => {
  let list = TaskList.empty().add("Mine", T, id(1)).add("Also mine", T, id(2));
  const batch = list.batch();
  // While the request is out: one renamed again, one deleted, one added.
  list = list.rename(id(1), "Mine, renamed", T + 100).remove([id(2)], T + 100).add("Later", T + 100, id(3));
  const cloud = {
    tasks: [
      { ...batch.save[0] },
      { ...batch.save[1] },
      { id: id(7), title: "From my phone", done: false, createdAt: T - 1, updatedAt: T - 1, doneAt: null },
      { id: "not-a-task" },
    ],
    rejected: [],
  };
  const next = list.confirm(batch, cloud);
  assert.deepEqual(titles(next.open), ["Later", "Mine, renamed", "From my phone"]);
  assert.deepEqual(Object.keys(next.saved.pending).sort(), [id(1), id(2), id(3)]);
  // The next answer, with everything applied, settles the list.
  const settled = next.confirm(next.batch(), {
    tasks: [next.find(id(1)), next.find(id(3)), next.find(id(7))],
    rejected: [],
  });
  assert.deepEqual(settled.saved.pending, {});
  assert.deepEqual(titles(settled.open), ["Later", "Mine, renamed", "From my phone"]);
});

test("tasks gone from the cloud and unchanged here were deleted elsewhere; refused ones go too", () => {
  const synced = new TaskList({
    tasks: [
      { id: id(1), title: "Deleted on the laptop", done: false, createdAt: T, updatedAt: T, doneAt: null },
    ],
    pending: {},
  }).add("Refused: the list is full", T + 1, id(2));
  const next = synced.confirm(synced.batch(), { tasks: [], rejected: [id(2)] });
  assert.deepEqual(next.tasks, []);
  assert.deepEqual(next.saved.pending, {});
});

test("a refused batch is forgotten, but later changes to the same tasks are kept", () => {
  let list = TaskList.empty().add("Bad", T, id(1)).add("Fine", T, id(2));
  const batch = list.batch();
  list = list.rename(id(2), "Fine, edited", T + 10);
  const next = list.discard(batch);
  assert.deepEqual(Object.keys(next.saved.pending), [id(2)]);
});

test("unchanged tasks keep their objects across syncs, so rows on screen stay put", () => {
  const list = TaskList.empty().add("Same", T, id(1)).add("Edited", T, id(2));
  const fromCloud = TaskList.parse(JSON.parse(JSON.stringify(list.rename(id(2), "Edited again", T + 5).saved)));
  const reused = fromCloud.reuse(list);
  assert.equal(reused.find(id(1)), list.find(id(1)));
  assert.notEqual(reused.find(id(2)), list.find(id(2)));
  assert.equal(fromCloud.reuse(fromCloud), fromCloud);
});

test("stored lists are read defensively", () => {
  assert.deepEqual(TaskList.parse(null).tasks, []);
  assert.deepEqual(TaskList.parse({ tasks: "no", pending: [] }).tasks, []);
  const parsed = TaskList.parse({
    tasks: [
      { id: id(1), title: "Good", done: true, createdAt: T, updatedAt: T, doneAt: T },
      { id: id(2), title: "", done: false, createdAt: T, updatedAt: T, doneAt: null },
      { id: id(3), title: "Done without a time", done: true, createdAt: T, updatedAt: T, doneAt: null },
      { id: "x", title: "Bad id", done: false, createdAt: T, updatedAt: T, doneAt: null },
    ],
    pending: { [id(1)]: T, nope: T, [id(4)]: "soon" },
  });
  assert.deepEqual(titles(parsed.tasks), ["Good"]);
  assert.deepEqual(parsed.saved.pending, { [id(1)]: T });
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

test("storage keeps this browser's list for every tab", () => {
  const storage = memoryStorage();
  const mine = new TaskStorage(storage);
  const otherTab = new TaskStorage(storage);
  mine.write(TaskList.empty().add("Shared", T, id(1)));
  assert.deepEqual(titles(otherTab.read().tasks), ["Shared"]);
  assert.ok(storage.getItem("prune:list:v1"));
  // An unchanged copy is not parsed again.
  assert.equal(mine.read(), mine.read());
  mine.clear();
  assert.equal(storage.getItem("prune:list:v1"), null);
});

test("a list taken over by another account uploads everything, and remembers whose it is", () => {
  const synced = TaskList.empty().add("A", T, id(1)).add("B", T, id(2)).remove([id(2)], T + 1);
  const confirmed = synced.adopt("project:old").confirm(synced.adopt("project:old").batch(), { tasks: [synced.find(id(1))], rejected: [] });
  assert.deepEqual(confirmed.saved.pending, {});
  assert.equal(confirmed.owner, "project:old");
  const moved = confirmed.adopt("project:new");
  assert.equal(moved.owner, "project:new");
  assert.deepEqual(moved.saved.pending, { [id(1)]: confirmed.find(id(1)).updatedAt });
  assert.equal(moved.adopt("project:new"), moved);
  // The owner survives every change and a round trip through storage.
  const edited = moved.rename(id(1), "A2", T + 5).setDone(id(1), true, T + 6);
  assert.equal(edited.owner, "project:new");
  assert.equal(TaskList.parse(JSON.parse(JSON.stringify(edited.saved))).owner, "project:new");
  assert.equal(TaskList.parse({ tasks: [], pending: {}, owner: 42 }).owner, null);
});

test("a full or blocked storage keeps the list in memory instead of losing edits", () => {
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new DOMException("Full", "QuotaExceededError");
  };
  const tasks = new TaskStorage(storage);
  tasks.write(TaskList.empty().add("Kept in memory", T, id(1)));
  assert.deepEqual(titles(tasks.read().tasks), ["Kept in memory"]);
  const none = new TaskStorage(null);
  none.write(TaskList.empty().add("No storage at all", T, id(1)));
  assert.deepEqual(titles(none.read().tasks), ["No storage at all"]);
});

test("an unreadable saved list starts empty rather than failing", () => {
  const storage = memoryStorage();
  storage.setItem("prune:list:v1", "{not json");
  assert.deepEqual(new TaskStorage(storage).read().tasks, []);
});

test("what earlier versions kept in the browser is removed, and nothing else", () => {
  const storage = memoryStorage();
  for (const key of ["pro:planner:v1:x", "prune:tour:v1:x", "prune:hint:v1:x:y", "prune:visits:v1:x", "prune:insights:v1:x", "prune:suggestions:v1:x:today", "prune:onboarding:v1:x", "prune:focus-sound-volume:v1", "prune:tasks:v1:x"])
    storage.setItem(key, "old");
  for (const key of ["prune:list:v1", "prune:cookies:v1", "prune:auth:x", "prune:privacy:acknowledgement", "unrelated"])
    storage.setItem(key, "keep");
  TaskStorage.clearRetired(storage);
  assert.deepEqual([...storage.values.keys()].sort(), ["prune:auth:x", "prune:cookies:v1", "prune:list:v1", "prune:privacy:acknowledgement", "unrelated"]);
  TaskStorage.clearRetired(null);
});
