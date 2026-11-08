// Non-destructive hosted checks: no admin credentials, emails, row downloads,
// account/planner mutations or paid AI requests. Never print response bodies/keys.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "vite";
import { publicConfig } from "../src/planner/config.ts";
import { ANALYTICS_SCRIPTS, CONTENTSQUARE_SCRIPTS, integrity, securityHeaders } from "./security-policy.ts";
import { hasMarketingTracker } from "./tracking-policy.ts";

const TABLES = ["planner_accounts", "planner_tasks", "planner_resources", "planner_stops", "planner_reviews", "planner_receipts", "ai_controls", "ai_usage", "ai_review_requests", "ai_review_previews"];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HELP = `Usage: npm run check:production -- [options]

  --url https://www.prune.win   Website origin (or PRUNE_SITE_URL)
  --require-invite-only        Fail if public signup is enabled; otherwise warn
  --website-only              Inspect the website without contacting Supabase
  --skip-ai                   Explicitly skip optional AI authentication/CORS
  --timeout-ms 15000           Per-request timeout, including body/redirects
  --json                      Print a machine-readable report
  --help                      Show this help without network/configuration access

Public backend settings come from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
in the environment or Vite's production .env files. No privileged key is needed.
Exit codes: 0 = no failures/errors (warnings/skips may remain),
            1 = confirmed failed checks, 2 = incomplete/configuration/network error.
`;

export function websiteOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Use an HTTPS website origin, e.g. --url https://www.prune.win."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS website origin without credentials, a path, query or fragment.");
  }
  return url.origin;
}

class ProbeError extends Error {
  constructor(message) { super(message); this.name = "ProbeError"; }
}
function networkDiagnostic(error) {
  if (error instanceof ProbeError) return error.message;
  const code = error?.cause?.code ?? error?.code;
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "DNS lookup failed; check the hostname and your connection.";
  if (code === "ECONNREFUSED") return "Connection refused by the server.";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "TLS certificate verification failed; repair the certificate rather than disabling TLS checks.";
  return "Request could not be completed; check network access, TLS and the target service.";
}

/** One deadline bounds fetch, redirect handling AND streamed response bytes. */
export async function fetchLimited(url, { fetcher = fetch, timeoutMs = 15000, maxBytes = 128 * 1024, followRedirects = false, lockedOrigin, ...init } = {}) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    let target = new URL(url);
    let redirected = false;
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetcher(target.href, { ...init, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (followRedirects && REDIRECTS.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) throw new ProbeError("Redirect response has no Location header.");
        const next = new URL(location, target);
        if (next.protocol !== "https:" || next.username || next.password || (lockedOrigin && next.origin !== lockedOrigin)) {
          throw new ProbeError("Refused an insecure, credential-bearing or unexpected cross-origin redirect.");
        }
        target = next;
        redirected = true;
        continue;
      }
      const chunks = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) {
              void reader.cancel().catch(() => {});
              throw new ProbeError("Response exceeded the size limit; content was not logged.");
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { status: response.status, headers: response.headers, url: target.href, redirected, bytes, text: new TextDecoder().decode(bytes) };
    }
    throw new ProbeError("Too many redirects (maximum five); check the site's redirect configuration.");
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProbeError(`Timed out after ${timeoutMs}ms, including response download.`));
        controller.abort();
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function parsePolicy(value) {
  const result = new Map();
  for (const part of value.split(";")) {
    const [name, ...tokens] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (result.has(key)) throw new ProbeError("CSP contains duplicate directives; use one unambiguous generated policy.");
    result.set(key, new Set(tokens));
  }
  return result;
}
function samePolicy(a, b) {
  const left = parsePolicy(a), right = parsePolicy(b);
  return left.size === right.size && [...left].every(([key, values]) => right.has(key) && values.size === right.get(key).size && [...values].every((value) => right.get(key).has(value)));
}
function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = /^&#x/i.test(entity) ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}
function attributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attrs, key)) throw new ProbeError("HTML contains duplicate attributes; asset checks cannot safely interpret it.");
    attrs[key] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}
function jsonBody(response) {
  try { return JSON.parse(response.text); }
  catch { throw new ProbeError(`HTTP ${response.status} returned non-JSON content; check the endpoint, proxy or deployment protection.`); }
}
function codeDetail(response, body) {
  const code = body?.code ?? body?.error?.code;
  return `HTTP ${response.status}${typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? `, code ${code}` : ""}`;
}

export function summarize(results) {
  const counts = Object.fromEntries(["PASS", "WARN", "FAIL", "ERROR", "SKIP"].map((status) => [status, results.filter((item) => item.status === status).length]));
  return { counts, exitCode: counts.ERROR ? 2 : counts.FAIL ? 1 : 0 };
}

export async function runProductionChecks({ site = "https://www.prune.win", config = null, configError = null, requireInviteOnly = false, websiteOnly = false, skipAi = false, timeoutMs = 15000, fetcher = fetch } = {}, onResult = () => {}) {
  const origin = websiteOrigin(site);
  const results = [];
  const add = (status, id, label, detail = "", fix = "") => {
    const result = { status, id, label, detail, ...(fix && ["FAIL", "ERROR", "WARN"].includes(status) ? { fix } : {}) };
    results.push(result); onResult(result);
  };
  const check = (ok, ...args) => add(ok ? "PASS" : "FAIL", ...args);
  const request = (url, options = {}) => fetchLimited(url, { fetcher, timeoutMs, ...options });
  const safely = async (id, label, work) => {
    try { return await work(); }
    catch (error) { add("ERROR", id, label, networkDiagnostic(error), "Retry after resolving the request error; this check is unverified, not passed."); return null; }
  };
  const assets = new Map();
  const deploymentFix = "Deploy the current app with npm run build:vercel and its generated .vercel/output configuration; clear stale Vercel build/output overrides.";

  async function inspectAsset(url, expectedHash, kind) {
    if (!assets.has(url.href)) {
      assets.set(url.href, await safely(`asset:${url.pathname}`, "Deployed asset verification", async () => {
        const asset = await request(url, { maxBytes: 8 * 1024 * 1024 });
        const hash = integrity(asset.bytes);
        const matches = asset.status === 200 && hash === expectedHash;
        check(matches, `asset:${url.pathname}:integrity`, `Deployed ${kind} integrity`, matches ? `${url.pathname}: bytes match SRI.` : `${url.pathname}: HTTP ${asset.status} or bytes do not match SRI.`, "Deploy HTML and unmodified asset bytes atomically; disable CDN JavaScript/CSS rewriting.");
        const validMime = kind === "JavaScript" ? /^\s*(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i : /^\s*text\/css(?:;|$)/i;
        check(validMime.test(asset.headers.get("content-type") || ""), `asset:${url.pathname}:mime`, `Deployed ${kind} content type`, `Expected a ${kind === "JavaScript" ? "JavaScript" : "text/css"} MIME type, not an HTML fallback or plain text.`, deploymentFix);
        check(!hasMarketingTracker(asset.text), `asset:${url.pathname}:trackers`, `No recognized tracker endpoints in the ${kind} asset`, "Scans known integration endpoints/calls, not descriptive privacy-policy names.", "Remove the tracker integration and rebuild; also inspect runtime requests in browser DevTools.");
        return { hash };
      }));
    }
    const asset = assets.get(url.href);
    // A failed request has already produced ERROR, not a false PASS on bytes.
    return !asset || asset.hash === expectedHash;
  }

  async function inspectDocument(response, path, canonical) {
    check(response.status === 200, `site${path}:http`, `${path}: website document`, `HTTP ${response.status}`, "Check deployment protection, redirects and route rewrites.");
    if (response.status !== 200) return;
    const type = response.headers.get("content-type") || "";
    if (!/^text\/html(?:;|$)/i.test(type)) { add("FAIL", `site${path}:html`, `${path}: HTML content type`, "Expected text/html.", deploymentFix); return; }
    const html = response.text.replace(/<!--[\s\S]*?-->/g, "");
    const trackerFound = hasMarketingTracker(html);
    check(!trackerFound, `site${path}:trackers`, `${path}: no recognized marketing tracker integration`, trackerFound ? "Tracking script/endpoint detected in hosted HTML (not merely a tracker name in prose)." : "Checked known Google Ads/Analytics, GoatCounter, Meta, Hotjar, Clarity and Vercel endpoints.", "Deploy the tracker-free app; disable unreviewed host-injected scripts (Speed Insights remains disabled). This static scan is not a full browser network audit.");
    const csp = response.headers.get("content-security-policy");
    let policy = null;
    if (!csp) add("FAIL", `site${path}:csp`, `${path}: enforced HTTP CSP`, "Content-Security-Policy header is missing; meta-only or report-only CSP is not a substitute.", deploymentFix);
    else {
      policy = parsePolicy(csp);
      const hashes = [...(policy.get("script-src") || [])].filter((source) => ![...ANALYTICS_SCRIPTS, ...CONTENTSQUARE_SCRIPTS].includes(source));
      const pinned = hashes.length > 0 && hashes.every((hash) => /^'sha384-[A-Za-z0-9+/]{64}'$/.test(hash));
      const backend = config?.url || (() => {
        try { return new URL([...(policy.get("connect-src") || [])][0]).origin; } catch { return null; }
      })();
      const expected = pinned && backend && backend.startsWith("https://") ? securityHeaders(backend, hashes.map((hash) => hash.slice(1, -1)))["Content-Security-Policy"] : null;
      const matches = !!expected && samePolicy(csp, expected);
      check(matches, `site${path}:csp`, `${path}: generated hash-locked CSP`, matches ? "Directives/source sets match; ordering and whitespace do not matter." : "Policy differs from this app's generated restrictions or configured backend.", deploymentFix);
    }
    for (const [name, expected, label] of [
      ["x-content-type-options", "nosniff", "MIME sniffing protection"],
      ["x-frame-options", "DENY", "anti-framing header"],
      ["referrer-policy", "no-referrer", "referrer suppression"],
      ["cross-origin-opener-policy", "same-origin", "opener isolation"],
      ["cross-origin-resource-policy", "same-origin", "resource isolation"],
    ]) {
      const actual = response.headers.get(name);
      check(actual?.trim().toLowerCase() === expected.toLowerCase(), `site${path}:${name}`, `${path}: ${label}`, actual === null ? `${name} is missing.` : `Expected ${expected}; received ${actual.slice(0, 100)}.`, deploymentFix);
    }
    check(/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") || ""), `site${path}:cache`, `${path}: HTML cache policy`, "Expected Cache-Control: no-store to keep the document and its CSP together.", deploymentFix);
    check(Number(/(?:^|;)\s*max-age\s*=\s*(\d+)/i.exec(response.headers.get("strict-transport-security") || "")?.[1]) >= 31536000, `site${path}:hsts`, `${path}: HTTPS enforced by HSTS`, "Expected a max-age of at least 31536000 seconds.", "Configure HSTS on the HTTPS host; audit subdomains separately before enabling includeSubDomains/preload.");
    const metas = [...html.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map((match) => attributes(match[1])).filter((attrs) => attrs["http-equiv"]?.toLowerCase() === "content-security-policy");
    if (policy) {
      const expectedMeta = [...policy].filter(([key]) => !["frame-ancestors", "upgrade-insecure-requests"].includes(key)).map(([key, values]) => `${key}${values.size ? ` ${[...values].join(" ")}` : ""}`).join("; ");
      check(metas.length === 1 && samePolicy(metas[0].content || "", expectedMeta), `site${path}:meta`, `${path}: meta CSP agrees with the HTTP policy`, "Compared parsed directives, not HTML quote style or attribute order.", deploymentFix);
    } else add("SKIP", `site${path}:meta`, `${path}: meta/header agreement`, "No enforced HTTP policy to compare; see the CSP failure above.");

    const scripts = [...html.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi)];
    let valid = scripts.length > 0 && scripts.length === (html.match(/<script\b/gi) ?? []).length;
    const documentHashes = new Set();
    for (const [, raw, inline] of scripts) {
      const attrs = attributes(raw);
      let url;
      try { url = new URL(attrs.src, response.url); } catch { valid = false; continue; }
      if (!attrs.src || attrs.type !== "module" || url.origin !== canonical || url.username || url.password || url.search || url.hash || !/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(url.pathname) || !/^sha384-[A-Za-z0-9+/]{64}$/.test(attrs.integrity || "") || inline.trim()) { valid = false; continue; }
      documentHashes.add(`'${attrs.integrity}'`);
      if (!await inspectAsset(url, attrs.integrity, "JavaScript")) valid = false;
    }
    check(valid, `site${path}:scripts`, `${path}: same-origin, external, integrity-pinned entry scripts`, valid ? "All entry script tags carry SHA-384 integrity." : "Missing scripts/SRI, inline code, or an unexpected script source was found.", deploymentFix);
    if (policy && valid) check(policy.get("script-src")?.size === documentHashes.size + ANALYTICS_SCRIPTS.length + CONTENTSQUARE_SCRIPTS.length && [...documentHashes].every((hash) => policy.get("script-src").has(hash)), `site${path}:script-policy`, `${path}: CSP hashes match the actual entry scripts`, "The header must authorize the document hashes plus the reviewed Vercel Analytics and Contentsquare sources.", deploymentFix);

    const styles = [...html.matchAll(/<link\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map((match) => attributes(match[1])).filter((attrs) => attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet"));
    let validStyles = true;
    for (const attrs of styles) {
      let url;
      try { url = new URL(attrs.href, response.url); } catch { validStyles = false; continue; }
      if (!attrs.href || url.origin !== canonical || url.username || url.password || url.search || url.hash || !/^\/assets\/[A-Za-z0-9_.-]+\.css$/.test(url.pathname) || !/^sha384-[A-Za-z0-9+/]{64}$/.test(attrs.integrity || "")) { validStyles = false; continue; }
      if (!await inspectAsset(url, attrs.integrity, "CSS")) validStyles = false;
    }
    check(validStyles, `site${path}:styles`, `${path}: same-origin, integrity-pinned stylesheets`, `${styles.length} external stylesheet(s) declared; all must carry matching SHA-384 integrity.`, deploymentFix);
  }

  const home = await safely("site:request", "Website request", () => request(origin, { followRedirects: true, maxBytes: 2 * 1024 * 1024 }));
  let canonical = origin;
  if (home) {
    canonical = new URL(home.url).origin;
    if (home.redirected) add("WARN", "site:canonical", "Website redirect followed", `Checking final HTTPS origin ${canonical}; use it as PRUNE_SITE_URL.`, "Prefer the canonical origin in links and AI CORS configuration.");
    await safely("site/:inspection", "/: document inspection", () => inspectDocument(home, "/", canonical));
    for (const path of ["/download", "/download/", "/login", "/login/", "/index.html"]) {
      await safely(`site${path}:inspection`, `${path}: document inspection`, async () => {
        const page = await request(`${canonical}${path}`, { followRedirects: true, lockedOrigin: canonical, maxBytes: 2 * 1024 * 1024 });
        await inspectDocument(page, path, canonical);
      });
    }
  } else add("SKIP", "site:dependent", "Website headers/content/assets", "Website request failed; dependent checks were not run.");

  if (websiteOnly) add("SKIP", "backend:disabled", "Supabase and AI checks", "Explicit --website-only mode; this is not a full release check.");
  else if (!config || configError) {
    add("ERROR", "backend:config", "Public backend configuration", "Missing or unsafe VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.", "Set matching production public values in .env.local or your shell; never supply a service-role, sb_secret_ or provider key.");
    add("SKIP", "backend:dependent", "Backend authentication/permissions/AI", "Cannot verify without valid public configuration.");
  } else {
    const headers = { apikey: config.publicKey, "Content-Type": "application/json" };
    const auth = await safely("auth:request", "Auth public settings", async () => {
      const response = await request(`${config.url}/auth/v1/settings`, { headers });
      if (response.status !== 200) throw new ProbeError(`Auth settings returned HTTP ${response.status}; check the public key, project URL and service availability.`);
      const settings = jsonBody(response);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new ProbeError("Auth settings response has an unexpected shape.");
      return settings;
    });
    if (!auth) add("SKIP", "auth:dependent", "Backend permission and AI checks", "Public-key/service validation failed; avoiding misleading cascaded results.");
    else {
      for (const [id, value, expected, label] of [
        ["email", auth.external?.email, true, "Email authentication enabled"],
        ["anonymous", auth.external?.anonymous_users, false, "Anonymous sign-in disabled"],
        ["confirmation", auth.mailer_autoconfirm, false, "Email confirmation enabled"],
      ]) {
        if (typeof value !== "boolean") add("ERROR", `auth:${id}`, label, "Setting was absent/unrecognized in the public response; verify in the Supabase dashboard.");
        else check(value === expected, `auth:${id}`, label, `Expected ${expected}; observed ${value}.`, "Review the hosted Supabase Authentication settings.");
      }
      if (typeof auth.disable_signup !== "boolean") add("ERROR", "auth:signup", "Signup policy", "Public signup setting could not be verified.");
      else add(auth.disable_signup ? "PASS" : requireInviteOnly ? "FAIL" : "WARN", "auth:signup", "Signup policy", auth.disable_signup ? "New public registrations are disabled." : "Public registrations are enabled. This is a product/abuse-control choice, not proof of cross-account data exposure.", auth.disable_signup ? "" : "For a closed beta, provision tester accounts and disable public signup. Use --require-invite-only to make this a release failure.");
      for (const table of TABLES) await safely(`db:${table}:request`, `Anonymous table check: ${table}`, async () => {
        const response = await request(`${config.url}/rest/v1/${table}?select=*&limit=0`, { headers });
        const body = jsonBody(response);
        check([401, 403].includes(response.status) && body?.code === "42501", `db:${table}`, `Anonymous SELECT denied: ${table}`, `${codeDetail(response, body)}; requested zero rows.`, "Expected SQL permission error 42501. Check table existence/grants; a missing table or generic invalid JWT is not a successful isolation check.");
      });
      await safely("planner:request", "Anonymous planner RPC", async () => {
        const response = await request(`${config.url}/rest/v1/rpc/planner_call`, { headers, method: "POST", body: JSON.stringify({ p_action: "dashboard", p_args: {}, p_timezone: "UTC" }) });
        const body = jsonBody(response);
        check([401, 403].includes(response.status) && ["42501", "PT401"].includes(body?.code), "planner:anonymous", "Planner rejects anonymous access", codeDetail(response, body), "Review planner RPC grants and its server-side authentication guard.");
      });
      if (skipAi) add("SKIP", "ai:disabled", "AI authentication and CORS", "Explicit --skip-ai mode; optional AI was not verified.");
      else {
        await safely("ai:request", "Anonymous AI request", async () => {
          const response = await request(`${config.url}/functions/v1/weekly-review`, { headers, method: "POST", body: JSON.stringify({ timezone: "UTC" }) });
          check(response.status === 401, "ai:anonymous", "AI rejects missing user tokens", `HTTP ${response.status}; no user token or review activity was supplied.`, "Verify the deployed Edge Function rejects unauthenticated calls before loading activity or reserving provider usage.");
        });
        for (const allowed of [true, false]) await safely(`ai:cors:${allowed}:request`, "AI CORS preflight", async () => {
          const origin = allowed ? canonical : "https://security-fixture.invalid";
          const response = await request(`${config.url}/functions/v1/weekly-review`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,apikey,content-type" } });
          const actual = response.headers.get("access-control-allow-origin");
          check(allowed ? response.status === 204 && actual === origin : response.status === 403 && actual === null, `ai:cors:${allowed}`, allowed ? "AI allows the canonical website origin" : "AI rejects an unapproved origin", `HTTP ${response.status}; allow-origin header ${actual === null ? "is absent" : actual === origin ? "matches the request" : "does not match the request"}; ${allowed ? `expected HTTP 204 and ${origin}` : "expected HTTP 403 with no allow-origin header"}.`, "Check the deployed ALLOWED_ORIGINS allowlist, preserving required desktop origins. CORS is not authentication.");
        });
      }
    }
  }
  return { site: canonical, scope: { websiteOnly, skipAi, requireInviteOnly }, results, ...summarize(results), limitations: "Does not prove authenticated cross-account RLS, SMTP/OTP delivery or limits, migration parity, hosted load capacity, backups, retention, admin security or absence of vulnerabilities. Complete PRODUCTION_READINESS.md." };
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs({ args, options: { url: { type: "string" }, "require-invite-only": { type: "boolean" }, "website-only": { type: "boolean" }, "skip-ai": { type: "boolean" }, "timeout-ms": { type: "string", default: "15000" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }).values;
  } catch { console.error("Invalid arguments. Run npm run check:production -- --help."); return 2; }
  if (options.help) { console.log(HELP); return 0; }
  const timeoutMs = Number(options["timeout-ms"]);
  const site = options.url || process.env.PRUNE_SITE_URL || "https://www.prune.win";
  let config = null, configError = null;
  try {
    websiteOrigin(site);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error("--timeout-ms must be an integer between 100 and 120000.");
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ exitCode: 2, error: error.message }));
    else console.error(`Configuration error: ${error.message}`);
    return 2;
  }
  try {
    const env = loadEnv("production", process.cwd(), "VITE_SUPABASE_");
    if (!options["website-only"] || env.VITE_SUPABASE_URL || env.VITE_SUPABASE_ANON_KEY) config = publicConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  } catch { configError = true; }
  if (!options.json) console.log(`Production checks: ${site}\nRead-only public probes; no credentials or response bodies will be printed.\n`);
  const report = await runProductionChecks({ site, config, configError, timeoutMs, requireInviteOnly: !!options["require-invite-only"], websiteOnly: !!options["website-only"], skipAi: !!options["skip-ai"] }, options.json ? undefined : (item) => {
    console.log(`[${item.status}] ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nSummary: ${Object.entries(report.counts).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(", ")}.`);
    console.log(report.exitCode === 2 ? "INCOMPLETE: one or more checks could not be verified. See ERROR details." : report.exitCode === 1 ? "NOT READY: confirmed failures remain. See FAIL details." : "No failures in the selected automated checks. Warnings/skips and manual release gates still need review.");
    const fixes = [...new Set(report.results.flatMap((item) => item.fix ? [item.fix] : []))];
    if (fixes.length) console.log(`\nNext steps:\n${fixes.map((fix) => `- ${fix}`).join("\n")}`);
    console.log(`\n${report.limitations}`);
  }
  return report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error("Checker could not finish. No response bodies/credentials were printed. Run the checker tests and inspect local configuration."); process.exitCode = 2; }
}
