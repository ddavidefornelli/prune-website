import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffect, createSignal } from "solid-js";
import { createPlanner } from "../../src/planner/create-planner.ts";
import { PlanningClient } from "../../src/planner/api.ts";
import { createWeeklyReview } from "../../src/reviews/create-weekly-review.ts";
import { POLLING } from "../../src/planner/constants.ts";
import { dashboard, deferred } from "../helpers/queue.mjs";

import { environment, settle } from "../helpers/reactivity.mjs";

function task(data, overrides = {}) {
  return { id: "task-1", outcome: "A small win", plannedFor: data.today, estimatedMinutes: 30,
    actualSeconds: 0, status: "planned", startedAt: null, completedOn: null,
    createdAt: data.serverNow, isPriority: false, resources: [], ...overrides };
}

function plannerClient(initial = dashboard()) {
  return {
    data: initial, reads: 0, syncs: 0, syncBlocked: false,
    onQueueChange: () => {},
    cachedDashboard() { return structuredClone(this.data); },
    async dashboard() { this.reads++; return structuredClone(this.data); },
    async sync() { this.syncs++; },
  };
}

function overview(overrides = {}) {
  return { settings: { enabled: true }, model: "fixture", available: true,
    week: { start: "2026-10-19", end: "2026-10-25", nextUpdate: "2026-11-01" },
    status: "up_to_date", error: null, reviews: [], ...overrides };
}

test("dashboard reconciliation preserves task identity and memory-only notes", async (t) => {
  const env = environment(t);
  const client = plannerClient();
  client.data.activeTask = task(client.data, { status: "active" });
  client.data.todayTasks = [structuredClone(client.data.activeTask)];
  const { state } = env.mount(() => createPlanner(client));
  await settle();
  const identity = state.data().activeTask;
  state.setNotes("Never persist this scratchpad");
  client.data.activeTask.actualSeconds = 12;
  client.data.revision++;
  client.onQueueChange();
  assert.equal(state.data().activeTask, identity);
  assert.equal(state.data().activeTask.actualSeconds, 12);
  assert.equal(state.notes(), "Never persist this scratchpad");
  client.data.activeTask = task(client.data, { id: "task-2", status: "active" });
  client.data.revision++;
  client.onQueueChange();
  assert.equal(state.notes(), "");
});

test("time-only dashboard refreshes preserve keyed data without notifying unchanged title subscribers", async (t) => {
  const env = environment(t);
  const client = plannerClient();
  client.data.todayTasks = [task(client.data)];
  let titleUpdates = 0;
  const { state } = env.mount(() => {
    const planner = createPlanner(client);
    createEffect(() => {
      planner.data()?.todayTasks[0]?.outcome;
      titleUpdates++;
    });
    return planner;
  });
  await settle();
  const tasks = state.data().todayTasks;
  const first = tasks[0];
  const before = titleUpdates;
  client.data.serverNow += 30;
  await state.refresh();
  assert.equal(state.data().todayTasks, tasks);
  assert.equal(state.data().todayTasks[0], first);
  assert.equal(titleUpdates, before);
  assert.ok(Math.abs(state.now() - client.data.serverNow) <= 1);
});

for (const [action, pendingCount, approved] of [
  ["signOut", 0, true],
  ["signOut", 2, true],
  ["signOut", 2, false],
  ["deleteAccount", 0, true],
  ["deleteAccount", 2, false],
]) {
  test(`${action} preserves confirmation and reload behavior (pending=${pendingCount}, approved=${approved})`, async (t) => {
    const env = environment(t);
    const confirmations = [];
    let calls = 0;
    let reloads = 0;
    env.window.confirm = (message) => { confirmations.push(message); return approved; };
    env.window.location.reload = () => { reloads++; };
    const client = { ...plannerClient(), pendingCount, [action]: async () => {
      assert.equal(state.accountAction(), action === "signOut" ? "signOut" : "delete");
      calls++;
    } };
    const { state } = env.mount(() => createPlanner(client));
    await settle();
    await state[action]();
    assert.equal(confirmations.length, action === "deleteAccount" || pendingCount ? 1 : 0);
    if (confirmations.length)
      assert.match(confirmations[0], action === "deleteAccount" ? /Delete your account/ : /Sign out anyway/);
    assert.equal(calls, approved ? 1 : 0);
    assert.equal(reloads, calls);
    assert.equal(state.accountAction(), null);
    assert.equal(state.busy(), false);
  });
}

test("failed account actions clear their busy state, report errors, and cannot run twice concurrently", async (t) => {
  const env = environment(t);
  const pending = deferred();
  let calls = 0;
  env.window.location.reload = () => assert.fail("A failed sign-out must not reload");
  const client = { ...plannerClient(), pendingCount: 0, signOut: () => { calls++; return pending.promise; } };
  const { state } = env.mount(() => createPlanner(client));
  await settle();
  const signingOut = state.signOut();
  await state.deleteAccount();
  assert.equal(state.busy(), true);
  assert.equal(state.accountAction(), "signOut");
  pending.reject(new Error("Sign-out failed"));
  await signingOut;
  assert.equal(calls, 1);
  assert.equal(state.busy(), false);
  assert.equal(state.accountAction(), null);
  assert.equal(state.error(), "Sign-out failed");
});

test("running timers lock the view, but completing a mutation can select Today", async (t) => {
  const env = environment(t);
  const client = plannerClient();
  client.data.activeTask = task(client.data, { status: "active", startedAt: client.data.serverNow });
  const { state } = env.mount(() => createPlanner(client));
  await settle();
  state.visit("profile");
  assert.equal(state.view(), "focus");
  assert.equal(state.focusLocked(), true);
  assert.equal(await state.mutate(async () => { client.data.activeTask = null; state.visit("today"); }), true);
  assert.equal(state.view(), "today");
  assert.equal(state.busy(), false);
  assert.equal(await state.mutate(async () => { throw new Error("Save failed"); }), false);
  assert.equal(state.error(), "Save failed");
  assert.equal(state.busy(), false);
});

test("planner disposal removes timers, listeners and queue subscriptions", async (t) => {
  const env = environment(t);
  const client = plannerClient();
  const { dispose } = env.mount(() => createPlanner(client));
  await settle();
  assert.deepEqual([...env.timers.values()].map(({ delay }) => delay).sort((a, b) => a - b), [POLLING.clock, POLLING.dashboard]);
  dispose();
  assert.equal(env.timers.size, 0);
  const reads = client.reads;
  env.window.dispatchEvent(new Event("focus"));
  env.document.dispatchEvent(new Event("visibilitychange"));
  client.onQueueChange();
  await settle();
  assert.equal(client.reads, reads);
  assert.equal(client.syncs, 0);
});

test("a late dashboard response cannot update a disposed planner", async (t) => {
  const env = environment(t);
  const pending = deferred();
  const client = { ...plannerClient(), cachedDashboard: () => null, dashboard: () => pending.promise };
  const { state, dispose } = env.mount(() => createPlanner(client));
  dispose();
  pending.resolve(dashboard());
  await settle();
  assert.equal(state.data(), null);
  assert.equal(env.timers.size, 0);
});

test("a preference write cannot be overwritten by an older weekly-review read", async (t) => {
  const env = environment(t);
  const pending = deferred();
  const client = {
    weeklyOverview: () => pending.promise,
    generateIfDue: async () => {},
    enableWeeklyAi: async () => overview(),
  };
  const { state } = env.mount(() => createWeeklyReview(client, () => true));
  await state.enable();
  assert.equal(state.data().settings.enabled, true);
  pending.resolve(overview({ settings: { enabled: false }, status: "disabled" }));
  await settle();
  assert.equal(state.data().settings.enabled, true);
  assert.equal(state.error(), "");
});

test("pending-review polling follows visibility and is disposed with its owner", async (t) => {
  const env = environment(t);
  const [visible, setVisible] = createSignal(true);
  let checks = 0;
  const client = {
    weeklyOverview: async () => overview({ status: "pending" }),
    generateIfDue: async () => { checks++; },
  };
  const { dispose } = env.mount(() => createWeeklyReview(client, visible));
  await settle();
  assert.equal([...env.timers.values()].filter(({ delay }) => delay === POLLING.pendingReview).length, 1);
  setVisible(false);
  assert.equal([...env.timers.values()].filter(({ delay }) => delay === POLLING.pendingReview).length, 0);
  dispose();
  assert.equal(env.timers.size, 0);
  const before = checks;
  env.window.dispatchEvent(new Event("focus"));
  env.document.dispatchEvent(new Event("visibilitychange"));
  setVisible(true);
  await settle();
  assert.equal(checks, before);
});

test("disposing during authentication cannot start an outbox or new subscriptions", async (t) => {
  environment(t);
  const pending = deferred();
  const commands = [];
  let disposals = 0;
  const transport = {
    onAccountChange: () => {},
    execute: async (command) => { commands.push(command); return pending.promise; },
    dispose: async () => { disposals++; },
  };
  const client = new PlanningClient({ cloud: transport });
  const restoring = client.authStatus();
  await client.dispose();
  pending.resolve({ configured: true, email: "fixture@example.test", accountKey: "fixture:account" });
  await assert.rejects(restoring, /client is closed/);
  await client.dispose();
  assert.equal(disposals, 1);
  assert.deepEqual(commands, ["auth_status"]);
  await assert.rejects(client.dashboard(), /client is closed/);
});

test("late weekly-review reads are ignored after disposal", async (t) => {
  const env = environment(t);
  const pending = deferred();
  const client = { weeklyOverview: () => pending.promise, generateIfDue: async () => {} };
  const { state, dispose } = env.mount(() => createWeeklyReview(client, () => true));
  dispose();
  pending.resolve(overview());
  await settle();
  assert.equal(state.data(), null);
  assert.equal(env.timers.size, 0);
});
