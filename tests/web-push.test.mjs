import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base64url,
  encryptPayload,
  fromBase64url,
  sendPush,
  vapidAuthorization,
} from "../server/reminders/web-push.ts";
import { buildReminderEmail, buildReminderPush } from "../server/reminders/email.ts";
import { createReminderHandler, createUnsubscribeHandler } from "../server/reminders/handler.ts";

const SITE = "https://www.prune.win/";
const subtle = crypto.subtle;

async function browserKeys() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, target: { endpoint: "https://push.example.test/send/1", p256dh: base64url(p256dh), auth: base64url(auth) } };
}

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** The browser's side of RFC 8291, written independently of the sender. */
async function decrypt(body, pair, target) {
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const senderPublic = body.slice(21, 21 + idLength);
  const cipher = body.slice(21 + idLength);
  const senderKey = await subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: senderKey }, pair.privateKey, 256));
  const te = new TextEncoder();
  const receiverPublic = fromBase64url(target.p256dh);
  const info = new Uint8Array([...te.encode("WebPush: info\0"), ...receiverPublic, ...senderPublic]);
  const ikm = await hkdf(fromBase64url(target.auth), shared, info, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain.at(-1), 2, "last-record delimiter");
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function vapidKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, keys: { publicKey: base64url(raw), privateKey: jwk.d, subject: "mailto:ops@example.test" } };
}

test("push payloads decrypt in the browser and nowhere else", async () => {
  const { pair, target } = await browserKeys();
  const body = await encryptPayload(new TextEncoder().encode('{"title":"Write report"}'), target);
  assert.equal(await decrypt(body, pair, target), '{"title":"Write report"}');
  assert.ok(!new TextDecoder().decode(body).includes("Write report"));
  const stranger = await browserKeys();
  await assert.rejects(decrypt(body, stranger.pair, { ...target, p256dh: stranger.target.p256dh }));
  await assert.rejects(encryptPayload(new Uint8Array(1), { p256dh: "AAAA", auth: target.auth }), /Invalid push/);
});

test("the VAPID header is a valid ES256 token for the push service's origin", async () => {
  const { pair, keys } = await vapidKeys();
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, 1_800_000_000);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  assert.equal(match[4], keys.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(match[2])));
  assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "mailto:ops@example.test" });
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, fromBase64url(match[3]),
    new TextEncoder().encode(`${match[1]}.${match[2]}`));
  assert.ok(valid);
});

test("push delivery is classified: sent, gone (forget it) or failed", async () => {
  const { keys } = await vapidKeys();
  const { target } = await browserKeys();
  const payload = { title: "t", body: "b", url: SITE, tag: "prune-session" };
  const requests = [];
  const reply = (status) => async (url, init) => { requests.push({ url, init }); return new Response(null, { status }); };
  assert.equal(await sendPush(target, payload, keys, reply(201)), "sent");
  assert.equal(requests[0].init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(requests[0].init.headers.TTL, "3600");
  assert.equal(requests[0].init.headers.Topic, "prune-session");
  assert.equal(await sendPush(target, payload, keys, reply(410)), "gone");
  assert.equal(await sendPush(target, payload, keys, reply(404)), "gone");
  assert.equal(await sendPush(target, payload, keys, reply(429)), "failed");
  assert.equal(await sendPush(target, payload, keys, async () => { throw new Error("down"); }), "failed");
  assert.equal(await sendPush({ ...target, endpoint: "http://insecure.test/x" }, payload, keys, reply(201)), "gone");
});

const reminder = (kind, tasks = []) => ({ userId: "u1", email: "a@example.test", kind, tasks, unsubscribeToken: "11111111-1111-4111-8111-111111111111" });

test("the focus-time notification starts the timer, or asks for the one thing", () => {
  assert.deepEqual(buildReminderPush(reminder("daily", ["A", "B"]), SITE), {
    title: "Time to focus", body: "A · B", url: "https://www.prune.win/?start=next", tag: "prune-focus",
  });
  assert.equal(buildReminderPush(reminder("daily"), SITE).title, "What’s the one thing today?");
  assert.equal(buildReminderPush(reminder("daily"), SITE).url, SITE);
  assert.equal(buildReminderPush(reminder("comeback"), SITE).tag, "prune-comeback");
});

test("reminders from the earlier claim function still render as focus-time reminders", () => {
  const session = buildReminderEmail(reminder("session", ["Write report"]), SITE);
  assert.equal(session.subject, "Time to focus: Write report");
  assert.ok(session.html.includes("kind=daily"));
  const activation = buildReminderEmail(reminder("activation"), SITE);
  assert.equal(activation.subject, "What’s the one thing today?");
  assert.ok(activation.html.includes("kind=comeback"));
});

test("the job pushes to every device after the email settles, never for a released claim", async () => {
  const pushes = [];
  const recorded = [];
  const handler = createReminderHandler({
    secret: "s3cret",
    siteUrl: SITE,
    unsubscribeEndpoint: "https://api.example.test/functions/v1/email-unsubscribe",
    claim: async () => [
      { ...reminder("session", ["Write report"]), userId: "u1" },
      { ...reminder("daily", ["Later"]), userId: "u2", email: "b@example.test" },
    ],
    release: async () => {},
    send: async (email) => (email.to === "b@example.test" ? "retry" : "sent"),
    push: {
      targets: async (ids) => {
        assert.deepEqual(ids, ["u1", "u2"]);
        return [
          { userId: "u1", endpoint: "https://push.example.test/a", p256dh: "x", auth: "y" },
          { userId: "u1", endpoint: "https://push.example.test/b", p256dh: "x", auth: "y" },
          { userId: "u2", endpoint: "https://push.example.test/c", p256dh: "x", auth: "y" },
        ];
      },
      send: async (target, payload) => {
        pushes.push([target.endpoint, payload.title, payload.body]);
        return target.endpoint.endsWith("/b") ? "gone" : "sent";
      },
      record: async (endpoint, result) => { recorded.push([endpoint, result]); },
    },
  });
  const response = await handler(new Request("https://fn.example.test/", { method: "POST", headers: { Authorization: "Bearer s3cret" } }));
  assert.deepEqual(await response.json(), { sent: 1, retry: 1, rejected: 0, released: 1, pushed: 1 });
  assert.deepEqual(pushes.sort(), [
    ["https://push.example.test/a", "Time to focus", "Write report"],
    ["https://push.example.test/b", "Time to focus", "Write report"],
  ]);
  assert.deepEqual(recorded.sort(), [["https://push.example.test/a", "sent"], ["https://push.example.test/b", "gone"]]);
});

test("unsubscribe links accept the session switch", async () => {
  const calls = [];
  const handler = createUnsubscribeHandler({ allowedOrigins: new Set(), unsubscribe: async (token, kind) => { calls.push(kind); } });
  const url = (kind) => `https://fn.example.test/?token=11111111-1111-4111-8111-111111111111&kind=${kind}`;
  assert.equal((await handler(new Request(url("session"), { method: "POST" }))).status, 204);
  assert.equal((await handler(new Request(url("activation"), { method: "POST" }))).status, 400);
  assert.deepEqual(calls, ["session"]);
});
