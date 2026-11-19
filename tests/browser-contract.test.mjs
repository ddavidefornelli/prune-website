import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudError } from "../src/planner/cloud-error.ts";
import { PublicConfig } from "../src/planner/config.ts";
import { PrivacyNotice } from "../src/planner/privacy-state.ts";
import { LocalQueue } from "../src/planner/local-queue.ts";

const publicConfig = (url, key) => {
  const { url: origin, publicKey } = PublicConfig.parse(url, key);
  return { url: origin, publicKey };
};
const httpError = CloudError.fromResponse;
import { persistence, dashboard } from "./helpers/queue.mjs";

const key = "sb_publishable_fixture";
test("accepts public configuration and normalizes the project identity", () => {
  assert.deepEqual(publicConfig("https://project.supabase.co/", key), { url: "https://project.supabase.co", publicKey: key });
  assert.equal(publicConfig("http://127.0.0.1:54321", key).url, "http://127.0.0.1:54321");
  const legacy = `header.${btoa(JSON.stringify({ role: "anon" }))}.signature`;
  assert.equal(publicConfig("https://project.supabase.co", legacy).publicKey, legacy);
});
for (const [url, secret] of [
  [undefined, undefined], ["https://project.supabase.co", undefined], ["http://project.supabase.co", key],
  ["https://user:password@project.supabase.co", key], ["https://project.supabase.co/rest", key],
  ["https://project.supabase.co?key=secret", key], ["https://project.supabase.co", "sb_secret_private"],
  ["https://project.supabase.co", `h.${btoa(JSON.stringify({ role: "service_role" }))}.s`],
]) test(`rejects unsafe or missing public config: ${url}`, () => assert.throws(() => publicConfig(url, secret)));

for (const code of ["PT400", "PT404", "PT409"]) test(`only definite application rejection ${code} blocks the queue`, () => {
  const error = httpError(409, { code, message: "Another device changed your plan." });
  assert.equal(error.code, "validation");
  assert.match(error.message, /Another device/);
});
for (const status of [400, 404, 409, 500, 502, 503]) test(`ambiguous HTTP ${status} never authorizes discarding an outbox`, () => {
  const error = httpError(status, { code: "XX000", message: "sensitive database details" });
  assert.equal(error.code, "server");
  assert.ok(!error.message.includes("sensitive"));
});
test("auth expiry and AI cooldowns remain distinct from planner validation", () => {
  assert.equal(httpError(401, {}).code, "unauthorized");
  assert.equal(httpError(400, { code: "PT401", message: "Sign in" }).code, "unauthorized");
  assert.equal(httpError(429, {}).code, "rate_limited");
  const error = httpError(429, { error: { code: "rate_limited", message: "raw provider text" } }, true);
  assert.equal(error.code, "rate_limited");
  assert.match(error.message, /retry allowance/);
  assert.ok(!error.message.includes("raw provider"));
});

test("notice acknowledgement is versioned, initially absent, and storage failure cannot be ignored", () => {
  const { storage, values } = persistence();
  const notice = new PrivacyNotice(storage);
  assert.equal(notice.isAcknowledged(), false);
  notice.acknowledge();
  assert.equal(notice.isAcknowledged(), true);
  assert.ok([...values.values()].every((raw) => !raw.includes("email") && !raw.includes("enabled")));
  const denied = new PrivacyNotice({ getItem: () => null, setItem() { throw new Error("Storage denied"); } });
  assert.throws(() => denied.acknowledge(), /Storage denied/);
  assert.throws(() => denied.require(), /Could not save your terms acceptance/);
});

test("cross-tab storage refresh reads without writing or starting an empty sync loop", async () => {
  const { storage, lock } = persistence();
  storage.setItem("alice", JSON.stringify({ version: 1, base: dashboard(), savedAt: Date.now() / 1000, pending: [], blocked: null }));
  let writes = 0, calls = 0, changes = 0;
  const save = storage.setItem;
  storage.setItem = (...args) => { writes++; save(...args); };
  const queue = new LocalQueue({
    key: "alice",
    storage,
    lock,
    send: async () => { calls++; throw new Error("Unexpected send"); },
    fetchDashboard: async () => { calls++; return dashboard(); },
  });
  queue.onChange = () => { changes++; };
  await queue.refreshFromStorage();
  await queue.refreshFromStorage();
  assert.equal(writes, 0);
  assert.equal(calls, 0);
  assert.equal(changes, 2);
  await queue.stop();
});
