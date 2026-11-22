import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountClient } from "../../src/cloud/account.ts";
import { PRIVACY_ACKNOWLEDGEMENT_KEY, PrivacyNotice } from "../../src/cloud/privacy-state.ts";
import { environment } from "../helpers/reactivity.mjs";

const guest = { accountKey: "project:guest", email: null, guest: true };
const account = { accountKey: "project:alice", email: "alice@example.test", guest: false };

/** `session`: the browser already has a saved session (else a guest is made only on request). */
function fixture(t, { identity = guest, session = true, execute, accepted = true } = {}) {
  const env = environment(t);
  if (accepted) new PrivacyNotice(env.storage).acknowledge();
  const calls = [];
  const cloud = {
    onAccountChange() {},
    async dispose() {},
    async execute(command, args) {
      calls.push({ command, args });
      const answer = execute?.(command, args);
      if (answer !== undefined) return answer;
      if (command === "identity") return session || args.create ? identity : null;
      if (command === "planner_list") return { tasks: [], rejected: [] };
      if (args?.action === "delete_account") return { isDeleted: true };
      return null;
    },
  };
  const client = new AccountClient({ cloud, storage: env.storage });
  t.after(() => client.dispose());
  return { client, calls, env };
}

test("nothing reaches the cloud before the terms are accepted", async (t) => {
  const f = fixture(t, { accepted: false });
  assert.equal(f.client.accepted, false);
  await assert.rejects(f.client.ensureAccount(), (error) => error.code === "privacy");
  assert.deepEqual(f.calls, []);
  assert.equal(f.client.accept(), true);
  assert.equal(f.client.accepted, true);
  assert.ok(f.env.storage.getItem(PRIVACY_ACKNOWLEDGEMENT_KEY));
});

test("a guest is made only when there is something to keep, then remembered", async (t) => {
  const f = fixture(t, { session: false });
  assert.equal(await f.client.ensureAccount(false), null);
  assert.deepEqual(await f.client.ensureAccount(true), guest);
  assert.deepEqual(await f.client.ensureAccount(true), guest);
  assert.deepEqual(f.calls.map(({ command, args }) => [command, args.create]), [["identity", false], ["identity", true]]);
  assert.equal(f.client.current, guest);
});

test("list syncs name the account they expect, with the browser's time zone", async (t) => {
  const f = fixture(t);
  await f.client.ensureAccount();
  await f.client.syncList({ save: [], remove: ["x"] });
  const sync = f.calls.find(({ command, args }) => command === "planner_list" && args.action === "sync");
  assert.deepEqual(sync.args.args, { save: [], remove: ["x"], _accountKey: guest.accountKey });
  assert.equal(sync.args.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("erasing a guest erases its list and forgets the session; an older account is also marked for removal", async (t) => {
  const g = fixture(t);
  await g.client.eraseEverything();
  assert.deepEqual(g.calls.map(({ command, args }) => [command, args?.action ?? null]), [["identity", null], ["planner_list", "erase"], ["sign_out", null]]);
  assert.equal(g.client.current, null);
  const a = fixture(t, { identity: account });
  await a.client.eraseEverything();
  assert.deepEqual(a.calls.map(({ command, args }) => [command, args?.action ?? null]), [["identity", null], ["planner_list", "erase"], ["planner_call", "delete_account"], ["sign_out", null]]);
});

test("erasing never makes a guest just to erase it, and does nothing before acceptance", async (t) => {
  const noSession = fixture(t, { execute: (command) => (command === "identity" ? null : undefined) });
  await noSession.client.eraseEverything();
  assert.deepEqual(noSession.calls.map(({ command, args }) => [command, args.create]), [["identity", false]]);
  const notAccepted = fixture(t, { accepted: false });
  await notAccepted.client.eraseEverything();
  assert.deepEqual(notAccepted.calls, []);
});

test("an unconfirmed deletion of an older account fails before forgetting the session", async (t) => {
  const f = fixture(t, { identity: account, execute: (_command, args) => (args?.action === "delete_account" ? { isDeleted: false } : undefined) });
  await assert.rejects(f.client.eraseEverything(), /not confirmed/);
  assert.equal(f.calls.some(({ command }) => command === "sign_out"), false);
});
