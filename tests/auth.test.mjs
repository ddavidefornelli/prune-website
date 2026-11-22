import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseAuth } from "../src/cloud/auth.ts";
import { PublicConfig } from "../src/cloud/config.ts";

const PROJECT = "https://auth-fixture.supabase.co";
const KEY = `prune:auth:${PROJECT}`;
const now = () => Math.floor(Date.now() / 1000);
const user = (id = "guest-1", extra = {}) => ({ id, is_anonymous: true, email: "", ...extra });
const session = (expiresIn = 3600, id = "guest-1", refresh = `refresh-${id}`) => ({
  access_token: `access-${id}-${expiresIn}`,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: expiresIn,
  expires_at: now() + expiresIn,
  user: user(id),
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixture({ key = "sb_publishable_fixture", saved = null, reply = () => json({}) } = {}) {
  const values = new Map(saved ? [[KEY, JSON.stringify(saved)]] : []);
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  };
  const requests = [];
  const http = {
    async request(url, init) {
      const parsed = new URL(url);
      const entry = { path: parsed.pathname + parsed.search, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
      requests.push(entry);
      return reply(entry);
    },
  };
  const auth = new SupabaseAuth(PublicConfig.parse(PROJECT, key), storage, http);
  return { auth, requests, values, stored: () => JSON.parse(values.get(KEY) ?? "null") };
}

test("a fresh saved session is used as it is, with no request", async () => {
  const saved = session();
  const f = fixture({ saved });
  assert.deepEqual(await f.auth.session(), saved);
  assert.deepEqual(f.requests, []);
});

test("sessions saved by supabase-js keep working, and malformed ones are ignored", () => {
  const legacy = { ...session(), provider_token: null, weak_password: null };
  assert.deepEqual(SupabaseAuth.parse(legacy), legacy);
  const { expires_at: _, ...withoutExpiry } = session(600);
  assert.ok(Math.abs(SupabaseAuth.parse(withoutExpiry).expires_at - (now() + 600)) <= 1);
  for (const broken of [null, "x", { ...session(), access_token: "" }, { ...session(), user: {} }, { ...session(), expires_at: "soon", expires_in: undefined }])
    assert.equal(SupabaseAuth.parse(broken), null);
  const f = fixture();
  f.values.set(KEY, "{not json");
  assert.equal(f.auth.saved(), null);
});

test("a session about to expire is refreshed once, even when asked for twice at the same time", async () => {
  const next = session(3600, "guest-1", "refresh-2");
  const f = fixture({ saved: session(30), reply: () => json(next) });
  const [a, b] = await Promise.all([f.auth.session(), f.auth.session()]);
  assert.deepEqual(a, next);
  assert.deepEqual(b, next);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/auth/v1/token?grant_type=refresh_token");
  assert.deepEqual(f.requests[0].body, { refresh_token: "refresh-guest-1" });
  assert.deepEqual(f.stored(), next);
});

test("a refresh the server refuses ends the session; an outage keeps it for later", async () => {
  for (const status of [400, 401, 403]) {
    const f = fixture({ saved: session(10), reply: () => json({ error_code: "refresh_token_not_found" }, status) });
    assert.equal(await f.auth.session(), null);
    assert.equal(f.stored(), null);
  }
  for (const [status, code] of [[429, "rate_limited"], [500, "server"], [503, "server"]]) {
    const saved = session(10);
    const f = fixture({ saved, reply: () => json({}, status) });
    await assert.rejects(f.auth.session(), (error) => error.code === code);
    assert.deepEqual(f.stored(), saved);
  }
  const offline = fixture({ saved: session(10), reply: () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.auth.session(), (error) => error.code === "network");
  assert.ok(offline.stored());
});

test("a token the server refuses although it looks fresh is renewed, unless another tab already did", async () => {
  const next = session(3600, "guest-1", "refresh-2");
  const f = fixture({ saved: session(), reply: () => json(next) });
  assert.deepEqual(await f.auth.renew(session()), next);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, { refresh_token: "refresh-guest-1" });
  assert.deepEqual(f.stored(), next);
  // The stale copy's token was already replaced: the newer session, with no request.
  assert.deepEqual(await f.auth.renew(session()), next);
  assert.equal(f.requests.length, 1);
  const over = fixture({ saved: session(), reply: () => json({ error_code: "refresh_token_not_found" }, 400) });
  assert.equal(await over.auth.renew(session()), null);
  assert.equal(over.stored(), null);
});

test("the server's check of a session tells a removed user from an outage", async () => {
  const saved = session();
  const known = fixture({ saved, reply: () => json(user("guest-1", { email: "" })) });
  assert.equal((await known.auth.user(saved)).id, "guest-1");
  assert.equal(known.requests[0].headers.Authorization, `Bearer ${saved.access_token}`);
  for (const status of [401, 403]) assert.equal(await fixture({ reply: () => json({}, status) }).auth.user(saved), null);
  await assert.rejects(fixture({ reply: () => json({}, 502) }).auth.user(saved), (error) => error.code === "server");
  await assert.rejects(fixture({ reply: () => json({ id: "" }) }).auth.user(saved), (error) => error.code === "server");
});

test("a new guest is an anonymous sign-up, saved as this browser's session", async () => {
  const created = session(3600, "guest-new");
  const f = fixture({ reply: () => json(created) });
  assert.deepEqual(await f.auth.signUpGuest(), created);
  assert.deepEqual(f.requests.map(({ method, path, body }) => [method, path, body]), [["POST", "/auth/v1/signup", { data: {} }]]);
  assert.deepEqual(f.stored(), created);
  await assert.rejects(fixture({ reply: () => json({ error_code: "anonymous_provider_disabled" }, 422) }).auth.signUpGuest(), (error) => error.code === "auth");
  await assert.rejects(fixture({ reply: () => json({ msg: "ok" }) }).auth.signUpGuest(), (error) => error.code === "auth");
  await assert.rejects(fixture({ reply: () => json({}, 429) }).auth.signUpGuest(), (error) => error.code === "rate_limited");
});

test("a publishable key goes in apikey only; a legacy anon key is also the bearer", async () => {
  const publishable = fixture({ reply: () => json(session()) });
  await publishable.auth.signUpGuest();
  assert.deepEqual(publishable.requests[0].headers, { apikey: "sb_publishable_fixture", "Content-Type": "application/json" });
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const legacy = `${part({ alg: "HS256" })}.${part({ role: "anon" })}.signature`;
  const old = fixture({ key: legacy, reply: () => json(session()) });
  await old.auth.signUpGuest();
  assert.equal(old.requests[0].headers.Authorization, `Bearer ${legacy}`);
  assert.equal(old.requests[0].headers.apikey, legacy);
});

test("signing out tells the server, then forgets the session even when the server is unreachable", async () => {
  const saved = session();
  const f = fixture({ saved, reply: () => new Response(null, { status: 204 }) });
  f.values.set(`${KEY}-code-verifier`, "left over from Google sign-in");
  await f.auth.signOut();
  assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [["POST", "/auth/v1/logout?scope=local"]]);
  assert.equal(f.requests[0].headers.Authorization, `Bearer ${saved.access_token}`);
  assert.equal(f.values.size, 0);
  const offline = fixture({ saved, reply: () => { throw new TypeError("Failed to fetch"); } });
  await offline.auth.signOut();
  assert.equal(offline.stored(), null);
});
