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
    imports: 0,
    disposals: 0,
    async authStatus() {
      this.reads++;
      return account;
    },
    async importGuestTasks() {
      this.imports++;
    },
    async signOut() {},
    async dispose() {
      this.disposals++;
    },
    ...overrides,
  };
}

test("guest startup never constructs an authenticated session before privacy acknowledgement", async (t) => {
  const env = environment(t);
  const cloud = client();
  const { state } = env.mount(() => createSession(cloud, client(), () => {}));
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.account(), undefined);
  assert.equal(cloud.reads, 0);
  state.startSignIn();
  assert.equal(state.signingIn(), true);
  state.continueAsGuest();
  assert.equal(state.signingIn(), false);
});

test("configuration errors leave guest mode usable without sending account requests", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const cloud = client();
  const { state } = env.mount(() =>
    createSession(cloud, client(), () => {
      throw new Error("Missing configuration");
    }),
  );
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.configurationError, "Missing configuration");
  assert.equal(cloud.reads, 0);
});

test("guest transfer has explicit failure and retry phases bound to the same account", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  let attempts = 0;
  const cloud = client({
    async importGuestTasks() {
      if (++attempts === 1) throw new Error("Offline");
    },
  });
  const { state } = env.mount(() => createSession(cloud, client(), () => {}));
  await settle();
  assert.equal(state.phase(), "transferFailed");
  assert.equal(state.transferError(), "Offline");
  assert.equal(state.account(), account);
  state.retryTransfer();
  await settle();
  assert.equal(state.phase(), "ready");
  assert.equal(state.transferError(), "");
  assert.equal(attempts, 2);
});

test("survey answers travel with the import, and only fresh sign-ins count as interactive", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const sent = [];
  const signedIn = [];
  let attempts = 0;
  const cloud = client({
    async importGuestTasks(survey) {
      sent.push(survey);
      if (++attempts === 2) throw new Error("Offline");
      return true;
    },
  });
  const { state } = env.mount(() =>
    createSession(cloud, client(), () => {}, {
      surveyImport: () => ({ goal: "ship" }),
      onSignedIn: (interactive, imported) =>
        signedIn.push({ interactive, imported }),
    }),
  );
  await settle();
  assert.deepEqual(signedIn, [{ interactive: false, imported: true }]);
  await state.finishSignIn(account, true);
  assert.equal(state.phase(), "transferFailed");
  state.retryTransfer();
  await settle();
  assert.equal(state.phase(), "ready");
  assert.deepEqual(signedIn, [
    { interactive: false, imported: true },
    { interactive: true, imported: true },
  ]);
  assert.deepEqual(sent, [
    { goal: "ship" },
    { goal: "ship" },
    { goal: "ship" },
  ]);
});

test("simultaneous sign-in callbacks cannot start duplicate guest transfers", async (t) => {
  const env = environment(t);
  const pending = deferred();
  const cloud = client({
    async importGuestTasks() {
      this.imports++;
      await pending.promise;
    },
  });
  const { state } = env.mount(() => createSession(cloud, client(), () => {}));
  await settle();
  const first = state.finishSignIn(account);
  await state.finishSignIn(account);
  assert.equal(state.phase(), "transferring");
  assert.equal(cloud.imports, 1);
  pending.resolve();
  await first;
  assert.equal(state.phase(), "ready");
});

test("late authentication cannot update a disposed session or start a transfer", async (t) => {
  const env = environment(t);
  acknowledgePrivacy(env.storage);
  const pending = deferred();
  const cloud = client({ authStatus: () => pending.promise });
  const guest = client();
  const { state, dispose } = env.mount(() =>
    createSession(cloud, guest, () => {}),
  );
  dispose();
  pending.resolve(account);
  await settle();
  assert.equal(state.account(), undefined);
  assert.equal(cloud.imports, 0);
  assert.equal(cloud.disposals, 1);
  assert.equal(guest.disposals, 1);
});

test("a transfer finishing after disposal cannot show an authenticated planner", async (t) => {
  const env = environment(t);
  const pending = deferred();
  const cloud = client({ importGuestTasks: () => pending.promise });
  const { state, dispose } = env.mount(() =>
    createSession(cloud, client(), () => {}),
  );
  await settle();
  const transferring = state.finishSignIn(account);
  dispose();
  pending.resolve();
  await transferring;
  assert.equal(state.phase(), "transferring");
});

test("failed transfer-screen sign-out is reported instead of becoming an unhandled rejection", async (t) => {
  const env = environment(t);
  const cloud = client({
    async signOut() {
      throw new Error("Could not sign out");
    },
  });
  const { state } = env.mount(() => createSession(cloud, client(), () => {}));
  await state.signOut();
  assert.equal(state.transferError(), "Could not sign out");
});
