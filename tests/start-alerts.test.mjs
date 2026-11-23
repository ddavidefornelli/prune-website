import assert from "node:assert/strict";
import { test } from "node:test";
import { ReminderJob } from "../server/reminders/handler.ts";
import { StartAlertJob, StartAlertMessages } from "../server/reminders/start-alerts.ts";

const SITE = "https://www.prune.win/";
const UNSUBSCRIBE = "https://project.supabase.co/functions/v1/email-unsubscribe";
const START = Date.UTC(2026, 10, 24, 13, 0); // 14:00 in Rome
const NOW = START - 5 * 60_000;
const alert = (fields = {}) => ({
  userId: "u1",
  taskId: "00000000-0000-4000-8000-000000000001",
  title: "Call the bank",
  notes: "",
  startAt: START,
  minutes: 30,
  spaceName: null,
  timezone: "Europe/Rome",
  email: "owner@example.test",
  unsubscribeToken: "11111111-1111-4111-8111-111111111111",
  ...fields,
});

function fixture(alerts, { devices = { u1: ["https://push.example/a", "https://push.example/b"] }, mail = "sent", email = true } = {}) {
  const pushes = [];
  const emails = [];
  const recorded = [];
  const job = new StartAlertJob({
    siteUrl: SITE,
    unsubscribeEndpoint: UNSUBSCRIBE,
    now: () => NOW,
    async claim() {
      return alerts;
    },
    push: {
      async targets(userIds) {
        return userIds.flatMap((userId) => (devices[userId] ?? []).map((endpoint) => ({ userId, endpoint, p256dh: "k", auth: "a" })));
      },
      async send(target, payload) {
        pushes.push({ endpoint: target.endpoint, ...payload });
        return "sent";
      },
      async record(endpoint, result) {
        recorded.push([endpoint, result]);
      },
    },
    send: email
      ? async (message) => {
          emails.push(message);
          return typeof mail === "function" ? mail(message) : mail;
        }
      : undefined,
  });
  return { job, pushes, emails, recorded };
}

test("5 minutes before: a notification on each browser and an email, saying when, in the person's time", async () => {
  const { job, pushes, emails, recorded } = fixture([alert({ notes: "Ask about the card.\nForm: https://example.com/f?a=1&b=<2>." })]);
  assert.deepEqual(await job.run(), { alerts: 1, pushed: 2, emailed: 1 });
  assert.deepEqual(pushes[0], {
    endpoint: "https://push.example/a",
    title: "Call the bank",
    body: "In 5 min · 2:00 – 2:30 PM",
    url: SITE,
    tag: "prune-start-00000000-0000-4000-8000-000000000001",
  });
  assert.equal(recorded.length, 2);
  const [email] = emails;
  assert.equal(email.subject, "In 5 min: Call the bank");
  assert.equal(email.to, "owner@example.test");
  assert.equal(email.kind, "starts");
  assert.match(email.oneClickUrl, /kind=starts/);
  assert.match(email.html, /In 5 min · 2:00 – 2:30 PM/);
  // The description keeps its lines, its links open, and nothing in it is markup.
  assert.match(email.html, /Ask about the card\.<br>Form: <a href="https:\/\/example\.com\/f\?a=1&amp;b=" style="color:inherit;">https:\/\/example\.com\/f\?a=1&amp;b=<\/a>&lt;2&gt;\./);
  assert.doesNotMatch(email.html, /<2>/);
  assert.match(email.html, /unsubscribe=11111111-1111-4111-8111-111111111111&amp;kind=starts/);
  assert.match(email.text, /Form: https:\/\/example\.com/);
});

test("a group task says its group; a guest and someone who turned email off get the notification only", async () => {
  const { job, pushes, emails } = fixture(
    [alert({ spaceName: "Trip", title: "Board" }), alert({ userId: "guest", email: null, unsubscribeToken: null })],
    { devices: { u1: ["https://push.example/a"], guest: ["https://push.example/g"] } },
  );
  assert.deepEqual(await job.run(), { alerts: 2, pushed: 2, emailed: 1 });
  assert.equal(pushes.find((p) => p.title === "Board").body, "In 5 min · 2:00 – 2:30 PM · Trip");
  assert.equal(emails.length, 1);
});

test("without email configured, notifications still go; a provider that refuses everything stops the emails", async () => {
  const noMail = fixture([alert()], { email: false });
  assert.deepEqual(await noMail.job.run(), { alerts: 1, pushed: 2, emailed: 0 });
  const halted = fixture([alert(), alert({ userId: "u2", email: "b@example.test" })], { mail: "halt", devices: {} });
  halted.job.deps.concurrency = 1;
  const counts = await new StartAlertJob({ ...halted.job.deps, concurrency: 1 }).run();
  assert.deepEqual(counts, { alerts: 2, pushed: 0, emailed: 0 });
  assert.equal(halted.emails.length, 1);
});

test("the time follows the person's zone, and an unknown zone falls back to UTC", () => {
  assert.equal(StartAlertMessages.hours(alert({ timezone: "America/New_York" })), "8:00 – 8:30 AM");
  assert.equal(StartAlertMessages.hours(alert({ timezone: "Not/AZone" })), "1:00 – 1:30 PM");
  assert.equal(StartAlertMessages.soon(START, START - 60_000), "In 1 min");
  assert.equal(StartAlertMessages.soon(START, START), "Now");
});

test("the reminders function runs only the alerts when the scheduler asks for them", async () => {
  const calls = [];
  const job = new ReminderJob({
    secret: "s3cret",
    siteUrl: SITE,
    unsubscribeEndpoint: UNSUBSCRIBE,
    async claim() {
      calls.push("comeback");
      return [];
    },
    async release() {},
    async send() {
      return "sent";
    },
    daily: { async run() { calls.push("daily"); return 0; } },
    starts: { async run() { calls.push("starts"); return { alerts: 3, pushed: 2, emailed: 1 }; } },
  });
  const post = (body) => job.handle(new Request("https://x.test/", { method: "POST", headers: { Authorization: "Bearer s3cret" }, body }));
  const response = await post(JSON.stringify({ job: "starts" }));
  assert.deepEqual(await response.json(), { alerts: 3, pushed: 2, emailed: 1 });
  assert.deepEqual(calls, ["starts"]);
  await post("{}");
  assert.deepEqual(calls, ["starts", "daily", "comeback"]);
});
