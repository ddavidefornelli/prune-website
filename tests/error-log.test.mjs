import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { browserFamily, deviceType, handleErrorLog } from "../server/error-log.ts";

const SITE = "https://www.prune.win";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0";

async function database() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(readFileSync(new URL("../supabase/migrations/20261112000100_error_log.sql", import.meta.url), "utf8"));
  return db;
}
const log = (db, ...args) => db.query("select public.log_client_error($1, $2, $3, $4, $5, $6)", args);

test("error_log stores valid reports and rejects unknown events or values", async () => {
  const db = await database();
  await log(db, "signin_network", "send_code", "timeout", "IN", "chrome", "mobile");
  await log(db, "signin_network", "google", "failed", "", "safari", "desktop");
  const { rows } = await db.query("select event, context, detail, country, browser, device from public.error_log order by id");
  assert.deepEqual(rows, [
    { event: "signin_network", context: "send_code", detail: "timeout", country: "IN", browser: "chrome", device: "mobile" },
    { event: "signin_network", context: "google", detail: "failed", country: null, browser: "safari", device: "desktop" },
  ]);
  await assert.rejects(() => log(db, "made_up", "send_code", "failed", "", "chrome", "mobile"), /Invalid error report/);
  await assert.rejects(() => log(db, "signin_network", "Send Code", "failed", "", "chrome", "mobile"), /Invalid error report/);
  await assert.rejects(() => log(db, "signin_network", "send_code", "failed", "", "netscape", "mobile"), /Invalid error report/);
});

test("error_log prunes rows older than 90 days and caps daily writes", async () => {
  const db = await database();
  await db.exec("insert into public.error_log (created_at, event, context, detail, browser, device) overriding system value values (now() - interval '91 days', 'signin_network', 'old', 'failed', 'other', 'desktop')");
  await log(db, "signin_network", "send_code", "failed", "", "chrome", "mobile");
  assert.deepEqual((await db.query("select context from public.error_log")).rows, [{ context: "send_code" }]);
  await db.exec("insert into public.error_log (event, context, detail, browser, device) select 'signin_network', 'bulk', 'failed', 'other', 'desktop' from generate_series(1, 4999)");
  await log(db, "signin_network", "send_code", "failed", "", "chrome", "mobile");
  assert.equal((await db.query("select count(*)::int as n from public.error_log")).rows[0].n, 5000);
});

test("browser family and device are coarse", () => {
  assert.equal(browserFamily(UA_IPHONE), "safari");
  assert.equal(deviceType(UA_IPHONE), "mobile");
  assert.equal(browserFamily(UA_EDGE), "edge");
  assert.equal(deviceType(UA_EDGE), "desktop");
  assert.equal(browserFamily(""), "other");
});

function request(body, headers = {}) {
  return new Request(`${SITE}/api/error-log`, {
    method: "POST",
    headers: { Origin: SITE, "User-Agent": UA_IPHONE, "x-vercel-ip-country": "IT", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("relay forwards only names plus country and browser family", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };
  const config = { url: "https://project.supabase.co", publicKey: "sb_publishable_abc", fetcher };
  const response = await handleErrorLog(request({ event: "signin_network", context: "send_code", detail: "timeout", email: "x@y.z" }), config);
  assert.equal(response.status, 204);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/rest/v1/rpc/log_client_error");
  assert.equal(calls[0].init.headers.apikey, "sb_publishable_abc");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_event: "signin_network", p_context: "send_code", p_detail: "timeout",
    p_country: "IT", p_browser: "safari", p_device: "mobile",
  });
});

test("relay rejects other origins, methods and malformed bodies without forwarding", async () => {
  let forwarded = 0;
  const config = { url: "https://project.supabase.co", publicKey: "sb_publishable_abc", fetcher: async () => { forwarded++; return new Response(null, { status: 204 }); } };
  const valid = { event: "signin_network", context: "send_code", detail: "failed" };
  assert.equal((await handleErrorLog(request(valid, { Origin: "https://evil.example" }), config)).status, 403);
  assert.equal((await handleErrorLog(new Request(`${SITE}/api/error-log`, { headers: { Origin: SITE } }), config)).status, 405);
  assert.equal((await handleErrorLog(request("not json"), config)).status, 400);
  assert.equal((await handleErrorLog(request({ ...valid, context: "Send Code" }), config)).status, 400);
  assert.equal((await handleErrorLog(request({ ...valid, detail: "x".repeat(600) }), config)).status, 413);
  assert.equal(forwarded, 0);
});
