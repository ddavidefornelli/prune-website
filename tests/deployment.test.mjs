import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRelease } from "../scripts/build-release.mjs";
import { buildVercel } from "../scripts/build-vercel.ts";
import { checkDeployment } from "../scripts/check-deployment.mjs";
import { hardenHtml } from "../scripts/security-policy.ts";

const paths = ["/", "/download", "/download/", "/login", "/login/", "/index.html"];
const origin = "https://deployment-fixture.supabase.co";
const script = "console.log('trusted application');";
const css = "body { color: white; }";
const assets = new Map([["assets/app.js", script], ["assets/app.css", css]]);
const entry = '<html><head><script type="module" crossorigin src="/assets/app.js"></script><link rel="stylesheet" crossorigin href="/assets/app.css"></head><body></body></html>';

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "prune-deployment-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, "dist");
  const destination = join(temp, "output");
  mkdirSync(join(source, "assets"), { recursive: true });
  const built = hardenHtml(entry, assets, origin);
  for (const [name, bytes] of assets) writeFileSync(join(source, name), bytes);
  writeFileSync(join(source, "index.html"), built.html);
  writeFileSync(join(source, "security-headers.json"), JSON.stringify(built.headers));
  buildVercel(source, destination);
  return { source, destination, built };
}
function changeConfig(destination, update) {
  const file = join(destination, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  update(config);
  writeFileSync(file, JSON.stringify(config));
}
const result = (report, id) => report.results.find((item) => item.id === id);

test("packaged routes, enforced headers, meta and actual JS/CSS bytes pass without external requests", async (t) => {
  const { destination } = fixture(t);
  const report = await checkDeployment(destination);
  assert.equal(report.exitCode, 0);
  for (const path of paths) {
    for (const id of ["http", "csp", "meta", "cache", "scripts", "styles", "script-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "hsts"]) {
      assert.equal(result(report, `site${path}:${id}`).status, "PASS", `${path}: ${id}`);
    }
  }
  for (const ext of ["js", "css"]) assert.equal(result(report, `asset:/assets/app.${ext}:integrity`).status, "PASS");
  assert.equal(result(report, "backend:disabled").status, "SKIP");
});

for (const header of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "Strict-Transport-Security"]) {
  test(`packaged deployment fails when the HTTP ${header} header is missing`, async (t) => {
    const { destination } = fixture(t);
    changeConfig(destination, (config) => delete config.routes[0].headers[header]);
    const report = await checkDeployment(destination);
    assert.equal(report.exitCode, 1);
    const id = header === "Content-Security-Policy" ? "csp" : header === "Strict-Transport-Security" ? "hsts" : header.toLowerCase();
    for (const path of paths) assert.equal(result(report, `site${path}:${id}`).status, "FAIL");
    if (id === "csp") assert.equal(result(report, "site/:meta").status, "SKIP", "meta must never substitute for an HTTP policy");
  });
}

test("no-store and the document rewrite are required on the trailing-slash download route too", async (t) => {
  const { destination } = fixture(t);
  changeConfig(destination, (config) => { config.routes.find((route) => route.headers?.["Cache-Control"]).src = "^/(?:index\\.html|download)?$"; });
  let report = await checkDeployment(destination);
  assert.equal(result(report, "site/download/:cache").status, "FAIL");
  assert.equal(result(report, "site/:cache").status, "PASS");
  changeConfig(destination, (config) => { config.routes = config.routes.filter((route) => !route.dest); });
  report = await checkDeployment(destination);
  assert.equal(result(report, "site/download:http").status, "FAIL");
  assert.equal(result(report, "site/download/:http").status, "FAIL");
});

for (const extension of ["js", "css"]) {
  test(`post-packaging ${extension} changes fail the final byte verification`, async (t) => {
    const { destination } = fixture(t);
    writeFileSync(join(destination, `static/assets/app.${extension}`), "/* modified after packaging */");
    const report = await checkDeployment(destination);
    assert.equal(report.exitCode, 1);
    assert.equal(result(report, `asset:/assets/app.${extension}:integrity`).status, "FAIL");
  });
}

test("unrecognized route semantics, public metadata and symlinks are not silently accepted", async (t) => {
  const { source, destination } = fixture(t);
  changeConfig(destination, (config) => { config.routes[0].status = 302; });
  await assert.rejects(() => checkDeployment(destination), /Unsupported deployment route/);
  buildVercel(source, destination);
  writeFileSync(join(destination, "static/security-headers.json"), "{}");
  await assert.rejects(() => checkDeployment(destination), /metadata/);
  rmSync(join(destination, "static/security-headers.json"));
  symlinkSync(join(source, "assets/app.js"), join(destination, "static/alias.js"));
  await assert.rejects(() => checkDeployment(destination), /symbolic links/);
});

test("tracking in a copied public script fails even when it is absent from the HTML", async (t) => {
  const { source, destination } = fixture(t);
  writeFileSync(join(source, "tracking.js"), 'fetch("https://gc.zgo.at/count");');
  await assert.rejects(() => buildRelease({ source, destination, runBuild: () => 0, onResult: () => {} }), /tracker/);
  assert.equal(existsSync(destination), false, "a rejected package must not remain deployable");
});

test("release build removes an older prebuilt deployment before compilation and on every failure", async (t) => {
  const { source, destination } = fixture(t);
  await assert.rejects(() => buildRelease({ source, destination, runBuild: () => {
    assert.equal(existsSync(destination), false, "stale output must be gone before compilation starts");
    return 1;
  }, onResult: () => {} }), /compilation failed/);
  assert.equal(existsSync(destination), false);

  buildVercel(source, destination);
  writeFileSync(join(source, "assets/app.css"), "body { display: none; }");
  await assert.rejects(() => buildRelease({ source, destination, runBuild: () => 0, onResult: () => {} }), /integrity/);
  assert.equal(existsSync(destination), false);
});

test("a successful release keeps only the verified deployable", async (t) => {
  const { source, destination } = fixture(t);
  const saved = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_ANON_KEY };
  process.env.VITE_SUPABASE_URL = "https://fixture.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "sb_publishable_fixture";
  t.after(() => {
    for (const [name, value] of [["VITE_SUPABASE_URL", saved.url], ["VITE_SUPABASE_ANON_KEY", saved.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const report = await buildRelease({ source, destination, runBuild: () => 0, onResult: () => {} });
  assert.equal(report.exitCode, 0);
  assert.equal(existsSync(join(destination, "config.json")), true);
  assert.equal(existsSync(join(destination, "static/security-headers.json")), false);
  // The error relay is packaged as an Edge Function with only public config inlined.
  const fn = join(destination, "functions/api/error-log.func");
  assert.deepEqual(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8")), { runtime: "edge", entrypoint: "index.js" });
  const bundle = readFileSync(join(fn, "index.js"), "utf8");
  assert.ok(bundle.includes("https://fixture.supabase.co") && bundle.includes("sb_publishable_fixture"));
});
