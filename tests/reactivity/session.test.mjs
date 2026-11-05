import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../../src/auth/create-session.ts";
import { acknowledgePrivacy } from "../../src/planner/privacy-state.ts";
import { deferred } from "../helpers/queue.mjs";
import { environment, settle } from "../helpers/reactivity.mjs";

const account = {
  configured: true,
  email: "fixture@example.test",
  accountKey: "fixture:account",
};
function client(overrides = {}) {
  return {
    reads: 0,
    disposals: 0,
    async authStatus() {
      this.reads++;
      return account;
    },
    async dispose() {
      this.disposals++;
    },
    ...overrides,
  };
}

test("startup never constructs an authenticated session before privacy acknowledgement", async (t) => {
  const env = environment(t);
  const cloud = client();
  const { state } = env.mount(() => createSession(cloud, () => {}));
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.account(), undefined);
  assert.equal(cloud.reads, 0);
});

test("an acknowledged browser restores its saved account", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const cloud = client();
  const { state } = env.mount(() => createSession(cloud, () => {}));
  assert.equal(state.phase(), "restoring");
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.account(), account);
  assert.equal(cloud.reads, 1);
});

test("configuration errors reach sign-in without sending account requests", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const cloud = client();
  const { state } = env.mount(() =>
    createSession(cloud, () => {
      throw new Error("Missing configuration");
    }),
  );
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.configurationError, "Missing configuration");
  assert.equal(cloud.reads, 0);
});

test("a failed restore is reported and still shows sign-in", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const cloud = client({
    async authStatus() {
      throw new Error("Sign-in was cancelled or could not be completed.");
    },
  });
  const { state } = env.mount(() => createSession(cloud, () => {}));
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.account(), undefined);
  assert.match(state.initialError(), /Sign-in was cancelled/);
});

test("late authentication cannot update a disposed session", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const pending = deferred();
  const cloud = client({ authStatus: () => pending.promise });
  const { state, dispose } = env.mount(() => createSession(cloud, () => {}));
  dispose();
  pending.resolve(account);
  await settle();
  assert.equal(state.account(), undefined);
  assert.equal(state.phase(), "restoring");
  assert.equal(cloud.disposals, 1);
});
