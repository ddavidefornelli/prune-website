import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudError } from "../src/cloud/cloud-error.ts";
import { PublicConfig } from "../src/cloud/config.ts";
import { PrivacyNotice } from "../src/cloud/privacy-state.ts";
import { persistence } from "./helpers/fakes.mjs";

const publicConfig = (url, key) => {
  const { url: origin, publicKey } = PublicConfig.parse(url, key);
  return { url: origin, publicKey };
};
const httpError = CloudError.fromResponse;

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

for (const code of ["PT400", "PT409"]) test(`only a definite rejection (${code}) lets the list drop a change`, () => {
  const error = httpError(400, { code, message: "Some changes could not be read." });
  assert.equal(error.code, "validation");
  assert.match(error.message, /could not be read/);
});
test("a space that is gone (PT404) closes it instead of dropping changes", () => {
  const error = httpError(404, { code: "PT404", message: "This space isn't available any more." });
  assert.equal(error.code, "missing");
  assert.match(error.message, /isn't available/);
});
for (const status of [400, 404, 409, 500, 502, 503]) test(`ambiguous HTTP ${status} keeps changes to retry, without leaking details`, () => {
  const error = httpError(status, { code: "XX000", message: "sensitive database details" });
  assert.equal(error.code, "server");
  assert.ok(!error.message.includes("sensitive"));
});
test("expired sessions, deleted accounts and rate limits are told apart from rejections", () => {
  assert.equal(httpError(401, {}).code, "unauthorized");
  assert.equal(httpError(400, { code: "PT401", message: "Sign in" }).code, "unauthorized");
  assert.equal(httpError(403, { code: "PT403", message: "Deleted" }).code, "account_deleted");
  assert.equal(httpError(429, {}).code, "rate_limited");
  assert.equal(httpError(400, { code: "PT400", message: "x".repeat(400) }).code, "server");
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
