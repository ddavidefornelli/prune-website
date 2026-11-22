import assert from "node:assert/strict";
import { test } from "node:test";
import { BrevoMailer } from "../server/reminders/brevo.ts";
import { ReminderMessages } from "../server/reminders/email.ts";
import { AllowedOrigins, ReminderJob, UnsubscribeEndpoint } from "../server/reminders/handler.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const SITE = "https://www.prune.win/";
const reminder = (overrides = {}) => ({ userId: owner, email: "owner@example.test", kind: "comeback", unsubscribeToken: token, ...overrides });
const buildEmail = (value = reminder()) => new ReminderMessages(SITE).email(value);

test("the come-back email is one line, a button to open prune and a way to stop it", () => {
  const email = buildEmail();
  assert.equal(email.subject, "Your list is waiting");
  assert.match(email.html, /<a href="https:\/\/www\.prune\.win\/"[^>]*>Open prune<\/a>/);
  assert.ok(email.html.includes(`https://www.prune.win/?unsubscribe=${token}&amp;kind=comeback`));
  assert.ok(!/timer|focus|today's|plan/i.test(email.text), "nothing about the retired day planner");
  assert.equal(email.text, `Your list is waiting\n\nOpen prune to add a task or tick one off.\n\nOpen prune: ${SITE}\n\nStop these emails: ${SITE}?unsubscribe=${token}&kind=comeback\n`);
  assert.equal(ReminderMessages.oneClickUrl("https://project.supabase.co/functions/v1/email-unsubscribe", reminder()), `https://project.supabase.co/functions/v1/email-unsubscribe?token=${token}&kind=comeback`);
});

function job(overrides = {}) {
  const sent = [];
  const released = [];
  const handler = new ReminderJob({
    secret: "s3cret-value",
    siteUrl: SITE,
    unsubscribeEndpoint: "https://project.supabase.co/functions/v1/email-unsubscribe",
    claim: async () => [reminder(), reminder({ userId: "other", email: "other@example.test" })],
    release: async (userId, kind) => { released.push([userId, kind]); },
    send: async (email) => { sent.push(email); return "sent"; },
    ...overrides,
  }).handle;
  const run = (secret = "s3cret-value", method = "POST") =>
    handler(new Request("https://project.supabase.co/functions/v1/daily-reminders", { method, headers: secret ? { Authorization: `Bearer ${secret}` } : {} }));
  return { run, sent, released };
}

test("the job needs its secret, sends every claim and reports counts only", async () => {
  let claims = 0;
  const guarded = job({ claim: async () => { claims += 1; return []; } });
  assert.equal((await guarded.run("wrong")).status, 401);
  assert.equal((await guarded.run("")).status, 401);
  assert.equal((await guarded.run("s3cret-value", "GET")).status, 405);
  assert.equal(claims, 0);
  assert.equal((await job({ secret: "" }).run("")).status, 401, "an unset secret never authorizes");

  const { run, sent, released } = job();
  const response = await run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: 2, retry: 0, rejected: 0, released: 0, pushed: 0 });
  assert.deepEqual(sent.map((email) => [email.to, email.kind]).sort(), [["other@example.test", "comeback"], ["owner@example.test", "comeback"]]);
  assert.equal(sent.find((email) => email.to === "owner@example.test").oneClickUrl, `https://project.supabase.co/functions/v1/email-unsubscribe?token=${token}&kind=comeback`);
  assert.deepEqual(released, []);
});

test("only retryable failures release their claim", async () => {
  const { run, released } = job({ send: async (email) => { if (email.to === "owner@example.test") throw new Error("network"); return "rejected"; } });
  assert.deepEqual(await (await run()).json(), { sent: 0, retry: 1, rejected: 1, released: 1, pushed: 0 });
  assert.deepEqual(released, [[owner, "comeback"]]);
  assert.equal((await job({ claim: async () => { throw new Error("db"); } }).run()).status, 500);
});

test("an account-level refusal stops the run and releases every unsent claim", async () => {
  const many = Array.from({ length: 6 }, (_, index) => reminder({ userId: `user-${index}`, email: `u${index}@example.test` }));
  let attempts = 0;
  const { run, released } = job({ concurrency: 1, claim: async () => many, send: async () => { attempts += 1; return attempts === 1 ? "sent" : "halt"; } });
  const response = await run();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider_refused", sent: 1, retry: 0, rejected: 0, released: 5, pushed: 0 });
  assert.equal(attempts, 2, "no further sends after the refusal");
  assert.deepEqual(released.map(([userId]) => userId).sort(), ["user-1", "user-2", "user-3", "user-4", "user-5"]);
  // With parallel workers, every claim is still either sent or released.
  const parallel = job({ claim: async () => many, send: async () => "halt" });
  assert.equal((await parallel.run()).status, 502);
  assert.equal(parallel.released.length, 6);
});

test("Brevo gets the sender, content and one-click headers; failures are classified", async () => {
  const calls = [];
  const fetcher = (status) => async (url, init) => { calls.push({ url, init }); return new Response("{}", { status }); };
  const email = { ...buildEmail(), to: "owner@example.test", kind: "comeback", oneClickUrl: "https://project.supabase.co/functions/v1/email-unsubscribe?token=t&kind=comeback" };
  const send = (options) => new BrevoMailer({ apiKey: "test-key", fromEmail: "hello@prune.win", ...options }).send(email);
  assert.equal(await send({ fetcher: fetcher(201) }), "sent");
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].init.headers["api-key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.sender, { name: "prune", email: "hello@prune.win" });
  assert.deepEqual(body.to, [{ email: "owner@example.test" }]);
  assert.deepEqual(body.tags, ["reminder-comeback"]);
  assert.equal(body.headers["List-Unsubscribe"], `<${email.oneClickUrl}>`);
  assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(await send({ fetcher: fetcher(429) }), "retry");
  assert.equal(await send({ fetcher: fetcher(503) }), "retry");
  assert.equal(await send({ fetcher: fetcher(400) }), "rejected");
  for (const status of [401, 402, 403]) assert.equal(await send({ fetcher: fetcher(status) }), "halt");
  assert.equal(await send({ fetcher: async () => { throw new Error("offline"); } }), "retry");
});

test("unsubscribe accepts POST with a valid token only, from mail providers or the website", async () => {
  const seen = [];
  const handler = new UnsubscribeEndpoint({ allowedOrigins: new Set(["https://www.prune.win"]), unsubscribe: async (value, kind) => { seen.push([value, kind]); } }).handle;
  const url = (value, kind) => `https://project.supabase.co/functions/v1/email-unsubscribe?token=${value}&kind=${kind}`;
  const post = (target, headers = {}, method = "POST") => handler(new Request(target, { method, headers }));
  assert.equal((await post(url(owner, "comeback"), {}, "GET")).status, 405, "opening the link changes nothing");
  assert.equal((await post(url("nope", "comeback"))).status, 400);
  assert.equal((await post(url(owner, "all"))).status, 400);
  assert.equal((await post(url(owner, "activation"))).status, 400);
  assert.equal((await post(url(owner, "comeback"), { Origin: "https://evil.example" })).status, 403);
  assert.deepEqual(seen, []);
  assert.equal((await post(url(owner, "comeback"))).status, 204);
  const fromSite = await post(url(owner, "comeback"), { Origin: "https://www.prune.win" });
  assert.equal(fromSite.status, 204);
  assert.equal(fromSite.headers.get("Access-Control-Allow-Origin"), "https://www.prune.win");
  // Links in the day planner's emails still answer.
  for (const kind of ["daily", "session"]) assert.equal((await post(url(owner, kind))).status, 204, kind);
  assert.deepEqual(seen, [[owner, "comeback"], [owner, "comeback"], [owner, "daily"], [owner, "session"]]);
});

test("allowed origins default to the production site, and extra origins add to the list", () => {
  assert.deepEqual([...AllowedOrigins.fromEnvironment(undefined, undefined)], ["https://www.prune.win"]);
  assert.deepEqual([...AllowedOrigins.fromEnvironment("https://a.test, https://b.test", " https://c.test ")], ["https://a.test", "https://b.test", "https://c.test"]);
});
