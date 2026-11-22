import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudError } from "../../src/cloud/cloud-error.ts";
import { LIST_SYNC, LIST_TIMING } from "../../src/tasks/constants.ts";
import { ListState } from "../../src/tasks/list-state.ts";
import { deferred } from "../helpers/fakes.mjs";
import { environment, settle } from "../helpers/reactivity.mjs";

const STORED = "prune:list:v1";

/** A cloud that applies syncs like planner_list (newest edit wins), and an account client around it. */
function fakeClient({ accepted = true, session = true } = {}) {
  const client = {
    accepted,
    tasks: [],
    syncs: [],
    identities: [],
    accountKey: session ? "project:guest-1" : null,
    failure: null,
    identityFailure: null,
    pending: null,
    erases: 0,
    eraseFailure: null,
    forgets: 0,
    accept() {
      client.accepted = true;
      return true;
    },
    async ensureAccount(create) {
      client.identities.push(create);
      if (!client.accepted) throw new CloudError("privacy", "Accept first.");
      if (client.identityFailure) throw client.identityFailure;
      if (!client.accountKey && create) client.accountKey = "project:guest-new";
      return client.accountKey ? { accountKey: client.accountKey, email: null, guest: true } : null;
    },
    async syncList(changes) {
      client.syncs.push(structuredClone(changes));
      if (client.pending) await client.pending;
      if (client.failure) throw client.failure;
      client.tasks = client.tasks.filter((task) => !changes.remove.includes(task.id));
      for (const task of changes.save) {
        const index = client.tasks.findIndex((saved) => saved.id === task.id);
        if (index === -1) client.tasks.push(structuredClone(task));
        else if (client.tasks[index].updatedAt <= task.updatedAt) client.tasks[index] = structuredClone(task);
      }
      return { tasks: structuredClone(client.tasks), rejected: [] };
    },
    async eraseEverything() {
      if (client.eraseFailure) throw client.eraseFailure;
      client.erases++;
      client.tasks = [];
    },
    async forget() {
      client.forgets++;
      client.accountKey = null;
    },
  };
  return client;
}

async function fixture(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const env = environment(t);
  let reloads = 0;
  env.window.location = { reload: () => reloads++ };
  const client = fakeClient(options);
  const { state, dispose } = env.mount(() => new ListState(client, env.storage));
  /** Lets due timers fire and their requests settle. */
  const run = async (ms = 0) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 5; i++) await settle();
  };
  await run();
  return { ...env, client, state, dispose, run, reloads: () => reloads, saved: () => JSON.parse(env.storage.getItem(STORED) ?? "null") };
}

const titles = (tasks) => tasks.map((task) => task.title);

test("a new visitor's list works at once; the first task accepts the terms and starts syncing as a guest", async (t) => {
  const f = await fixture(t, { accepted: false, session: false });
  assert.equal(f.state.needsConsent(), true);
  assert.deepEqual(f.client.syncs, []);
  assert.equal(f.state.add("First"), true);
  assert.equal(f.state.needsConsent(), false);
  assert.equal(f.client.accepted, true);
  await f.run(LIST_SYNC.debounceMs);
  assert.deepEqual(f.client.identities.at(-1), true);
  assert.deepEqual(titles(f.client.tasks), ["First"]);
  assert.equal(f.saved().owner, "project:guest-new");
  assert.deepEqual(f.saved().pending, {});
  assert.equal(f.state.account().accountKey, "project:guest-new");
});

test("no guest is made while the list is empty", async (t) => {
  const f = await fixture(t, { session: false });
  await f.run(LIST_SYNC.pollMs);
  assert.ok(f.client.identities.every((create) => create === false));
  assert.equal(f.client.accountKey, null);
  assert.deepEqual(f.client.syncs, []);
});

test("an edit is saved on the device at once, and a burst reaches the cloud in one sync", async (t) => {
  const f = await fixture(t);
  assert.equal(f.client.syncs.length, 1, "the first read");
  assert.equal(f.state.add("One"), true);
  assert.equal(f.state.add("Two"), true);
  assert.equal(f.state.add("   "), false);
  assert.deepEqual(titles(f.state.open()), ["Two", "One"]);
  assert.equal(Object.keys(f.saved().pending).length, 2);
  await f.run(LIST_SYNC.debounceMs);
  assert.equal(f.client.syncs.length, 2);
  assert.deepEqual(titles(f.client.syncs[1].save), ["One", "Two"]);
  assert.deepEqual(f.saved().pending, {});
});

test("offline, changes stay on the device, retries back off, and nothing is shown", async (t) => {
  const f = await fixture(t);
  f.client.failure = new CloudError("network", "Could not reach prune.");
  f.state.add("Written offline");
  await f.run(LIST_SYNC.debounceMs);
  assert.equal(f.client.syncs.length, 2);
  await f.run(LIST_SYNC.initialRetryMs);
  assert.equal(f.client.syncs.length, 3);
  // The next pause is twice as long.
  await f.run(LIST_SYNC.initialRetryMs);
  assert.equal(f.client.syncs.length, 3);
  assert.equal(f.state.notice(), "");
  f.client.failure = null;
  await f.run(LIST_SYNC.initialRetryMs);
  assert.equal(f.client.syncs.length, 4);
  assert.deepEqual(titles(f.client.tasks), ["Written offline"]);
  assert.deepEqual(f.saved().pending, {});
});

test("when no guest id can be made, the list carries on here and asks again much later", async (t) => {
  const f = await fixture(t, { session: false });
  f.client.identityFailure = new CloudError("auth", "Anonymous sign-ins are disabled.");
  f.state.add("Here only");
  await f.run(LIST_SYNC.debounceMs);
  const asked = f.client.identities.length;
  await f.run(LIST_SYNC.maxRetryMs);
  await f.run(LIST_SYNC.maxRetryMs);
  assert.ok(f.client.identities.length - asked <= 3, "backs off");
  assert.deepEqual(titles(f.state.open()), ["Here only"]);
  assert.equal(f.state.notice(), "");
  assert.deepEqual(f.client.syncs, []);
});

test("a change the cloud refuses is dropped quietly", async (t) => {
  const f = await fixture(t);
  f.client.failure = new CloudError("validation", "Some changes could not be read.");
  f.state.add("Refused");
  await f.run(LIST_SYNC.debounceMs);
  assert.equal(f.state.notice(), "");
  assert.deepEqual(f.saved().pending, {});
  f.client.failure = null;
  await f.run(0);
  assert.deepEqual(titles(f.state.open()), []);
});

test("edits made while a sync is out survive its answer, and go out next", async (t) => {
  const f = await fixture(t);
  f.state.add("Draft");
  const gate = deferred();
  f.client.pending = gate.promise;
  await f.run(LIST_SYNC.debounceMs);
  const id = f.state.open()[0].id;
  f.state.rename(id, "Final");
  f.client.pending = null;
  gate.resolve();
  await f.run(0);
  assert.deepEqual(titles(f.state.open()), ["Final"]);
  await f.run(LIST_SYNC.debounceMs);
  assert.deepEqual(titles(f.client.tasks), ["Final"]);
  assert.deepEqual(f.saved().pending, {});
});

test("a different account for this browser gets the whole list, not an empty one", async (t) => {
  const f = await fixture(t);
  f.state.add("Kept");
  await f.run(LIST_SYNC.debounceMs);
  // The old guest is gone (say, cleaned up on the server): a new one, with an empty cloud.
  f.client.accountKey = "project:guest-2";
  f.client.tasks = [];
  f.dispose();
  const again = f.mount(() => new ListState(f.client, f.storage));
  await f.run(0);
  assert.deepEqual(titles(again.state.open()), ["Kept"]);
  assert.deepEqual(titles(f.client.tasks), ["Kept"]);
  assert.equal(f.saved().owner, "project:guest-2");
});

test("another tab's change shows up from storage", async (t) => {
  const f = await fixture(t);
  const other = { id: "00000000-0000-4000-8000-000000000001", title: "From the other tab", done: false, createdAt: 1, updatedAt: 1, doneAt: null };
  f.storage.setItem(STORED, JSON.stringify({ tasks: [other], pending: { [other.id]: 1 }, owner: "project:guest-1" }));
  f.window.dispatchEvent(Object.assign(new Event("storage"), { key: STORED }));
  assert.deepEqual(titles(f.state.open()), ["From the other tab"]);
});

test("a ticked task stays in place a moment, then moves to Done", async (t) => {
  const f = await fixture(t);
  f.state.add("Tick me");
  const id = f.state.open()[0].id;
  f.state.toggle(id);
  assert.deepEqual(titles(f.state.open()), ["Tick me"]);
  assert.equal(f.state.open()[0].done, true);
  assert.deepEqual(f.state.done(), []);
  await f.run(LIST_TIMING.settleMs);
  assert.deepEqual(f.state.open(), []);
  assert.deepEqual(titles(f.state.done()), ["Tick me"]);
  assert.deepEqual(f.state.doneIds(), [id]);
  f.state.toggle(id);
  assert.deepEqual(titles(f.state.open()), ["Tick me"]);
  assert.equal(f.state.open()[0].done, false);
});

test("Undo puts deleted tasks back, and the offer goes away by itself", async (t) => {
  const f = await fixture(t);
  f.state.add("Keep me");
  const id = f.state.open()[0].id;
  f.state.remove(id);
  assert.equal(f.state.undo().message, "Task deleted");
  f.state.undoLast();
  assert.deepEqual(titles(f.state.open()), ["Keep me"]);
  assert.equal(f.state.undo(), null);
  f.state.rename(id, "  ");
  assert.deepEqual(f.state.open(), [], "an emptied title deletes");
  await f.run(LIST_TIMING.undoMs);
  assert.equal(f.state.undo(), null);
});

test("Clear removes every done task at once, with Undo", async (t) => {
  const f = await fixture(t);
  for (const title of ["A", "B", "C"]) f.state.add(title);
  for (const task of f.state.open().filter((task) => task.title !== "B")) f.state.toggle(task.id);
  await f.run(LIST_TIMING.settleMs);
  f.state.clearDone();
  assert.equal(f.state.undo().message, "2 tasks cleared");
  assert.deepEqual(titles(f.state.open()), ["B"]);
  assert.deepEqual(f.state.done(), []);
  f.state.undoLast();
  assert.deepEqual(titles(f.state.done()).sort(), ["A", "C"]);
});

test("Delete everything asks first, erases, forgets this browser's list and reloads; a failure keeps everything", async (t) => {
  const f = await fixture(t);
  f.state.add("Mine");
  await f.run(LIST_SYNC.debounceMs);
  f.window.confirm = () => false;
  await f.state.eraseEverything();
  assert.equal(f.client.erases, 0);
  f.window.confirm = () => true;
  f.client.eraseFailure = new CloudError("network", "Offline");
  await f.state.eraseEverything();
  assert.equal(f.state.eraseError(), "Couldn't delete right now. Check your connection and try again.");
  assert.equal(f.state.erasing(), false);
  assert.notEqual(f.storage.getItem(STORED), null);
  assert.equal(f.reloads(), 0);
  f.client.eraseFailure = null;
  await f.state.eraseEverything();
  assert.equal(f.client.erases, 1);
  assert.equal(f.storage.getItem(STORED), null);
  assert.equal(f.reloads(), 1);
});

test("an account deleted elsewhere clears this browser and reloads, with nothing to read", async (t) => {
  const f = await fixture(t);
  f.state.add("Seen elsewhere");
  f.client.failure = new CloudError("account_deleted", "This account was deleted.");
  await f.run(LIST_SYNC.debounceMs);
  assert.equal(f.storage.getItem(STORED), null);
  assert.equal(f.client.forgets, 1);
  assert.equal(f.reloads(), 1);
  assert.equal(f.state.notice(), "");
});

test("disposal ends syncing, timers and listeners", async (t) => {
  const f = await fixture(t);
  f.state.add("Last one");
  f.dispose();
  await f.run(LIST_SYNC.pollMs * 2);
  assert.equal(f.client.syncs.length, 1);
  f.window.dispatchEvent(new Event("online"));
  await f.run(0);
  assert.equal(f.client.syncs.length, 1);
});
