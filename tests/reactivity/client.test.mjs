import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanningClient } from "../../src/planner/api.ts";
import { applyCommand } from "../../src/planner/task-projection.ts";
import { dashboard, persistence } from "../helpers/queue.mjs";
import { environment } from "../helpers/reactivity.mjs";

const account = {
  configured: true,
  email: "fixture@example.test",
  accountKey: "fixture:account",
};
function fixture(t, overrides = {}) {
  let client;
  t.after(() => client?.dispose());
  const env = environment(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const { lock } = persistence();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: { request: lock },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  });
  const data = dashboard();
  const calls = [];
  const cloud = {
    onAccountChange() {},
    async dispose() {},
    async execute(command, args) {
      calls.push({ command, args });
      if (overrides.execute) return overrides.execute(command, args);
      if (command === "auth_status") return account;
      if (command === "sign_out") return null;
      switch (args.action) {
        case "account_status":
          return { isDeleted: false };
        case "dashboard":
          return structuredClone(data);
        case "queue_protocol":
          return { version: overrides.protocol ?? 1 };
        case "delete_account":
          return { isDeleted: true };
        default:
          return applyCommand(data, {
            action: args.action,
            timezone: args.timezone,
            args: args.args,
            requestId: args.args._requestId,
            at: args.args._at,
            revision: args.args._revision,
          });
      }
    },
  };
  client = new PlanningClient({ cloud });
  return { ...env, client, cloud, calls, data };
}

test("account sync checks its protocol before sending writes and retries without discarding", async (t) => {
  const options = { protocol: 0 };
  const f = fixture(t, options);
  await f.client.authStatus();
  const data = await f.client.dashboard();
  await f.client.create("Keep this change", data.today, 15);
  await f.client.sync();
  assert.equal(f.client.pendingCount, 1);
  assert.equal(f.client.syncBlocked, false);
  assert.equal(
    f.calls.filter(({ args }) => args?.action === "create_task").length,
    0,
  );
  options.protocol = 1;
  await f.client.sync();
  assert.equal(f.client.pendingCount, 0);
  assert.equal(f.data.todayTasks[0].outcome, "Keep this change");
  const write = f.calls.find(({ args }) => args?.action === "create_task");
  assert.equal(write.args.args._accountKey, account.accountKey);
  assert.equal(write.args.args._requestId, f.data.todayTasks[0].id);
});

test("confirmed deletion never resumes the outbox when local sign-out fails", async (t) => {
  const f = fixture(t);
  await f.client.authStatus();
  await f.client.dashboard();
  const execute = f.cloud.execute.bind(f.cloud);
  f.cloud.execute = async (command, args) => {
    if (command === "sign_out") throw new Error("Storage unavailable");
    return execute(command, args);
  };
  await assert.rejects(f.client.deleteAccount(), /Storage unavailable/);
  const reads = f.calls.length;
  await f.client.sync();
  assert.equal(f.calls.length, reads);
});

test("a failed deletion resumes syncing, rather than silently disabling account saves", async (t) => {
  const f = fixture(t);
  await f.client.authStatus();
  await f.client.dashboard();
  const execute = f.cloud.execute.bind(f.cloud);
  f.cloud.execute = async (command, args) => {
    if (args?.action === "delete_account") throw new Error("Offline");
    return execute(command, args);
  };
  await assert.rejects(f.client.deleteAccount(), /Offline/);
  await f.client.create("Still usable", f.data.today, 15);
  await f.client.sync();
  // A resume-triggered dashboard read may already be finishing when we enqueue.
  await f.client.sync();
  assert.equal(f.client.pendingCount, 0);
  assert.equal(f.data.todayTasks[0].outcome, "Still usable");
});

test("Google sign-in goes through the transport", async (t) => {
  const f = fixture(t, { execute: () => null });
  await f.client.signInWithGoogle();
  assert.deepEqual(
    f.calls.map(({ command }) => command),
    ["sign_in_with_google"],
  );
});

