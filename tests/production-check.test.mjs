import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fetchLimited, parsePolicy, runProductionChecks, summarize, websiteOrigin } from "../scripts/check-production.mjs";
import { hardenHtml } from "../scripts/security-policy.ts";

const site = "https://www.prune.test";
const api = "https://backend-fixture.supabase.co";
const config = { url: api, publicKey: "sb_publishable_fixture" };
const script = "console.log('Google Ads and GoatCounter are not loaded');";
const built = hardenHtml('<html><head><script type="module" src="/assets/app.js"></script></head><body></body></html>', new Map([["assets/app.js", script]]), api);
const documentHeaders = { ...built.headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function fixture({ signupDisabled = true, override } = {}) {
  const requests = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    const replacement = await override?.(url, init);
    if (replacement) return replacement;
    if (url.origin === site) {
      if (["/", "/download", "/download/", "/login", "/login/", "/index.html"].includes(url.pathname)) return new Response(built.html, { headers: documentHeaders });
      if (url.pathname === "/assets/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    }
    if (url.origin === api) {
      if (url.pathname === "/auth/v1/settings") return json({ external: { email: true, anonymous_users: false }, mailer_autoconfirm: false, disable_signup: signupDisabled });
      if (url.pathname.startsWith("/rest/v1/")) return json({ code: "42501" }, 401);
      if (url.pathname === "/functions/v1/weekly-review") {
        if (init.method !== "OPTIONS") return json({ error: { code: "unauthorized" } }, 401);
        return init.headers.Origin === site ? new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": site } }) : json({ error: { code: "origin_not_allowed" } }, 403);
      }
    }
    throw new Error("Unexpected fixture route");
  };
  const run = (options = {}) => runProductionChecks({ site, config, fetcher, timeoutMs: 1000, ...options });
  return { requests, fetcher, run };
}
const result = (report, id) => report.results.find((item) => item.id === id);

test("checker accepts a correctly deployed artifact and makes only non-destructive public requests", async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.exitCode, 0);
  assert.equal(report.counts.ERROR, 0);
  assert.equal(report.counts.FAIL, 0);
  assert.equal(f.requests.filter(({ url }) => url.pathname === "/assets/app.js").length, 1, "shared bundle is downloaded once");
  assert.equal(f.requests.filter(({ url }) => url.pathname.startsWith("/rest/v1/") && !url.pathname.includes("/rpc/")).length, 10);
  for (const { url, init } of f.requests) {
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.ok(!new Headers(init.headers).has("authorization"));
    if (url.origin === site) assert.ok(!new Headers(init.headers).has("apikey"));
    if (url.pathname.startsWith("/rest/v1/") && !url.pathname.includes("/rpc/")) assert.equal(url.searchParams.get("limit"), "0");
    if (init.method === "POST") {
      assert.ok(["/rest/v1/rpc/planner_call", "/functions/v1/weekly-review"].includes(url.pathname));
      const body = JSON.parse(init.body);
      assert.ok(body.p_action === "dashboard" || Object.keys(body).join() === "timezone");
    }
  }
  assert.ok(!JSON.stringify(report).includes(config.publicKey));
});

test("CSP comparison accepts equivalent directive ordering, whitespace and HTML quote styles", async () => {
  const policy = built.headers["Content-Security-Policy"].split("; ").reverse().join(" ;  ") + ";";
  // Preserve CSP's quoted tokens inside meta; vary script attribute quotes.
  const g = fixture({ override: (url) => url.origin === site && url.pathname !== "/assets/app.js" ? new Response(built.html.replace(/src="([^"]+)"/g, "src='$1'").replace(/integrity="([^"]+)"/g, "integrity='$1'"), { headers: { ...documentHeaders, "Content-Security-Policy": policy } }) : null });
  assert.equal((await g.run()).exitCode, 0);
});

test("public signup is a warning by default and a failure only when invite-only is required", async () => {
  const f = fixture({ signupDisabled: false });
  const normal = await f.run();
  assert.equal(result(normal, "auth:signup").status, "WARN");
  assert.equal(normal.exitCode, 0);
  const closed = await f.run({ requireInviteOnly: true });
  assert.equal(result(closed, "auth:signup").status, "FAIL");
  assert.equal(closed.exitCode, 1);
});

test("missing HTTP CSP is a real failure; dependent meta checks are skipped, not falsely passed", async () => {
  const headers = { ...documentHeaders };
  delete headers["Content-Security-Policy"];
  const f = fixture({ override: (url) => url.origin === site && url.pathname !== "/assets/app.js" ? new Response(built.html, { headers }) : null });
  const report = await f.run();
  assert.equal(report.exitCode, 1);
  assert.equal(result(report, "site/:csp").status, "FAIL");
  assert.equal(result(report, "site/:meta").status, "SKIP");
  assert.equal(report.counts.ERROR, 0);
});

test("old marketing HTML fails without fetching third-party scripts", async () => {
  const html = '<html><script src="https://www.googletagmanager.com/gtag/js?id=fixture"></script><script>gtag("config", "fixture")</script></html>';
  const f = fixture({ override: (url) => url.origin === site && url.pathname !== "/assets/app.js" ? new Response(html, { headers: { "Content-Type": "text/html" } }) : null });
  const report = await f.run();
  assert.equal(report.exitCode, 1);
  assert.equal(result(report, "site/:trackers").status, "FAIL");
  assert.equal(result(report, "site/:scripts").status, "FAIL");
  assert.ok(f.requests.every(({ url }) => [site, api].includes(url.origin)));
});

test("deployed JavaScript with changed bytes or tracker calls fails integrity/content checks", async () => {
  const f = fixture({ override: (url) => url.pathname === "/assets/app.js" ? new Response('gtag("config", "fixture");', { headers: { "Content-Type": "text/javascript" } }) : null });
  const report = await f.run();
  assert.equal(result(report, "asset:/assets/app.js:integrity").status, "FAIL");
  assert.equal(result(report, "asset:/assets/app.js:trackers").status, "FAIL");
  assert.equal(report.exitCode, 1);
});

test("all public document aliases are checked, not only the root and slashless download", async () => {
  const headers = { ...documentHeaders, "Cache-Control": "public, max-age=86400" };
  const report = await fixture({ override: (url) => url.origin === site && url.pathname === "/download/" ? new Response(built.html, { headers }) : null }).run();
  assert.equal(result(report, "site/:cache").status, "PASS");
  assert.equal(result(report, "site/download:cache").status, "PASS");
  assert.equal(result(report, "site/download/:cache").status, "FAIL");
  assert.equal(result(report, "site/index.html:http").status, "PASS");
});

test("stylesheets require same-origin SRI and unchanged CSS bytes", async () => {
  const css = "body { color: white; }";
  const styled = hardenHtml('<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>', new Map([["assets/app.js", script], ["assets/app.css", css]]), api);
  const make = (body, html = styled.html) => fixture({ override: (url) => {
    if (url.origin !== site) return null;
    if (url.pathname === "/assets/app.css") return new Response(body, { headers: { "Content-Type": "text/css" } });
    if (!url.pathname.startsWith("/assets/")) return new Response(html, { headers: { ...documentHeaders, ...styled.headers } });
    return null;
  } });
  const correct = make(css);
  assert.equal((await correct.run()).exitCode, 0);
  assert.equal(correct.requests.filter(({ url }) => url.pathname === "/assets/app.css").length, 1);
  const changed = await make("body { display: none; }").run();
  assert.equal(result(changed, "asset:/assets/app.css:integrity").status, "FAIL");
  assert.equal(changed.exitCode, 1);
  const missing = await make(css, styled.html.replace(/<link integrity="[^"]+"/, "<link")).run();
  assert.equal(result(missing, "site/:styles").status, "FAIL");
});

test("CSP with internally valid but different script hashes is rejected", async () => {
  const changed = hardenHtml('<html><head><script type="module" src="/assets/other.js"></script></head></html>', new Map([["assets/other.js", "different script"]]), api);
  const f = fixture({ override: (url) => url.origin === site && url.pathname !== "/assets/app.js" ? new Response(built.html, { headers: { ...documentHeaders, ...changed.headers } }) : null });
  const report = await f.run();
  assert.equal(result(report, "site/:script-policy").status, "FAIL");
  assert.equal(report.exitCode, 1);
});

test("canonical HTTPS redirects are followed and AI CORS uses the final origin without leaking API headers", async () => {
  const f = fixture({ override: (url) => url.origin === "https://prune.test" ? new Response(null, { status: 308, headers: { Location: site } }) : null });
  const report = await f.run({ site: "https://prune.test" });
  assert.equal(report.site, site);
  assert.equal(report.exitCode, 0);
  assert.equal(result(report, "site:canonical").status, "WARN");
  assert.equal(result(report, "ai:cors:true").status, "PASS");
  assert.ok(!new Headers(f.requests[0].init.headers).has("apikey"));
});

test("insecure redirects and redirected assets are not followed", async () => {
  await assert.rejects(() => fetchLimited(site, { followRedirects: true, fetcher: async () => new Response(null, { status: 302, headers: { Location: "http://www.prune.test" } }) }), /Refused/);
  const f = fixture({ override: (url) => url.pathname === "/assets/app.js" ? new Response(null, { status: 302, headers: { Location: "https://third-party.invalid/app.js" } }) : null });
  const report = await f.run();
  assert.equal(result(report, "asset:/assets/app.js:integrity").status, "FAIL");
  assert.ok(!f.requests.some(({ url }) => url.hostname === "third-party.invalid"));
});

test("website-only and skip-ai modes visibly report incomplete scope", async () => {
  const f = fixture();
  const website = await f.run({ websiteOnly: true, config: null });
  assert.equal(website.exitCode, 0);
  assert.equal(result(website, "backend:disabled").status, "SKIP");
  assert.ok(f.requests.every(({ url }) => url.origin === site));
  const g = fixture();
  const noAi = await g.run({ skipAi: true });
  assert.equal(result(noAi, "ai:disabled").status, "SKIP");
  assert.ok(!g.requests.some(({ url }) => url.pathname.includes("/functions/")));
});

test("missing backend configuration still checks the website and exits as unverified", async () => {
  const report = await fixture().run({ config: null });
  assert.equal(result(report, "backend:config").status, "ERROR");
  assert.equal(result(report, "site/:http").status, "PASS");
  assert.equal(report.exitCode, 2);
});

test("a rejected public key skips cascaded backend probes and does not log response bodies", async () => {
  const f = fixture({ override: (url) => url.pathname === "/auth/v1/settings" ? json({ message: "private diagnostic sb_secret_do_not_print" }, 401) : null });
  const report = await f.run();
  assert.equal(report.exitCode, 2);
  assert.match(result(report, "auth:request").detail, /HTTP 401/);
  assert.equal(result(report, "auth:dependent").status, "SKIP");
  assert.ok(!JSON.stringify(report).includes("sb_secret_do_not_print"));
  assert.ok(!f.requests.some(({ url }) => url.pathname.startsWith("/rest/")));
});

for (const [status, body] of [[200, []], [404, { code: "PGRST205" }], [401, { code: "PGRST301" }]]) {
  test(`anonymous table response ${status} / ${body.code || "allowed"} is not mistaken for SQL permission denial`, async () => {
    const f = fixture({ override: (url) => url.pathname === "/rest/v1/planner_tasks" ? json(body, status) : null });
    const report = await f.run();
    assert.equal(result(report, "db:planner_tasks").status, "FAIL");
    assert.equal(report.exitCode, 1);
  });
}

test("non-JSON responses and absent settings remain unverified with safe diagnostics", async () => {
  const f = fixture({ override: (url) => url.pathname === "/rest/v1/planner_tasks" ? new Response("secret upstream details", { status: 502 }) : null });
  const report = await f.run();
  assert.equal(report.exitCode, 2);
  assert.match(result(report, "db:planner_tasks:request").detail, /HTTP 502 returned non-JSON/);
  assert.ok(!JSON.stringify(report).includes("secret upstream details"));
  const missing = await fixture({ override: (url) => url.pathname === "/auth/v1/settings" ? json({}) : null }).run();
  assert.equal(result(missing, "auth:anonymous").status, "ERROR");
});

test("network failures report DNS diagnostics rather than a misleading security failure", async () => {
  const f = fixture({ override: (url) => { if (url.origin === site) throw new TypeError("private request data", { cause: { code: "ENOTFOUND" } }); } });
  const report = await f.run();
  assert.match(result(report, "site:request").detail, /DNS lookup failed/);
  assert.equal(report.exitCode, 2);
  assert.ok(!JSON.stringify(report).includes("private request data"));
});

test("request deadlines cover stalled body reads as well as response headers", async () => {
  await assert.rejects(() => fetchLimited(site, { timeoutMs: 20, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })) }), /Timed out after 20ms/);
  await assert.rejects(() => fetchLimited(site, { timeoutMs: 20, fetcher: () => new Promise(() => {}) }), /Timed out/);
  await assert.rejects(() => fetchLimited(site, { maxBytes: 3, fetcher: async () => new Response("oversized") }), /size limit/);
});

test("configuration validation, duplicate CSP directives and exit codes fail safely", () => {
  for (const value of ["http://www.prune.test", "https://user:secret@www.prune.test", `${site}/path`, `${site}?key=private`, "invalid"]) assert.throws(() => websiteOrigin(value));
  assert.throws(() => parsePolicy("script-src 'none'; script-src 'self'"), /duplicate/);
  assert.equal(summarize([{ status: "WARN" }, { status: "SKIP" }]).exitCode, 0);
  assert.equal(summarize([{ status: "FAIL" }]).exitCode, 1);
  assert.equal(summarize([{ status: "FAIL" }, { status: "ERROR" }]).exitCode, 2);
});

test("CLI help works without configuration; malformed options produce a useful error or JSON", () => {
  const command = ["--experimental-strip-types", "scripts/check-production.mjs"];
  const help = spawnSync(process.execPath, [...command, "--help"], { encoding: "utf8", env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--require-invite-only/);
  const invalid = spawnSync(process.execPath, [...command, "--json", "--url", "http://insecure.test"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).exitCode, 2);
});
